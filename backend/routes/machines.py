"""Machine registry and per-machine maintenance history.

Everyone logged in can view machines and their history. Admins/Supervisors
register machines. Anyone may add a manual log note (e.g. an inspection
observation) to a machine's history.
"""
import re
from datetime import date
from decimal import Decimal

from flask import Blueprint, jsonify, request
from sqlalchemy import func, or_
from sqlalchemy.orm import joinedload

import audit
from auth.rbac import current_user, permission_required
from errors import APIError
from extensions import db
from models import MaintenanceHistory, Machine, WorkOrder
from models.enums import MACHINE_STATUSES, MAINTENANCE_CATEGORIES
from models.work_order import FINISHED_STATUSES, to_iso, to_number
from validation import (
    clean_str, get_json_body, like_pattern, parse_date, parse_decimal, parse_int,
    parse_page_args, reject_unknown_fields, require_fields, validate_choice,
)

machines_bp = Blueprint("machines", __name__)

MACHINE_CODE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,30}$")
MAX_TEXT = 65535
MAX_HOURS = Decimal("999999.99")
MAX_COST = Decimal("9999999999.99")


def _get_machine_or_404(machine_id):
    machine = db.session.get(Machine, machine_id)
    if machine is None:
        raise APIError("Machine not found", 404)
    return machine


def _paging():
    page, per_page = parse_page_args(request.args)
    return page, per_page


def _open_counts(machine_ids):
    """{machine_id: number of work orders not yet Completed/Verified/Closed}"""
    if not machine_ids:
        return {}
    rows = (db.session.query(WorkOrder.machine_id, func.count(WorkOrder.id))
            .filter(WorkOrder.machine_id.in_(machine_ids),
                    WorkOrder.status.notin_(FINISHED_STATUSES))
            .group_by(WorkOrder.machine_id).all())
    return dict(rows)


# --------------------------------------------------------------- registry

MACHINE_FIELDS = {"machine_code", "name", "department", "install_date", "location",
                  "manufacturer", "model", "serial_number", "status"}
# Retiring/reactivating goes through PATCH /retire, so it's not a settable status.
ACTIVE_STATUSES = tuple(s for s in MACHINE_STATUSES if s != "Retired")
AUDITED_FIELDS = ("machine_code", "name", "department", "install_date", "location",
                  "manufacturer", "model", "serial_number", "status")


def _snapshot(machine):
    return {f: getattr(machine, f) for f in AUDITED_FIELDS}


def _apply_machine_fields(machine, data, creating):
    """Validate and apply machine fields from a request body (all fields
    when creating, only the ones sent when editing)."""
    def given(field):
        return creating or field in data

    if given("machine_code"):
        code = clean_str(data.get("machine_code"), "machine_code", 30, required=True).upper()
        if not MACHINE_CODE_RE.match(code):
            raise APIError("'machine_code' may only contain letters, digits, '_', '.', '-'", 400)
        clash = Machine.query.filter(Machine.machine_code == code, Machine.id != machine.id).first()
        if clash:
            raise APIError(f"A machine with code {code} already exists", 409)
        machine.machine_code = code
    if given("serial_number"):
        serial = clean_str(data.get("serial_number"), "serial_number", 100)
        if serial and Machine.query.filter(Machine.serial_number == serial, Machine.id != machine.id).first():
            raise APIError(f"A machine with serial number {serial} already exists", 409)
        machine.serial_number = serial
    if given("install_date"):
        install_date = parse_date(data.get("install_date"), "install_date")
        if install_date and install_date > date.today():
            raise APIError("'install_date' cannot be in the future", 400)
        machine.install_date = install_date
    if given("name"):
        machine.name = clean_str(data.get("name"), "name", 120, required=True)
    if given("department"):
        machine.department = clean_str(data.get("department"), "department", 100, required=True)
    for field, max_len in (("location", 120), ("manufacturer", 100), ("model", 100)):
        if given(field):
            setattr(machine, field, clean_str(data.get(field), field, max_len))
    if "status" in data or creating:
        status = data.get("status", "Operational")
        if status == "Retired":
            raise APIError("Use PATCH /api/machines/<id>/retire to retire a machine", 400)
        if not creating and machine.status == "Retired":
            raise APIError("This machine is retired - reactivate it before changing its status", 409)
        machine.status = validate_choice(status, ACTIVE_STATUSES, "status")


@machines_bp.post("")
@permission_required("machines:manage")
def create_machine():
    """POST /api/machines
    Required: machine_code (asset tag, e.g. CNC-001), name, department.
    Optional: install_date (YYYY-MM-DD), location, manufacturer, model,
    serial_number, status (Operational | Under Maintenance | Breakdown)."""
    data = get_json_body()
    reject_unknown_fields(data, MACHINE_FIELDS)
    require_fields(data, "machine_code", "name", "department")

    machine = Machine()
    _apply_machine_fields(machine, data, creating=True)
    db.session.add(machine)
    db.session.flush()
    audit.record(current_user(), "machine.created", "machine", machine.id, machine.machine_code,
                 f"{current_user().full_name} registered machine {machine.machine_code} ({machine.name})")
    db.session.commit()
    return jsonify(machine=machine.to_dict()), 201


@machines_bp.put("/<int:machine_id>")
@permission_required("machines:manage")
def update_machine(machine_id):
    """PUT /api/machines/<id> - send only the fields to change (same fields as
    create). Retired machines can still have their details corrected."""
    machine = db.session.get(Machine, machine_id, with_for_update=True)
    if machine is None:
        raise APIError("Machine not found", 404)
    data = get_json_body()
    reject_unknown_fields(data, MACHINE_FIELDS)
    if not data:
        raise APIError("No fields to update", 400)

    before = _snapshot(machine)
    _apply_machine_fields(machine, data, creating=False)
    diff = audit.changes(before, _snapshot(machine))
    if diff:
        audit.record(current_user(), "machine.updated", "machine", machine.id, machine.machine_code,
                     f"{current_user().full_name} edited machine {machine.machine_code} ({', '.join(diff)})",
                     {"changes": diff})
    db.session.commit()
    return jsonify(machine=machine.to_dict())


@machines_bp.patch("/<int:machine_id>/retire")
@permission_required("machines:manage")
def set_retired(machine_id):
    """PATCH /api/machines/<id>/retire  {"retired": true, "reason": "..."}
    Retire (hide from new work orders, keep all history) or reactivate
    ({"retired": false} -> Operational). A machine with open work orders
    can't be retired until they're finished or moved."""
    machine = db.session.get(Machine, machine_id, with_for_update=True)
    if machine is None:
        raise APIError("Machine not found", 404)
    data = get_json_body()
    reject_unknown_fields(data, {"retired", "reason"})
    if not isinstance(data.get("retired"), bool):
        raise APIError("'retired' must be true or false", 400)
    reason = clean_str(data.get("reason"), "reason", 200)
    user = current_user()

    if data["retired"]:
        if machine.status == "Retired":
            raise APIError(f"{machine.machine_code} is already retired", 409)
        open_count = _open_counts([machine.id]).get(machine.id, 0)
        if open_count:
            raise APIError(f"{machine.machine_code} has {open_count} open work order"
                           f"{'s' if open_count != 1 else ''}. Complete or move them before retiring it", 409)
        previous = machine.status
        machine.status = "Retired"
        audit.record(user, "machine.retired", "machine", machine.id, machine.machine_code,
                     f"{user.full_name} retired machine {machine.machine_code}" + (f": {reason}" if reason else ""),
                     {"previous_status": previous, "reason": reason})
    else:
        if machine.status != "Retired":
            raise APIError(f"{machine.machine_code} is not retired", 409)
        machine.status = "Operational"
        audit.record(user, "machine.reactivated", "machine", machine.id, machine.machine_code,
                     f"{user.full_name} reactivated machine {machine.machine_code}" + (f": {reason}" if reason else ""),
                     {"reason": reason})
    db.session.commit()
    return jsonify(machine=machine.to_dict())


@machines_bp.get("")
@permission_required("machines:view")
def list_machines():
    """GET /api/machines?department=&status=&q=&page=&per_page=
    Each machine includes open_work_orders (not yet completed)."""
    query = Machine.query
    if request.args.get("department"):
        query = query.filter(Machine.department == request.args["department"].strip())
    if request.args.get("status"):
        statuses = [s.strip() for s in request.args["status"].split(",") if s.strip()]
        for s in statuses:
            validate_choice(s, MACHINE_STATUSES, "status")
        query = query.filter(Machine.status.in_(statuses))
    search = (request.args.get("q") or "").strip()
    if search:
        like = like_pattern(search[:100])
        query = query.filter(or_(Machine.machine_code.like(like, escape="\\"), Machine.name.like(like, escape="\\"),
                                 Machine.location.like(like, escape="\\"), Machine.serial_number.like(like, escape="\\")))

    page, per_page = _paging()
    result = query.order_by(Machine.machine_code).paginate(page=page, per_page=per_page,
                                                           error_out=False)
    open_counts = _open_counts([m.id for m in result.items])
    machines = []
    for m in result.items:
        item = m.to_dict()
        item["open_work_orders"] = open_counts.get(m.id, 0)
        machines.append(item)

    return jsonify(machines=machines,
                   pagination={"page": result.page, "per_page": result.per_page,
                               "total": result.total, "pages": result.pages})


@machines_bp.get("/<int:machine_id>")
@permission_required("machines:view")
def get_machine(machine_id):
    """GET /api/machines/<id> - machine plus work-order and maintenance stats."""
    machine = _get_machine_or_404(machine_id)

    total_wos = WorkOrder.query.filter_by(machine_id=machine.id).count()
    history_stats = (db.session.query(
        func.count(MaintenanceHistory.id),
        func.coalesce(func.sum(MaintenanceHistory.total_cost), 0),
        func.coalesce(func.sum(MaintenanceHistory.downtime_hours), 0),
        func.max(MaintenanceHistory.maintenance_date),
    ).filter(MaintenanceHistory.machine_id == machine.id).one())

    body = machine.to_dict()
    body["stats"] = {
        "total_work_orders": total_wos,
        "open_work_orders": _open_counts([machine.id]).get(machine.id, 0),
        "history_entries": history_stats[0],
        "total_maintenance_cost": to_number(history_stats[1]),
        "total_downtime_hours": to_number(history_stats[2]),
        "last_maintenance_date": to_iso(history_stats[3]),
    }
    return jsonify(machine=body)


# ---------------------------------------------------------------- history

@machines_bp.get("/<int:machine_id>/history")
@permission_required("machines:view")
def machine_history(machine_id):
    """GET /api/machines/<id>/history?page=&per_page=
    Completed work orders and manual log notes for this machine, newest first."""
    machine = _get_machine_or_404(machine_id)
    page, per_page = _paging()

    result = (MaintenanceHistory.query
              .filter_by(machine_id=machine.id)
              .options(joinedload(MaintenanceHistory.work_order),
                       joinedload(MaintenanceHistory.technician))
              .order_by(MaintenanceHistory.maintenance_date.desc(),
                        MaintenanceHistory.id.desc())
              .paginate(page=page, per_page=per_page, error_out=False))

    return jsonify(
        machine=machine.to_summary(),
        history=[entry.to_dict() for entry in result.items],
        pagination={"page": result.page, "per_page": result.per_page,
                    "total": result.total, "pages": result.pages},
    )


@machines_bp.post("/<int:machine_id>/history")
@permission_required("machines:log_notes")
def add_history_note(machine_id):
    """POST /api/machines/<id>/history - a manual log note not tied to a work
    order (inspection finding, observation, outside-contractor visit, ...).
    Required: work_performed. Optional: maintenance_type (default Inspection),
    maintenance_date (default today), downtime_hours, labour_cost,
    material_cost, remarks."""
    machine = _get_machine_or_404(machine_id)
    data = get_json_body()
    reject_unknown_fields(data, {"work_performed", "maintenance_type", "maintenance_date",
                                 "downtime_hours", "labour_cost", "material_cost", "remarks"})
    require_fields(data, "work_performed")

    when = parse_date(data.get("maintenance_date"), "maintenance_date") or date.today()
    if when > date.today():
        raise APIError("'maintenance_date' cannot be in the future", 400)

    def money(field, maximum):
        value = data.get(field)
        return parse_decimal(value, field, 0, maximum) if value is not None else Decimal("0")

    entry = MaintenanceHistory(
        machine_id=machine.id,
        maintenance_type=validate_choice(data.get("maintenance_type", "Inspection"),
                                         MAINTENANCE_CATEGORIES, "maintenance_type"),
        maintenance_date=when,
        performed_by=current_user().id,
        work_performed=clean_str(data["work_performed"], "work_performed", MAX_TEXT, required=True),
        downtime_hours=money("downtime_hours", MAX_HOURS),
        labour_cost=money("labour_cost", MAX_COST),
        material_cost=money("material_cost", MAX_COST),
        remarks=clean_str(data.get("remarks"), "remarks", MAX_TEXT),
    )
    db.session.add(entry)
    db.session.flush()
    audit.record(current_user(), "maintenance.note_added", "machine", machine.id, machine.machine_code,
                 f"{current_user().full_name} added a {entry.maintenance_type.lower()} note to {machine.machine_code}",
                 {"history_id": entry.id, "note": entry.work_performed[:200]})
    db.session.commit()
    return jsonify(history_entry=entry.to_dict()), 201
