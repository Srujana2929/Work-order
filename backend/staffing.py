"""Staffing insight: a rule-based estimate (not a trained model) of whether
the current technician headcount can keep up with the open workload.

The rule, in plain terms:

1. Look back over the last 4 weeks. For each day, count the work orders that
   were open at the end of that day (raised, not yet completed) and the
   active technicians whose accounts existed then. The average of
   open / technicians across those days is the team's usual load.
2. A technician is assumed to be able to carry at least MIN_LOAD open work
   orders, so a quiet month doesn't make a normal workload look like a crisis.
   The benchmark is max(usual load, MIN_LOAD).
3. Compare today's load (open now / active technicians now) with the
   benchmark. Within TOLERANCE above it counts as sufficient. Otherwise the
   suggestion is ceil(open now / benchmark) technicians, i.e. the headcount
   that brings each technician back down to the benchmark.

Known limits (also shown in the UI): deleted work orders and deactivated
technicians aren't in the history (we don't store when someone was
deactivated); work sent back for rework only counts from its latest
completion; all work orders count the same regardless of size or priority.
"""
import math
from datetime import datetime, time, timedelta

WINDOW_DAYS = 28
MIN_LOAD = 3.0          # open work orders one technician can reasonably carry
TOLERANCE = 0.10        # up to 10% above the benchmark still counts as sufficient
MIN_HISTORY_DAYS = 7    # fewer days of data than this -> "not enough history"


def _round(x):
    return None if x is None else round(x, 2)


def estimate(work_orders, technicians, current_open, now, first_created=None):
    """work_orders: iterable of (created_at, completed_at) for every work order
    that could have been open in the window. technicians: iterable of
    created_at for each active technician. current_open: open work orders now.
    first_created: when the first work order ever was raised (days before
    that aren't history, the system just wasn't in use). Returns a JSON-ready dict."""
    work_orders = list(work_orders)
    tech_created = sorted(technicians)
    headcount = len(tech_created)
    today = datetime.combine(now.date(), time.min)

    # Sample points: the end of each of the last 28 full days, oldest first.
    first_activity = first_created or min((c for c, _ in work_orders), default=None)
    samples = []
    for back in range(WINDOW_DAYS, 0, -1):
        t = today - timedelta(days=back - 1)          # midnight = end of the previous day
        if first_activity is None or t <= first_activity:
            continue                                   # before the system had any work orders
        open_count = sum(1 for created, completed in work_orders
                         if created < t and (completed is None or completed >= t))
        techs = sum(1 for c in tech_created if c < t)
        samples.append({"date": (t - timedelta(days=1)).date().isoformat(),
                        "open": open_count, "technicians": techs})

    usable = [s for s in samples if s["technicians"] > 0]
    history_days = len(usable)          # days that had both work orders and technicians
    usual_load = (sum(s["open"] / s["technicians"] for s in usable) / len(usable)) if usable else None
    avg_open = (sum(s["open"] for s in samples) / len(samples)) if samples else None
    benchmark = max(usual_load or 0.0, MIN_LOAD)
    current_load = (current_open / headcount) if headcount else None
    recommended = math.ceil(current_open / benchmark) if current_open else 0

    # Weekly roll-up for the explanation (oldest week first).
    weeks = []
    for i in range(0, len(samples), 7):
        chunk = samples[i:i + 7]
        loads = [s["open"] / s["technicians"] for s in chunk if s["technicians"]]
        weeks.append({"from": chunk[0]["date"], "to": chunk[-1]["date"],
                      "avg_open": _round(sum(s["open"] for s in chunk) / len(chunk)),
                      "avg_per_technician": _round(sum(loads) / len(loads)) if loads else None})

    plural = lambda n, one, many: f"{n} {one if n == 1 else many}"  # noqa: E731
    additional = 0
    if headcount == 0:
        verdict = "no_technicians" if current_open else "insufficient_data"
        additional = max(recommended, 1) if current_open else 0
        message = (f"There {'is' if current_open == 1 else 'are'} {plural(current_open, 'open work order', 'open work orders')} "
                   f"and no active technicians - you need at least {plural(additional, 'technician', 'technicians')}."
                   if current_open else "There are no active technicians and no open work orders yet.")
    elif history_days < MIN_HISTORY_DAYS:
        verdict = "insufficient_data"
        message = (f"Not enough history yet - this estimate needs at least {MIN_HISTORY_DAYS} days of work orders "
                   f"(there {'is' if history_days == 1 else 'are'} {plural(history_days, 'day', 'days')} so far)."
                   + (f" Right now each technician has about {current_load:.1f} open work orders." if current_open else ""))
    elif current_load <= benchmark * (1 + TOLERANCE):
        verdict = "sufficient"
        message = "Current staffing looks sufficient for the current workload."
    else:
        verdict = "understaffed"
        additional = max(recommended - headcount, 1)
        message = (f"Based on the last 4 weeks, you may need {plural(additional, 'more technician', 'more technicians')} "
                   f"to keep up with the current workload.")

    detail = None
    if headcount and verdict in ("sufficient", "understaffed"):
        detail = (f"Each technician currently has about {current_load:.1f} open work orders, against an average of "
                  f"{usual_load:.1f} over the last {plural(history_days, 'day', 'days')}"
                  + (f" (the estimate assumes each technician can carry at least {MIN_LOAD:g})"
                     if (usual_load or 0) < MIN_LOAD else "") + ".")

    return {
        "verdict": verdict,
        "message": message,
        "detail": detail,
        "additional_technicians": additional,
        "recommended_headcount": max(recommended, headcount) if verdict == "understaffed" else headcount,
        "current": {"open_work_orders": current_open, "technicians": headcount,
                    "open_per_technician": _round(current_load)},
        "history": {"window_days": WINDOW_DAYS, "days_with_data": history_days,
                    "avg_open_work_orders": _round(avg_open),
                    "avg_open_per_technician": _round(usual_load), "weeks": weeks},
        "rule": {"min_load_per_technician": MIN_LOAD, "benchmark_per_technician": _round(benchmark),
                 "tolerance_pct": int(TOLERANCE * 100)},
        "method": "rule-based estimate from historical data (not a trained AI model)",
        "generated_at": now.replace(microsecond=0).isoformat(),
    }
