"""Retry + model fallback for Gemini calls (AI assistant and photo check).

Gemini answers 503 when a model is overloaded and 429 when a rate limit is
hit; both usually clear within seconds, and a different model has its own
capacity and free-tier quota. So each call:

1. tries the primary model; on 429/500/503 waits 1 s, 2 s, 4 s between up to
   3 retries (a 429 that asks for a longer wait - e.g. the free tier's daily
   quota - goes straight to 2);
2. then does the same with the fallback model. It goes to the fallback at
   once on a 504 (the model couldn't answer within the deadline - retrying
   it with less time left can't do better) and if the primary model doesn't
   exist (a retired or mistyped name);
3. then re-raises the last error, which the caller turns into its usual
   friendly message.

Deadlines. The SDK sends each request's timeout to Google as X-Server-Timeout,
so it is the *server's* deadline too: a request sent with 3 s left comes back
as 504 DEADLINE_EXCEEDED however healthy the model is. Hence, inside the
overall budget (the request runs in a gunicorn worker with a 60 s timeout):
- no request is ever sent with a deadline under MIN_REQUEST_S;
- while a fallback model is still to come, FALLBACK_RESERVE_S of the budget
  is held back for it: the primary model's requests and waits must fit in
  what's left before that reserve, so the fallback always gets at least
  that long;
- an attempt or wait that wouldn't fit is skipped (moving on to the
  fallback, or giving up with the last error).
A client-side timeout also moves on to the fallback (not retried on the same
model); other network errors are raised at once - they'd hit any model.
"""
import re
import time

from flask import current_app

RETRYABLE = {429, 500, 503}      # same model again after a short wait
SKIP_TO_FALLBACK = {404, 504}    # no point asking this model again
BACKOFF = (1, 2, 4)              # seconds before retry 1, 2, 3
MIN_REQUEST_S = 10               # never send a request with a shorter deadline than this
FALLBACK_RESERVE_S = 15          # budget held back for the fallback model

_sleep, _clock = time.sleep, time.monotonic      # replaced in tests


def models(primary, fallback):
    """[primary, fallback] without blanks or duplicates."""
    out = []
    for m in (primary, fallback):
        m = (m or "").strip()
        if m and m not in out:
            out.append(m)
    return out


def _suggested_wait(exc):
    """Seconds the API asked us to wait (RetryInfo on a 429), or None."""
    try:
        for d in exc.details["error"]["details"]:
            m = re.fullmatch(r"(\d+(?:\.\d+)?)s", str(d.get("retryDelay", "")))
            if m:
                return float(m.group(1))
    except (AttributeError, KeyError, TypeError):
        pass
    return None


def _is_timeout(exc):
    return isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower()


def generate(call, model_names, *, budget_s, label, max_timeout_ms):
    """Run call(model, timeout_ms) -> response with retries and fallback.
    Returns (response, model_used). Raises the last error when every attempt fails."""
    from google.genai import errors

    start = _clock()
    last = None
    for index, model in enumerate(model_names):
        has_next = index + 1 < len(model_names)
        reserve = FALLBACK_RESERVE_S if has_next else 0
        # Time this model may use: the budget left, minus what's held back for the fallback.
        available = lambda: budget_s - (_clock() - start) - reserve  # noqa: E731
        for attempt in range(len(BACKOFF) + 1):
            if available() < MIN_REQUEST_S:
                current_app.logger.warning("%s: no time for another %r request (%.0fs left for it)",
                                           label, model, max(available(), 0))
                break
            try:
                return call(model, int(min(max_timeout_ms, available() * 1000))), model
            except Exception as exc:  # noqa: BLE001 - sorted below
                if not isinstance(exc, errors.APIError):
                    if not _is_timeout(exc):
                        raise
                    last = exc
                    current_app.logger.warning("%s: %r timed out (%s)", label, model, type(exc).__name__)
                    break
                last = exc
                if exc.code in SKIP_TO_FALLBACK:
                    current_app.logger.warning("%s: %r returned %s%s", label, model, exc.code,
                                               " (model not found)" if exc.code == 404 else " (deadline exceeded)")
                    break
                if exc.code not in RETRYABLE:
                    raise
                if attempt == len(BACKOFF):
                    current_app.logger.warning("%s: %r still failing (%s) after %d retries", label, model, exc.code, attempt)
                    break
                asked = _suggested_wait(exc)
                if asked is not None and asked > BACKOFF[-1]:
                    current_app.logger.warning("%s: %r rate-limited for %.0fs - not waiting", label, model, asked)
                    break
                wait = max(BACKOFF[attempt], asked or 0)
                if available() - wait < MIN_REQUEST_S:
                    break
                current_app.logger.warning("%s: %r returned %s - retry %d in %ss", label, model, exc.code, attempt + 1, wait)
                _sleep(wait)
        if has_next:
            current_app.logger.warning("%s: falling back from %r to %r", label, model, model_names[index + 1])
    raise last or TimeoutError(f"{label}: no time left for a request")
