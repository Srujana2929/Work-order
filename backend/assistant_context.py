"""Live data snapshot for the AI assistant.

Every question re-queries the database and sends Gemini this snapshot, so
answers are grounded in current numbers rather than the model's guesses.
It is a compact JSON document: work-order totals, every open work order (up
to OPEN_LIMIT, most urgent first), per-person workload and throughput,
weekly trends and machine/cost summaries.
"""
from collections import Counter, defaultdict
from datetime import timedelta
from statistics import median

from sqlalchemy import func
from sqlalchemy.orm import joinedload

from extensions import db
from models import Machine, MaintenanceHistory, User, WorkOrder
from models.work_order import FINISHED_STATUSES, to_iso, to_number
from schema_check import ratings_available

OPEN_LIMIT = 80          # open work orders listed individually
TREND_WEEKS = 8
RECENT_DAYS = 28
PRIORITY_RANK = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}


def _iso(dt):
    return to_iso(dt, timespec="minutes") if hasattr(dt, "hour") else to_iso(dt)


def _wo_ref(wo_id):
    return f"WO-{wo_id:05d}"


def build_snapshot():
    now = db.session.execute(db.select(func.now())).scalar_one()   # database clock (UTC), like created_at
    today = now.date()
    recent_start = now - timedelta(days=RECENT_DAYS)
    trend_start = now - timedelta(weeks=TREND_WEEKS)

    users = User.query.filter(User.is_active.is_(True)).all()
    techs = [u for u in users if u.role == "Technician"]
    supervisors = [u for u in users if u.role == "Supervisor"]
    admins = [u for u in users if u.role == "Admin"]

    # ---- work orders: totals + every open one
    by_status = Counter(dict(db.session.query(WorkOrder.status, func.count(WorkOrder.id))
                             .group_by(WorkOrder.status).all()))
    open_wos = (WorkOrder.query.options(joinedload(WorkOrder.machine), joinedload(WorkOrder.technician))
                .filter(WorkOrder.status.notin_(FINISHED_STATUSES)).all())
    open_wos.sort(key=lambda w: (not w.is_overdue, PRIORITY_RANK.get(w.priority, 9),
                                 w.due_date or today + timedelta(days=36500), w.id))
    open_rows = []
    for w in open_wos[:OPEN_LIMIT]:
        open_rows.append({
            "id": _wo_ref(w.id), "title": w.title, "status": w.status, "priority": w.priority,
            "category": w.category, "department": w.department,
            "machine": w.machine.machine_code if w.machine else None,
            "assigned_to": w.technician.full_name if w.technician else None,
            "progress_pct": w.progress,
            "due_date": w.due_date.isoformat() if w.due_date else None,
            "days_overdue": (today - w.due_date).days if w.is_overdue else 0,
            "age_days": (now - w.created_at).days,
        })
    overdue = [w for w in open_wos if w.is_overdue]
    due_7 = [w for w in open_wos if w.due_date and today <= w.due_date <= today + timedelta(days=7)]

    # ---- recent history (for throughput + trends)
    hist = (db.session.query(WorkOrder.id, WorkOrder.created_at, WorkOrder.completed_at, WorkOrder.status,
                             WorkOrder.assigned_technician_id, WorkOrder.created_by, WorkOrder.verified_by,
                             WorkOrder.verified_at)
            .filter((WorkOrder.created_at >= trend_start) | (WorkOrder.completed_at >= trend_start)
                    | WorkOrder.completed_at.is_(None)).all())

    # ---- technicians
    ratings = {}
    if ratings_available():
        from models import TechnicianRating
        ratings = {tid: (round(float(avg), 2), n) for tid, avg, n in
                   db.session.query(TechnicianRating.technician_id, func.avg(TechnicianRating.stars),
                                    func.count(TechnicianRating.id))
                   .group_by(TechnicianRating.technician_id).all()}
    open_by_tech = defaultdict(Counter)
    for w in open_wos:
        if w.assigned_technician_id:
            c = open_by_tech[w.assigned_technician_id]
            c["open"] += 1
            c[w.status] += 1
            c["overdue"] += int(w.is_overdue)
    done_recent = Counter(h.assigned_technician_id for h in hist
                          if h.completed_at and h.completed_at >= recent_start and h.assigned_technician_id)
    tech_rows = []
    for t in sorted(techs, key=lambda u: -open_by_tech[u.id]["open"]):
        c = open_by_tech[t.id]
        r = ratings.get(t.id)
        tech_rows.append({
            "name": t.full_name, "department": t.department,
            "open_work_orders": c["open"], "in_progress": c["In Progress"], "on_hold": c["On Hold"],
            "assigned_not_started": c["Assigned"], "overdue": c["overdue"],
            f"completed_last_{RECENT_DAYS}_days": done_recent[t.id],
            "avg_rating": r[0] if r else None, "ratings_count": r[1] if r else 0,
        })

    # ---- supervisors / admins: oversight load
    created_recent = Counter(h.created_by for h in hist if h.created_at >= recent_start and h.created_by)
    verified_recent = Counter(h.verified_by for h in hist if h.verified_at and h.verified_at >= recent_start and h.verified_by)
    oversight = [{"name": u.full_name, "role": u.role, "department": u.department,
                  f"work_orders_raised_last_{RECENT_DAYS}_days": created_recent[u.id],
                  f"work_orders_verified_last_{RECENT_DAYS}_days": verified_recent[u.id]}
                 for u in supervisors + admins]

    # ---- weekly trend (oldest first)
    weeks = []
    for i in range(TREND_WEEKS, 0, -1):
        start, end = now - timedelta(weeks=i), now - timedelta(weeks=i - 1)
        created = [h for h in hist if start <= h.created_at < end]
        completed = [h for h in hist if h.completed_at and start <= h.completed_at < end]
        open_at_end = sum(1 for h in hist if h.created_at < end and (h.completed_at is None or h.completed_at >= end))
        hours = [(h.completed_at - h.created_at).total_seconds() / 3600 for h in completed]
        active_techs = sum(1 for t in techs if t.created_at < end)
        weeks.append({
            "week_starting": start.date().isoformat(), "created": len(created), "completed": len(completed),
            "open_at_week_end": open_at_end, "technicians_on_staff": active_techs,
            "median_hours_to_complete": round(median(hours), 1) if hours else None,
        })

    # ---- machines + spend
    machine_status = dict(db.session.query(Machine.status, func.count(Machine.id)).group_by(Machine.status).all())
    busiest = Counter(w.machine.machine_code for w in open_wos if w.machine).most_common(5)
    spend_start = (today.replace(day=1) - timedelta(days=62)).replace(day=1)
    spend = (db.session.query(func.year(MaintenanceHistory.maintenance_date), func.month(MaintenanceHistory.maintenance_date),
                              func.coalesce(func.sum(MaintenanceHistory.total_cost), 0))
             .filter(MaintenanceHistory.maintenance_date >= spend_start)
             .group_by(func.year(MaintenanceHistory.maintenance_date), func.month(MaintenanceHistory.maintenance_date))
             .order_by(func.year(MaintenanceHistory.maintenance_date), func.month(MaintenanceHistory.maintenance_date)).all())

    return {
        "generated_at": _iso(now),
        "today": today.isoformat(),
        "people": {"active_technicians": len(techs), "active_supervisors": len(supervisors), "active_admins": len(admins)},
        "work_orders": {
            "total": sum(by_status.values()),
            "by_status": dict(by_status),
            "open": len(open_wos),
            "open_unassigned": sum(1 for w in open_wos if not w.assigned_technician_id),
            "overdue": len(overdue),
            "due_in_next_7_days": len(due_7),
            "open_by_priority": dict(Counter(w.priority for w in open_wos)),
        },
        "open_work_orders": open_rows,
        "open_work_orders_listed": f"{len(open_rows)} of {len(open_wos)} (overdue first, then by priority and due date)",
        "technicians": tech_rows,
        "supervisors_and_admins": oversight,
        "weekly_trend": weeks,
        "machines": {"by_status": machine_status,
                     "most_open_work_orders": [{"machine": m, "open_work_orders": n} for m, n in busiest]},
        "maintenance_spend_by_month": [{"month": f"{y}-{m:02d}", "total_cost": to_number(c)} for y, m, c in spend],
    }
