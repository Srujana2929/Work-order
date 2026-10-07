"""Dashboard figures.

Work-order counts cover every work order the user can see (technicians: their
own). Costs are *maintenance spend*: the cost of finished work, taken from
maintenance history and counted in the month the work was completed (plus any
costs on manual log notes). Work still in progress isn't counted until it's
completed, so a month's figure only goes up as work finishes.
"""
from datetime import date, timedelta

from flask import Blueprint, jsonify
from sqlalchemy import case, func, or_

import staffing

from auth.rbac import TECHNICIAN, current_user, permission_required, scope_work_orders
from extensions import db
from models import MaintenanceHistory, User, WorkOrder
from models.enums import PRIORITIES, WORK_ORDER_STATUSES
from models.work_order import FINISHED_STATUSES, to_number

dashboard_bp = Blueprint("dashboard", __name__)

MONTHS = 6


def _month_starts(today, count):
    """First day of each of the last `count` months, oldest first, ending with this month."""
    starts = []
    year, month = today.year, today.month
    for _ in range(count):
        starts.append(date(year, month, 1))
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return starts[::-1]


@dashboard_bp.get("/summary")
@permission_required("dashboard:view")
def summary():
    """GET /api/dashboard/summary"""
    user = current_user()
    today = date.today()

    # ---- work-order counts
    status_rows = (scope_work_orders(db.session.query(WorkOrder.status, func.count(WorkOrder.id)), user)
                   .group_by(WorkOrder.status).all())
    by_status = {s: 0 for s in WORK_ORDER_STATUSES}
    by_status.update(dict(status_rows))

    open_filter = WorkOrder.status.notin_(FINISHED_STATUSES)
    priority_rows = (scope_work_orders(db.session.query(WorkOrder.priority, func.count(WorkOrder.id)), user)
                     .filter(open_filter).group_by(WorkOrder.priority).all())
    open_by_priority = {p: 0 for p in PRIORITIES}
    open_by_priority.update(dict(priority_rows))

    overdue = (scope_work_orders(WorkOrder.query, user)
               .filter(open_filter, WorkOrder.due_date < today).count())

    # ---- per-department counts (total + still open), biggest first
    open_case = func.sum(case((open_filter, 1), else_=0))
    dept_rows = (scope_work_orders(db.session.query(WorkOrder.department, func.count(WorkOrder.id), open_case), user)
                 .group_by(WorkOrder.department)
                 .order_by(func.count(WorkOrder.id).desc(), WorkOrder.department).all())
    by_department = [{"department": d, "total": total, "open": int(open_ or 0)}
                     for d, total, open_ in dept_rows]

    # ---- maintenance spend by month (last 6 months, zero-filled)
    months = _month_starts(today, MONTHS)
    year_col = func.year(MaintenanceHistory.maintenance_date)
    month_col = func.month(MaintenanceHistory.maintenance_date)
    cost_query = (db.session.query(
        year_col, month_col,
        func.count(MaintenanceHistory.id),
        func.coalesce(func.sum(MaintenanceHistory.labour_cost), 0),
        func.coalesce(func.sum(MaintenanceHistory.material_cost), 0),
        func.coalesce(func.sum(MaintenanceHistory.total_cost), 0),
    ).filter(MaintenanceHistory.maintenance_date >= months[0],
             MaintenanceHistory.maintenance_date <= today))
    if user.role == TECHNICIAN:
        cost_query = cost_query.filter(MaintenanceHistory.performed_by == user.id)
    rows = {(y, m): r for y, m, *r in cost_query.group_by(year_col, month_col).all()}

    cost_by_month = []
    for start in months:
        count, labour, material, total = rows.get((start.year, start.month), (0, 0, 0, 0))
        cost_by_month.append({
            "month": start.strftime("%Y-%m"),
            "label": start.strftime("%b %Y"),
            "entries": count,
            "labour_cost": to_number(labour),
            "material_cost": to_number(material),
            "total_cost": to_number(total),
        })

    return jsonify(
        scope="own" if user.role == TECHNICIAN else "all",
        generated_on=today.isoformat(),
        total_work_orders=sum(by_status.values()),
        open_work_orders=sum(v for s, v in by_status.items() if s not in FINISHED_STATUSES),
        by_status=by_status,
        open_by_priority=open_by_priority,
        by_department=by_department,
        overdue=overdue,
        cost_this_month=cost_by_month[-1]["total_cost"],
        cost_by_month=cost_by_month,
    )


@dashboard_bp.get("/staffing")
@permission_required("dashboard:staffing")
def staffing_insight():
    """GET /api/dashboard/staffing - Admin/Supervisor. Rule-based staffing
    estimate from the last 4 weeks of work orders (see backend/staffing.py
    for the exact rule); the response carries every figure it used."""
    now = db.session.execute(db.select(func.now())).scalar_one()   # database clock, like created_at
    window_start = now - timedelta(days=staffing.WINDOW_DAYS + 1)
    rows = (db.session.query(WorkOrder.created_at, WorkOrder.completed_at)
            .filter(WorkOrder.created_at < now,
                    or_(WorkOrder.completed_at.is_(None), WorkOrder.completed_at >= window_start))
            .all())
    techs = [c for (c,) in db.session.query(User.created_at)
             .filter(User.role == TECHNICIAN, User.is_active.is_(True)).all()]
    current_open = WorkOrder.query.filter(WorkOrder.status.notin_(FINISHED_STATUSES)).count()
    first_created = db.session.query(func.min(WorkOrder.created_at)).scalar()
    return jsonify(staffing=staffing.estimate(rows, techs, current_open, now, first_created))
