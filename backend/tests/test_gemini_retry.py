"""Retry + fallback for Gemini calls, with a fake client (no network, no database).

Run from the project root:  backend\\.venv\\Scripts\\python -m unittest discover -s backend/tests -v
"""
import logging
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx  # noqa: E402
from flask import Flask  # noqa: E402
from google import genai  # noqa: E402
from google.genai import errors  # noqa: E402

import gemini_retry  # noqa: E402
import photo_check  # noqa: E402

PRIMARY, FALLBACK = "gemini-primary", "gemini-fallback"


def overloaded():
    return errors.ServerError(503, {"error": {"code": 503, "message": "The model is overloaded.", "status": "UNAVAILABLE"}})


def rate_limited(retry_after=None):
    details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": f"{retry_after}s"}] if retry_after else []
    return errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED", "details": details}})


def client_error(code):
    return errors.ClientError(code, {"error": {"code": code, "message": "nope", "status": "X"}})


class FakeTime:
    """Clock that only moves when we sleep or a call 'takes' time."""
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s

    def clock(self):
        return self.now


class Script:
    """call(model, timeout_ms): pops the next outcome for that model (an exception is raised)."""
    def __init__(self, fake_time, outcomes, duration=0.5):
        self.t, self.outcomes, self.duration, self.calls = fake_time, {k: list(v) for k, v in outcomes.items()}, duration, []

    def __call__(self, model, timeout_ms):
        self.calls.append((model, timeout_ms))
        duration = self.duration.get(model, 0.5) if isinstance(self.duration, dict) else self.duration
        if duration > timeout_ms / 1000:          # like the real HTTP client: cut off at the timeout
            self.t.now += timeout_ms / 1000
            raise httpx.ReadTimeout("timed out")
        self.t.now += duration
        out = self.outcomes[model].pop(0)
        if isinstance(out, BaseException):
            raise out
        return out


class Base(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.app.logger.setLevel(logging.CRITICAL)      # quiet; assertLogs still sees records
        self.t = FakeTime()
        for name, fn in (("_sleep", self.t.sleep), ("_clock", self.t.clock)):
            p = mock.patch.object(gemini_retry, name, fn)
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.ctx.pop()

    def run_gen(self, outcomes, models=(PRIMARY, FALLBACK), budget=50, duration=0.5):
        script = Script(self.t, outcomes, duration)
        try:
            result = gemini_retry.generate(script, list(models), budget_s=budget, label="Test", max_timeout_ms=40_000)
        except Exception as exc:  # noqa: BLE001
            result = exc
        return result, script


class RetryHelperTests(Base):
    def test_success_first_time_no_waiting(self):
        (resp, used), script = self.run_gen({PRIMARY: ["ok"]})
        self.assertEqual((resp, used), ("ok", PRIMARY))
        self.assertEqual(self.t.sleeps, [])

    def test_503_retried_with_backoff_then_succeeds(self):
        (resp, used), script = self.run_gen({PRIMARY: [overloaded(), overloaded(), "ok"]})
        self.assertEqual((resp, used), ("ok", PRIMARY))
        self.assertEqual(self.t.sleeps, [1, 2])
        self.assertEqual([m for m, _ in script.calls], [PRIMARY] * 3)

    def test_429_retried_too(self):
        (resp, used), _ = self.run_gen({PRIMARY: [rate_limited(), "ok"]})
        self.assertEqual(used, PRIMARY)
        self.assertEqual(self.t.sleeps, [1])

    def test_falls_back_after_three_retries(self):
        (resp, used), script = self.run_gen({PRIMARY: [overloaded()] * 4, FALLBACK: ["fallback ok"]})
        self.assertEqual((resp, used), ("fallback ok", FALLBACK))
        self.assertEqual(self.t.sleeps, [1, 2, 4])
        self.assertEqual([m for m, _ in script.calls], [PRIMARY] * 4 + [FALLBACK])

    def test_fallback_is_retried_as_well(self):
        (resp, used), _ = self.run_gen({PRIMARY: [overloaded()] * 4, FALLBACK: [overloaded(), "ok"]})
        self.assertEqual(used, FALLBACK)
        self.assertEqual(self.t.sleeps, [1, 2, 4, 1])

    def test_everything_fails_raises_last_error(self):
        exc, script = self.run_gen({PRIMARY: [overloaded()] * 4, FALLBACK: [overloaded()] * 4})
        self.assertIsInstance(exc, errors.ServerError)
        self.assertEqual(exc.code, 503)
        self.assertEqual(len(script.calls), 8)
        self.assertEqual(self.t.sleeps, [1, 2, 4, 1, 2, 4])

    def test_long_rate_limit_skips_to_fallback_without_waiting(self):
        (resp, used), script = self.run_gen({PRIMARY: [rate_limited(retry_after=37)], FALLBACK: ["ok"]})
        self.assertEqual(used, FALLBACK)
        self.assertEqual(self.t.sleeps, [])

    def test_short_rate_limit_hint_is_respected(self):
        (resp, used), _ = self.run_gen({PRIMARY: [rate_limited(retry_after=3), "ok"]})
        self.assertEqual(used, PRIMARY)
        self.assertEqual(self.t.sleeps, [3])

    def test_missing_primary_model_falls_back_immediately(self):
        (resp, used), script = self.run_gen({PRIMARY: [client_error(404)], FALLBACK: ["ok"]})
        self.assertEqual(used, FALLBACK)
        self.assertEqual(self.t.sleeps, [])

    def test_other_client_errors_are_not_retried(self):
        for code in (400, 401, 403):
            self.t.sleeps.clear()
            exc, script = self.run_gen({PRIMARY: [client_error(code)], FALLBACK: ["unused"]})
            self.assertEqual(exc.code, code)
            self.assertEqual(len(script.calls), 1)
            self.assertEqual(self.t.sleeps, [])

    def test_client_timeout_skips_to_fallback_without_retry(self):
        (resp, used), script = self.run_gen({PRIMARY: [httpx.ReadTimeout("slow")], FALLBACK: ["ok"]})
        self.assertEqual(used, FALLBACK)
        self.assertEqual([m for m, _ in script.calls], [PRIMARY, FALLBACK])
        self.assertEqual(self.t.sleeps, [])

    def test_client_timeout_on_last_model_is_raised(self):
        exc, script = self.run_gen({PRIMARY: [httpx.ReadTimeout("slow")]}, models=(PRIMARY,))
        self.assertIsInstance(exc, httpx.ReadTimeout)
        self.assertEqual(len(script.calls), 1)

    def test_network_errors_are_raised_at_once(self):
        exc, script = self.run_gen({PRIMARY: [httpx.ConnectError("dns")], FALLBACK: ["unused"]})
        self.assertIsInstance(exc, httpx.ConnectError)
        self.assertEqual(len(script.calls), 1)

    def test_504_deadline_skips_to_fallback_without_waiting(self):
        deadline = errors.ServerError(504, {"error": {"code": 504, "message": "Deadline expired", "status": "DEADLINE_EXCEEDED"}})
        (resp, used), script = self.run_gen({PRIMARY: [deadline], FALLBACK: ["ok"]})
        self.assertEqual(used, FALLBACK)
        self.assertEqual(self.t.sleeps, [])

    def test_time_budget_caps_attempts_and_per_call_timeout(self):
        # each failing call takes 12 s: a 50 s budget has no room for all 8 attempts
        exc, script = self.run_gen({PRIMARY: [overloaded()] * 4, FALLBACK: [overloaded()] * 4}, duration=12)
        self.assertIsInstance(exc, errors.ServerError)
        self.assertLessEqual(self.t.now, 50 + 0.001, "never runs past the budget")
        self.assertLess(len(script.calls), 8)
        self.assertTrue(all(ms <= 40_000 for _, ms in script.calls))
        self.assertIn(FALLBACK, [m for m, _ in script.calls], "the fallback is always reached")

    def test_no_request_ever_has_a_deadline_under_10s(self):
        for duration in (0.5, 3, 7, 12, 20, 30):
            for budget in (42, 50):
                self.t.now, self.t.sleeps = 0.0, []
                _, script = self.run_gen({PRIMARY: [overloaded()] * 4, FALLBACK: [overloaded()] * 4},
                                         budget=budget, duration=duration)
                short = [ms for _, ms in script.calls if ms < 10_000]
                self.assertEqual(short, [], f"duration={duration} budget={budget}: {script.calls}")

    def test_fallback_always_gets_at_least_15s(self):
        # primary requests that each hang until their deadline (the slow-overload case)
        for budget in (42, 50):
            for max_ms in (25_000, 40_000):
                self.t.now, self.t.sleeps = 0.0, []
                script = Script(self.t, {PRIMARY: ["unused"] * 4, FALLBACK: ["ok"]}, duration={PRIMARY: 999, FALLBACK: 2})
                resp, used = gemini_retry.generate(script, [PRIMARY, FALLBACK], budget_s=budget, label="T", max_timeout_ms=max_ms)
                fb = [ms for m, ms in script.calls if m == FALLBACK]
                self.assertEqual(used, FALLBACK)
                self.assertGreaterEqual(fb[0], 15_000, f"budget={budget} max={max_ms}: {script.calls}")

    def test_fallback_reserve_holds_while_primary_retries(self):
        # slow 503s on the primary: its retries stop in time to leave the fallback 15 s
        for duration in (5, 9, 12, 16):
            self.t.now, self.t.sleeps = 0.0, []
            script = Script(self.t, {PRIMARY: [overloaded()] * 4, FALLBACK: ["ok"]}, duration=duration)
            gemini_retry.generate(script, [PRIMARY, FALLBACK], budget_s=50, label="T", max_timeout_ms=40_000)
            self.assertGreaterEqual(script.calls[-1][1], 15_000, f"duration={duration}: {script.calls}")

    def test_same_or_blank_fallback_means_single_model(self):
        self.assertEqual(gemini_retry.models("a", "a"), ["a"])
        self.assertEqual(gemini_retry.models("a", ""), ["a"])
        self.assertEqual(gemini_retry.models("a", " b "), ["a", "b"])
        exc, script = self.run_gen({PRIMARY: [overloaded()] * 4}, models=(PRIMARY,))
        self.assertEqual(len(script.calls), 4)


# ---------------------------------------------------------------- photo check end-to-end with a fake genai.Client

def gemini_response(text, model_version):
    return types.SimpleNamespace(text=text, model_version=model_version, prompt_feedback=None,
                                 candidates=[types.SimpleNamespace(finish_reason=types.SimpleNamespace(name="STOP"))])


class PhotoCheckTests(Base):
    def setUp(self):
        super().setUp()
        self.app.config.update(GEMINI_API_KEY="test", PHOTO_CHECK_MODEL=PRIMARY, PHOTO_CHECK_FALLBACK_MODEL=FALLBACK)
        p = mock.patch.object(photo_check, "_download", lambda url: (b"\xff\xd8jpeg", "image/jpeg"))
        p.start()
        self.addCleanup(p.stop)
        self.material = types.SimpleNamespace(material_name="seal kit", part_number="SK-40", quantity=1, unit="set")

    def fake_client(self, outcomes):
        calls = []
        queues = {k: list(v) for k, v in outcomes.items()}

        class Models:
            def generate_content(self, model, contents, config):
                calls.append(model)
                out = queues[model].pop(0)
                if isinstance(out, BaseException):
                    raise out
                return out

        class Client:
            def __init__(self, **kw):
                self.models = Models()

        p = mock.patch.object(genai, "Client", Client)
        p.start()
        self.addCleanup(p.stop)
        return calls

    def test_overloaded_primary_falls_back_and_succeeds(self):
        ok = gemini_response('{"verdict": "consistent", "visible_item": "a boxed seal kit", "reason": "label reads seal kit"}',
                             FALLBACK + "-001")
        calls = self.fake_client({PRIMARY: [overloaded()] * 4, FALLBACK: [ok]})
        with self.assertLogs(self.app.logger, "WARNING"):
            result = photo_check.check("https://example/photo.jpg", self.material)
        self.assertEqual(result["ai_status"], "consistent")
        self.assertEqual(result["ai_model"], FALLBACK + "-001", "records which model actually answered")
        self.assertEqual(calls, [PRIMARY] * 4 + [FALLBACK])
        self.assertEqual(self.t.sleeps, [1, 2, 4])

    def test_every_attempt_overloaded_gives_friendly_error(self):
        calls = self.fake_client({PRIMARY: [overloaded()] * 4, FALLBACK: [overloaded()] * 4})
        with self.assertLogs(self.app.logger, "WARNING"):
            result = photo_check.check("https://example/photo.jpg", self.material)
        self.assertEqual(result["ai_status"], "error")
        self.assertIn("overloaded", result["ai_note"])
        self.assertIn("Review the photo yourself", result["ai_note"])
        self.assertEqual(len(calls), 8)

    def test_rate_limit_everywhere_gives_rate_limit_message(self):
        self.fake_client({PRIMARY: [rate_limited()] * 4, FALLBACK: [rate_limited()] * 4})
        with self.assertLogs(self.app.logger, "WARNING"):
            result = photo_check.check("https://example/photo.jpg", self.material)
        self.assertEqual(result["ai_status"], "error")
        self.assertIn("try again in a minute", result["ai_note"])


if __name__ == "__main__":
    unittest.main()
