"""Work order API.

Admin: everything. Supervisor: create, edit, assign, verify, close, log costs.
Technician: only work orders assigned to them - view, start/hold/complete,
update progress, log materials and labour. Others' work orders return 404.
"""
from datetime import date
from decimal import Decimal

from flask import Blueprint, jsonify, request
from sqlalchemy import or_
from sqlalchemy.orm import joinedload

from auth.rbac import (
    TECHNICIAN, current_user, ensure_work_order_access, has_permission,
    permission_required, scope_work_orders,
)
from errors import APIError
from schema_check import photos_available, ratings_available
from extensions import db
import audit
import photo_check
import photo_storage
import ratings
from maintenance import HISTORY_STATUSES, remove_history, sync_history_if_finished, upsert_history
from models import Machine, Material, MaterialPhoto, User, WorkOrder
from models.material_photo import REVIEW_STATUSES
from models.enums import MAINTENANCE_CATEGORIES, PRIORITIES, WORK_ORDER_STATUSES
from validation import (
    clean_str, get_json_body, like_pattern, parse_date, parse_decimal, parse_int,
    parse_page_args, reject_unknown_fields, require_fields, validate_choice,
)
from workflow import (
    COST_STATUSES, LOCKED_STATUSES, PROGRESS_STATUSES, REASSIGN_STATUSES,
    TRANSITIONS, allowed_transitions, next_statuses,
)

wo_bp = Blueprint("work_orders", __name__)

MAX_TEXT = 65535
MAX_HOURS = Decimal("999999.99")   # DECIMAL(8,2)
MAX_RATE = Decimal("99999999.99")  # DECIMAL(10,2)


# ---------------------------------------------------------------- helpers

def wo_label(work_order):
    return f"WO-{work_order.id:05d}"


def _wo_snapshot(wo):
    """Fields whose changes are audited on edit."""
    return {"title": wo.title, "description": wo.description, "machine_id": wo.machine_id,
            "department": wo.department, "category": wo.category, "priority": wo.priority,
            "due_date": wo.due_date, "labour_hours": wo.labour_hours, "labour_rate": wo.labour_rate,
            "progress": wo.progress, "assigned_technician_id": wo.assigned_technician_id, "status": wo.status}


def _load_work_order(wo_id, lock=False):
    """Fetch a work order the current user may see, else 404.
    lock=True takes a row lock (SELECT ... FOR UPDATE) for the rest of the
    request, so concurrent edits - e.g. two people logging labour or changing
    status at once - apply one after the other instead of overwriting."""
    work_order = db.session.get(WorkOrder, wo_id, with_for_update=lock)
    if work_order is None:
        raise APIError("Work order not found", 404)
    ensure_work_order_access(current_user(), work_order)
    return work_order


def _require_permission(permission, message):
    if not has_permission(current_user(), permission):
        raise APIError(message, 403)


def _ensure_not_locked(work_order):
    if work_order.status in LOCKED_STATUSES:
        raise APIError(f"Work order is {work_order.status} and can no longer be changed", 409)


def _get_machine(machine_id):
    machine = db.session.get(Machine, parse_int(machine_id, "machine_id", minimum=1))
    if machine is None:
        raise APIError(f"Machine {machine_id} does not exist", 400)
    if machine.status == "Retired":
        raise APIError(f"Machine {machine.machine_code} is retired", 400)
    return machine


def _get_technician(user_id):
    user = db.session.get(User, parse_int(user_id, "assigned_technician_id", minimum=1))
    if user is None or user.role != TECHNICIAN or not user.is_active:
        raise APIError(f"User {user_id} is not an active technician", 400)
    return user


def _validate_due_date(value, created_on):
    due = parse_date(value, "due_date")
    if due is not None and due < created_on:
        raise APIError(f"'due_date' cannot be before the creation date ({created_on})", 400)
    return due


def _detail(work_order, status=200):
    user = current_user()
    body = work_order.to_dict(include_materials=True)
    body["allowed_transitions"] = allowed_transitions(user, work_order)
    # Individual ratings (stars + comment) are for supervisors/admins; the
    # technician sees only their own average (GET /api/users/<id>/ratings).
    rating = ratings.rating_for(work_order) if has_permission(user, "users:view_ratings") else None
    body["rating"] = rating.to_dict() if rating else None
    body["features"] = {
        "ratings": ratings_available(),
        "photos": photos_available() and photo_storage.is_configured(),
        "photo_ai_check": photo_check.is_configured(),
    }
    return jsonify(work_order=body), status


def _csv_choices(param, choices):
    raw = request.args.get(param)
    if not raw:
        return None
    values = [v.strip() for v in raw.split(",") if v.strip()]
    for value in values:
        validate_choice(value, choices, param)
    return values


# ------------------------------------------------------------ create/list

CREATE_FIELDS = {"title", "description", "machine_id", "department", "category",
                 "priority", "due_date", "assigned_technician_id", "labour_rate"}


@wo_bp.post("")
@permission_required("work_orders:create")
def create_work_order():
    """POST /api/work-orders
    Required: title, machine_id. Optional: description, department (defaults
    to the machine's), category, priority, due_date, assigned_technician_id
    (status starts as Assigned when given), labour_rate."""
    data = get_json_body()
    reject_unknown_fields(data, CREATE_FIELDS)
    require_fields(data, "title", "machine_id")

    machine = _get_machine(data["machine_id"])
    work_order = WorkOrder(
        title=clean_str(data["title"], "title", 150, required=True),
        description=clean_str(data.get("description"), "description", MAX_TEXT),
        machine_id=machine.id,
        department=clean_str(data.get("department"), "department", 100) or machine.department,
        category=validate_choice(data.get("category", "Corrective"), MAINTENANCE_CATEGORIES, "category"),
        priority=validate_choice(data.get("priority", "Medium"), PRIORITIES, "priority"),
        due_date=_validate_due_date(data.get("due_date"), date.today()),
        created_by=current_user().id,
    )
    if data.get("labour_rate") is not None:
        work_order.labour_rate = parse_decimal(data["labour_rate"], "labour_rate", 0, MAX_RATE)
    if data.get("assigned_technician_id") is not None:
        work_order.assigned_technician_id = _get_technician(data["assigned_technician_id"]).id
        work_order.status = "Assigned"

    db.session.add(work_order)
    db.session.flush()
    user = current_user()
    tech = work_order.technician
    audit.record(user, "work_order.created", "work_order", work_order.id, wo_label(work_order),
                 f"{user.full_name} created {wo_label(work_order)} “{work_order.title}”"
                 + (f" and assigned it to {tech.full_name}" if tech else ""),
                 {"machine": machine.machine_code, "priority": work_order.priority,
                  "assigned_to": tech.username if tech else None})
    db.session.commit()
    return _detail(work_order, 201)


SORT_COLUMNS = {
    "id": WorkOrder.id,
    "created_at": WorkOrder.created_at,
    "due_date": WorkOrder.due_date,
    "priority": WorkOrder.priority,   # ENUM sorts Low < Medium < High < Critical
    "status": WorkOrder.status,       # ENUM sorts in workflow order
    "total_cost": WorkOrder.total_cost,
}


@wo_bp.get("")
@permission_required("work_orders:view")
def list_work_orders():
    """GET /api/work-orders
    Filters: status, priority, category (comma-separated for several),
    assignee (<user id> | me | unassigned), department, machine_id,
    overdue=true, q (search title/description).
    Paging/sorting: page, per_page (max 100), sort (e.g. -priority, due_date).
    Technicians only ever see their own work orders."""
    user = current_user()
    query = scope_work_orders(WorkOrder.query, user).options(
        joinedload(WorkOrder.machine), joinedload(WorkOrder.technician),
        joinedload(WorkOrder.creator), joinedload(WorkOrder.verifier),
    )
    args = request.args

    for param, column, choices in (("status", WorkOrder.status, WORK_ORDER_STATUSES),
                                   ("priority", WorkOrder.priority, PRIORITIES),
                                   ("category", WorkOrder.category, MAINTENANCE_CATEGORIES)):
        values = _csv_choices(param, choices)
        if values:
            query = query.filter(column.in_(values))

    assignee = (args.get("assignee") or "").strip().lower()
    if assignee == "unassigned":
        query = query.filter(WorkOrder.assigned_technician_id.is_(None))
    elif assignee == "me":
        query = query.filter(WorkOrder.assigned_technician_id == user.id)
    elif assignee:
        query = query.filter(WorkOrder.assigned_technician_id
                             == parse_int(assignee, "assignee", minimum=1))

    if args.get("department"):
        query = query.filter(WorkOrder.department == args["department"].strip())
    if args.get("machine_id"):
        query = query.filter(WorkOrder.machine_id == parse_int(args["machine_id"], "machine_id"))
    if (args.get("overdue") or "").lower() in ("true", "1", "yes"):
        query = query.filter(WorkOrder.due_date < date.today(),
                             WorkOrder.status.notin_(("Completed", "Verified", "Closed")))
    search = (args.get("q") or "").strip()
    if search:
        like = like_pattern(search[:100])
        query = query.filter(or_(WorkOrder.title.like(like, escape="\\"), WorkOrder.description.like(like, escape="\\")))

    sort = args.get("sort", "-created_at")
    column = SORT_COLUMNS.get(sort.lstrip("-"))
    if column is None:
        raise APIError(f"'sort' must be one of: {', '.join(SORT_COLUMNS)} "
                       f"(prefix with '-' for descending)", 400)
    query = query.order_by(column.desc() if sort.startswith("-") else column.asc(),
                           WorkOrder.id.desc())

    page, per_page = parse_page_args(args)
    result = query.paginate(page=page, per_page=per_page, error_out=False)

    return jsonify(
        work_orders=[wo.to_dict() for wo in result.items],
        pagination={"page": result.page, "per_page": result.per_page,
                    "total": result.total, "pages": result.pages},
    )


# --------------------------------------------------------- detail / edit

@wo_bp.get("/<int:wo_id>")
@permission_required("work_orders:view")
def get_work_order(wo_id):
    """GET /api/work-orders/<id> - includes materials, costs and the status
    changes the current user is allowed to make."""
    return _detail(_load_work_order(wo_id))


# Which permission(s) allow changing each field through PUT.
FIELD_PERMISSIONS = {
    "title":                  ("work_orders:edit",),
    "description":            ("work_orders:edit",),
    "machine_id":             ("work_orders:edit",),
    "department":             ("work_orders:edit",),
    "category":               ("work_orders:edit",),
    "priority":               ("work_orders:edit",),
    "due_date":               ("work_orders:edit",),
    "labour_hours":           ("work_orders:edit",),   # corrections; normally use /labour-cost
    "labour_rate":            ("work_orders:edit",),
    "assigned_technician_id": ("work_orders:assign",),
    "progress":               ("work_orders:update_work", "work_orders:edit"),
}


@wo_bp.put("/<int:wo_id>")
@permission_required("work_orders:view")
def update_work_order(wo_id):
    """PUT /api/work-orders/<id> - send only the fields to change.
    Supervisors/Admins: any field below. Technicians: 'progress' only.
    Status changes go through PATCH /status; materials/labour through
    their own endpoints."""
    user = current_user()
    work_order = _load_work_order(wo_id, lock=True)
    data = get_json_body()

    if "status" in data:
        raise APIError("Change status with PATCH /api/work-orders/<id>/status", 400)
    reject_unknown_fields(data, FIELD_PERMISSIONS)
    if not data:
        raise APIError("No fields to update", 400)

    forbidden = sorted(f for f in data
                       if not any(has_permission(user, p) for p in FIELD_PERMISSIONS[f]))
    if forbidden:
        raise APIError(f"You are not allowed to change: {', '.join(forbidden)}", 403)
    _ensure_not_locked(work_order)
    before = _wo_snapshot(work_order)

    if "title" in data:
        work_order.title = clean_str(data["title"], "title", 150, required=True)
    if "description" in data:
        work_order.description = clean_str(data["description"], "description", MAX_TEXT)
    if "machine_id" in data:
        work_order.machine_id = _get_machine(data["machine_id"]).id
    if "department" in data:
        work_order.department = clean_str(data["department"], "department", 100, required=True)
    if "category" in data:
        work_order.category = validate_choice(data["category"], MAINTENANCE_CATEGORIES, "category")
    if "priority" in data:
        work_order.priority = validate_choice(data["priority"], PRIORITIES, "priority")
    if "due_date" in data:
        work_order.due_date = _validate_due_date(data["due_date"], work_order.created_at.date())
    if "labour_hours" in data:
        work_order.labour_hours = parse_decimal(data["labour_hours"], "labour_hours", 0, MAX_HOURS)
    if "labour_rate" in data:
        work_order.labour_rate = parse_decimal(data["labour_rate"], "labour_rate", 0, MAX_RATE)

    if "progress" in data:
        if work_order.status not in PROGRESS_STATUSES:
            raise APIError(f"Progress can only be updated while the work order is "
                           f"{', '.join(PROGRESS_STATUSES)} (it is {work_order.status})", 409)
        work_order.progress = parse_int(data["progress"], "progress", 0, 100)

    if "assigned_technician_id" in data:
        if work_order.status not in REASSIGN_STATUSES:
            raise APIError(f"Cannot reassign a work order that is {work_order.status}", 409)
        if data["assigned_technician_id"] is None:
            # Unassigning is only possible before work starts; it goes back to Pending.
            if work_order.status not in ("Pending", "Assigned"):
                raise APIError(f"Cannot unassign a work order that is {work_order.status}; "
                               f"assign a different technician instead", 409)
            work_order.assigned_technician_id = None
            work_order.status = "Pending"
        else:
            work_order.assigned_technician_id = _get_technician(data["assigned_technician_id"]).id
            if work_order.status == "Pending":
                work_order.status = "Assigned"

    db.session.flush()
    sync_history_if_finished(work_order)   # e.g. cost correction on a Completed order
    diff = audit.changes(before, _wo_snapshot(work_order))
    if diff:
        audit.record(user, "work_order.updated", "work_order", work_order.id, wo_label(work_order),
                     f"{user.full_name} edited {wo_label(work_order)} ({', '.join(diff)})", {"changes": diff})
    db.session.commit()
    return _detail(work_order)


# ----------------------------------------------------------------- status

@wo_bp.patch("/<int:wo_id>/status")
@permission_required("work_orders:view")
def change_status(wo_id):
    """PATCH /api/work-orders/<id>/status  {"status": "..."}
    Extra optional fields:
      -> Assigned:            assigned_technician_id (if not already assigned)
      -> Completed/Verified:  work_performed, downtime_hours, remarks
                              (written to the machine's maintenance history)
    Completed, Verified and Closed create/refresh the history entry;
    sending Completed work back to In Progress removes it."""
    user = current_user()
    work_order = _load_work_order(wo_id, lock=True)
    data = get_json_body()
    reject_unknown_fields(data, {"status", "assigned_technician_id",
                                 "work_performed", "downtime_hours", "remarks",
                                 "rating", "rating_comment"})
    require_fields(data, "status")

    new_status = validate_choice(data["status"], WORK_ORDER_STATUSES, "status")
    old_status = work_order.status
    if new_status == old_status:
        raise APIError(f"Work order is already {old_status}", 400)

    permission = TRANSITIONS.get((old_status, new_status))
    if permission is None:
        allowed = next_statuses(old_status)
        raise APIError(
            f"Cannot change status from {old_status} to {new_status}. "
            + (f"Next allowed: {', '.join(allowed)}" if allowed else f"{old_status} is final."),
            409,
        )
    if not has_permission(user, permission):
        raise APIError(f"Your role ({user.role}) cannot move a work order "
                       f"from {old_status} to {new_status}", 403)

    notes_statuses = ("Completed", "Verified")
    extra_for = {"assigned_technician_id": ("Assigned",), "work_performed": notes_statuses,
                 "downtime_hours": notes_statuses, "remarks": notes_statuses,
                 "rating": ratings.RATABLE_STATUSES, "rating_comment": ratings.RATABLE_STATUSES}
    misplaced = sorted(f for f, targets in extra_for.items()
                       if f in data and new_status not in targets)
    if misplaced:
        raise APIError(f"Field(s) {', '.join(misplaced)} are not used when moving to {new_status}", 400)

    notes = {}
    if new_status in notes_statuses:
        notes = {
            "work_performed": clean_str(data.get("work_performed"), "work_performed", MAX_TEXT),
            "remarks": clean_str(data.get("remarks"), "remarks", MAX_TEXT),
            "downtime_hours": (parse_decimal(data["downtime_hours"], "downtime_hours", 0, MAX_HOURS)
                               if data.get("downtime_hours") is not None else None),
        }

    # Optional technician rating, given while verifying or closing.
    rating = None
    if data.get("rating") is not None:
        if not has_permission(user, "work_orders:rate"):
            raise APIError("You do not have permission to rate technicians", 403)
        ratings.require_ratings()
        rating = ratings.parse_rating(data["rating"], data.get("rating_comment"),
                                      stars_field="rating", comment_field="rating_comment")
    elif data.get("rating_comment"):
        raise APIError("'rating_comment' needs a 'rating' (1-5 stars)", 400)

    now = db.func.now()
    if new_status == "Assigned":
        if data.get("assigned_technician_id") is not None:
            work_order.assigned_technician_id = _get_technician(data["assigned_technician_id"]).id
        if work_order.assigned_technician_id is None:
            raise APIError("Provide 'assigned_technician_id' to assign this work order", 400)

    elif new_status == "In Progress":
        if old_status == "Completed":           # sent back for rework
            work_order.completed_at = None
        elif work_order.started_at is None:     # first start
            work_order.started_at = now

    elif new_status == "Completed":
        work_order.progress = 100
        work_order.completed_at = now

    elif new_status == "Verified":
        work_order.verified_by = user.id
        work_order.verified_at = now

    elif new_status == "Closed":
        work_order.closed_at = now

    work_order.status = new_status
    # Flush so completed_at / generated cost columns are real values before
    # they're copied into the history entry (same transaction).
    db.session.flush()
    if new_status in HISTORY_STATUSES:
        upsert_history(work_order, **notes)
    elif old_status == "Completed":   # sent back for rework
        remove_history(work_order)
    extra = {k: audit._plain(v) for k, v in notes.items() if v is not None}
    if new_status == "Assigned" and work_order.technician:
        extra["assigned_to"] = work_order.technician.username
    audit.record(user, "work_order.status_changed", "work_order", work_order.id, wo_label(work_order),
                 f"{user.full_name} changed {wo_label(work_order)} status from {old_status} to {new_status}"
                 + (" (sent back for rework)" if old_status == "Completed" and new_status == "In Progress" else ""),
                 {"from": old_status, "to": new_status, **extra})
    if rating is not None:
        ratings.save_rating(work_order, user, *rating)
    db.session.commit()
    return _detail(work_order)


@wo_bp.put("/<int:wo_id>/rating")
@permission_required("work_orders:rate")
def rate_work_order(wo_id):
    """PUT /api/work-orders/<id>/rating  {"stars": 1-5, "comment": "..."?}
    Rate (or re-rate) the technician on a Verified or Closed work order -
    e.g. when the rating was skipped while verifying."""
    work_order = _load_work_order(wo_id, lock=True)
    data = get_json_body()
    reject_unknown_fields(data, {"stars", "comment"})
    require_fields(data, "stars")
    stars, comment = ratings.parse_rating(data["stars"], data.get("comment"))
    ratings.save_rating(work_order, current_user(), stars, comment)
    db.session.commit()
    return _detail(work_order)


# ----------------------------------------------------------------- delete

@wo_bp.delete("/<int:wo_id>")
@permission_required("work_orders:delete")
def delete_work_order(wo_id):
    """DELETE /api/work-orders/<id> - Admin only. Its materials are deleted
    too; any maintenance-history entry is kept (unlinked from the order)."""
    work_order = _load_work_order(wo_id, lock=True)
    user = current_user()
    audit.record(user, "work_order.deleted", "work_order", work_order.id, wo_label(work_order),
                 f"{user.full_name} deleted {wo_label(work_order)} “{work_order.title}”",
                 {"title": work_order.title, "status": work_order.status,
                  "total_cost": audit._plain(work_order.total_cost)})
    photo_ids = _photo_ids(work_order.materials)
    db.session.delete(work_order)
    db.session.commit()
    for public_id in photo_ids:            # after commit: storage cleanup is best-effort
        photo_storage.destroy_quietly(public_id)
    return jsonify(message=f"Work order {wo_id} deleted")


def _photo_ids(materials):
    if not photos_available():
        return []
    return [m.photo.public_id for m in materials if m.photo]


# ------------------------------------------------------------------ costs

def _load_for_costs(wo_id):
    work_order = _load_work_order(wo_id, lock=True)
    _require_permission("work_orders:log_costs", "You do not have permission to log costs")
    if work_order.status not in COST_STATUSES:
        reason = ("costs are locked once work is verified" if work_order.status in LOCKED_STATUSES
                  else "no work has been assigned yet")
        raise APIError(f"Costs can't be changed while the work order is {work_order.status} ({reason}). "
                       f"They can be added or edited while it is {', '.join(COST_STATUSES)}.", 409)
    return work_order


def _cost_summary(work_order):
    return {k: work_order.to_dict()[k] for k in
            ("labour_hours", "labour_rate", "labour_cost", "material_cost", "total_cost")}


@wo_bp.post("/<int:wo_id>/materials")
@permission_required("work_orders:view")
def add_material(wo_id):
    """POST /api/work-orders/<id>/materials
    {"material_name": "...", "quantity": 2, "unit_cost": 12.50,
     "unit": "pcs", "part_number": "..."}  (unit, part_number optional)"""
    work_order = _load_for_costs(wo_id)
    data = get_json_body()
    reject_unknown_fields(data, MATERIAL_FIELDS)
    require_fields(data, "material_name", "quantity", "unit_cost")

    material = Material(work_order_id=work_order.id, added_by=current_user().id, unit="pcs")
    _apply_material_fields(material, data, creating=True)
    db.session.add(material)
    db.session.flush()                 # trigger updates work_orders.material_cost
    db.session.refresh(work_order)
    sync_history_if_finished(work_order)
    user = current_user()
    audit.record(user, "material.added", "material", material.id, wo_label(work_order),
                 f"{user.full_name} added {material_text(material)} to {wo_label(work_order)}",
                 {"work_order_id": work_order.id, **_material_snapshot(material)})
    db.session.commit()
    return jsonify(material=material.to_dict(), costs=_cost_summary(work_order)), 201


MATERIAL_FIELDS = {"material_name", "quantity", "unit_cost", "unit", "part_number"}


def _apply_material_fields(material, data, creating):
    """Validate + apply material fields (all when creating, only sent ones when editing)."""
    def given(field):
        return creating or field in data

    if given("material_name"):
        material.material_name = clean_str(data.get("material_name"), "material_name", 120, required=True)
    if given("part_number"):
        material.part_number = clean_str(data.get("part_number"), "part_number", 60)
    if given("quantity"):
        material.quantity = parse_decimal(data.get("quantity"), "quantity", 0, Decimal("99999999.99"),
                                          allow_zero=False)
    if given("unit"):
        material.unit = clean_str(data.get("unit"), "unit", 20) or "pcs"
    if given("unit_cost"):
        material.unit_cost = parse_decimal(data.get("unit_cost"), "unit_cost", 0, MAX_RATE)


def _material_snapshot(material):
    return {"material_name": material.material_name, "part_number": material.part_number,
            "quantity": audit._plain(material.quantity), "unit": material.unit,
            "unit_cost": audit._plain(material.unit_cost)}


def material_text(material):
    qty = f"{material.quantity.normalize():f}" if isinstance(material.quantity, Decimal) else material.quantity
    return f"{qty} {material.unit} {material.material_name}"


def _load_material(work_order, material_id):
    material = db.session.get(Material, material_id)
    if material is None or material.work_order_id != work_order.id:
        raise APIError("Material not found on this work order", 404)
    return material


@wo_bp.put("/<int:wo_id>/materials/<int:material_id>")
@permission_required("work_orders:view")
def update_material(wo_id, material_id):
    """PUT /api/work-orders/<id>/materials/<material_id> - send only the fields
    to change (material_name, quantity, unit_cost, unit, part_number).
    material_cost is recalculated by the database trigger. Not allowed once
    the work order is Verified/Closed."""
    work_order = _load_for_costs(wo_id)
    material = _load_material(work_order, material_id)
    data = get_json_body()
    reject_unknown_fields(data, MATERIAL_FIELDS)
    if not data:
        raise APIError("No fields to update", 400)

    before = _material_snapshot(material)
    _apply_material_fields(material, data, creating=False)
    diff = audit.changes(before, _material_snapshot(material))
    db.session.flush()                 # trigger recalculates work_orders.material_cost
    db.session.refresh(work_order)
    sync_history_if_finished(work_order)
    if diff:
        user = current_user()
        audit.record(user, "material.updated", "material", material.id, wo_label(work_order),
                     f"{user.full_name} edited {material.material_name} on {wo_label(work_order)} ({', '.join(diff)})",
                     {"work_order_id": work_order.id, "changes": diff})
    db.session.commit()
    return jsonify(material=material.to_dict(), costs=_cost_summary(work_order))


@wo_bp.delete("/<int:wo_id>/materials/<int:material_id>")
@permission_required("work_orders:view")
def delete_material(wo_id, material_id):
    """DELETE /api/work-orders/<id>/materials/<material_id> - remove a logged
    material; material_cost is recalculated by the trigger. Not allowed once
    the work order is Verified/Closed."""
    work_order = _load_for_costs(wo_id)
    material = _load_material(work_order, material_id)
    snapshot = _material_snapshot(material)
    text = material_text(material)
    photo_ids = _photo_ids([material])
    db.session.delete(material)
    db.session.flush()                 # trigger recalculates work_orders.material_cost
    db.session.refresh(work_order)
    sync_history_if_finished(work_order)
    user = current_user()
    audit.record(user, "material.deleted", "material", material_id, wo_label(work_order),
                 f"{user.full_name} removed {text} from {wo_label(work_order)}",
                 {"work_order_id": work_order.id, **snapshot})
    db.session.commit()
    for public_id in photo_ids:
        photo_storage.destroy_quietly(public_id)
    return jsonify(message="Material removed", costs=_cost_summary(work_order))


@wo_bp.post("/<int:wo_id>/labour-cost")
@permission_required("work_orders:view")
def log_labour(wo_id):
    """POST /api/work-orders/<id>/labour-cost  {"hours": 2.5, "hourly_rate": 30}
    Adds hours to the work order. hourly_rate is required the first time
    (unless a rate was set on creation) and must match the work order's
    rate afterwards - a supervisor can correct it with PUT."""
    work_order = _load_for_costs(wo_id)
    data = get_json_body()
    reject_unknown_fields(data, {"hours", "hourly_rate"})
    require_fields(data, "hours")

    hours = parse_decimal(data["hours"], "hours", 0, Decimal("1000"), allow_zero=False)
    rate = (parse_decimal(data["hourly_rate"], "hourly_rate", 0, MAX_RATE)
            if data.get("hourly_rate") is not None else None)

    if rate is not None and rate != work_order.labour_rate:
        if work_order.labour_hours > 0:
            raise APIError(f"This work order's labour rate is {work_order.labour_rate}/h. "
                           f"Log hours at that rate, or ask a supervisor to change it", 409)
        work_order.labour_rate = rate
    elif rate is None and work_order.labour_rate == 0:
        raise APIError("'hourly_rate' is required - no rate is set on this work order yet", 400)

    new_total = work_order.labour_hours + hours
    if new_total > MAX_HOURS:
        raise APIError("Total labour hours would exceed the maximum", 400)
    work_order.labour_hours = new_total
    db.session.flush()
    sync_history_if_finished(work_order)
    user = current_user()
    audit.record(user, "labour.logged", "work_order", work_order.id, wo_label(work_order),
                 f"{user.full_name} logged {hours.normalize():f} h labour on {wo_label(work_order)}",
                 {"hours": audit._plain(hours), "hourly_rate": audit._plain(work_order.labour_rate),
                  "total_hours": audit._plain(new_total)})
    db.session.commit()

    return jsonify(message=f"Logged {hours} h", costs=_cost_summary(work_order))


# ----------------------------------------------------------- material photos
# A technician (or supervisor) attaches one photo per logged material. An
# experimental AI check compares it with the material's name - as a hint for
# the supervisor, who approves or rejects the photo themselves. Nothing here
# ever blocks the work-order workflow.

def _require_photos():
    if not photos_available():
        raise APIError("Material photos aren't set up on this server yet - an administrator needs to "
                       "run database/migrations/004_ratings_and_photos.sql", 503)


def _load_photo(material):
    if material.photo is None:
        raise APIError("This material has no photo", 404)
    return material.photo


@wo_bp.post("/<int:wo_id>/materials/<int:material_id>/photo")
@permission_required("work_orders:view")
def upload_material_photo(wo_id, material_id):
    """POST /api/work-orders/<id>/materials/<material_id>/photo
    multipart/form-data with one file field 'photo' (JPEG, PNG, WebP, HEIC or
    GIF, up to 10 MB). Replaces any existing photo and resets its AI check and
    review. Same rules as editing the material (costs must still be open).
    Run the AI check afterwards with POST .../photo/check."""
    _require_photos()
    # Photos are the one place a body may exceed the global 1 MB limit.
    request.max_content_length = photo_storage.MAX_BYTES + 64 * 1024
    work_order = _load_for_costs(wo_id)
    material = _load_material(work_order, material_id)

    file = request.files.get("photo")
    if file is None or not file.filename:
        raise APIError("Attach the image as a form field named 'photo'", 400)
    data = file.read(photo_storage.MAX_BYTES + 1)
    if not data:
        raise APIError("The photo file is empty", 400)
    if len(data) > photo_storage.MAX_BYTES:
        raise APIError(f"The photo must be at most {photo_storage.MAX_BYTES // (1024 * 1024)} MB", 413)
    if photo_storage.sniff_image_type(data) is None:
        raise APIError("The file isn't a supported image (JPEG, PNG, WebP, HEIC or GIF)", 400)

    stored = photo_storage.upload(data, work_order.id, material.id)
    user = current_user()
    photo = material.photo
    replaced = photo.public_id if photo else None
    if photo is None:
        photo = MaterialPhoto(material_id=material.id)
        db.session.add(photo)
    photo.public_id, photo.url = stored["public_id"], stored["url"]
    photo.width, photo.height, photo.bytes = stored["width"], stored["height"], stored["bytes"]
    photo.uploaded_by, photo.uploaded_at = user.id, db.func.now()
    photo.ai_status, photo.ai_note, photo.ai_detail = "pending", None, None
    photo.ai_checked_for = photo.ai_model = photo.ai_checked_at = None
    photo.review_status = photo.review_note = photo.reviewed_by = photo.reviewed_at = None
    audit.record(user, "material.photo_added", "material", material.id, wo_label(work_order),
                 f"{user.full_name} {'replaced the' if replaced else 'attached a'} photo of "
                 f"{material.material_name} on {wo_label(work_order)}",
                 {"work_order_id": work_order.id, "material_name": material.material_name})
    db.session.commit()
    if replaced:
        photo_storage.destroy_quietly(replaced)
    db.session.refresh(material)
    return jsonify(material=material.to_dict()), 201


@wo_bp.post("/<int:wo_id>/materials/<int:material_id>/photo/check")
@permission_required("work_orders:view")
def check_material_photo(wo_id, material_id):
    """POST .../photo/check - run the experimental AI consistency check.
    For whoever can log costs on this work order or review photos. Runs only
    when there's no usable result yet (never run, failed, or the material was
    renamed since), so repeated clicks don't re-bill the API."""
    _require_photos()
    user = current_user()
    if not (has_permission(user, "work_orders:log_costs") or has_permission(user, "work_orders:review_photos")):
        raise APIError("You do not have permission to check this photo", 403)
    work_order = _load_work_order(wo_id)
    material = _load_material(work_order, material_id)
    photo = _load_photo(material)

    fresh = (photo.ai_status in ("consistent", "unclear", "mismatch")
             and photo.ai_checked_for == material.material_name)
    if not fresh:
        photo_id, name, url = photo.id, material.material_name, photo.url
        result = photo_check.check(url, material)
        # The API call can take several seconds: re-read the photo under a
        # row lock and drop the result if it was replaced/removed meanwhile.
        db.session.commit()
        photo = db.session.get(MaterialPhoto, photo_id, with_for_update=True, populate_existing=True)
        if photo is None or photo.url != url:
            db.session.rollback()
            raise APIError("The photo changed while it was being checked - run the check again", 409)
        for key, value in result.items():
            setattr(photo, key, value)
        photo.ai_checked_for = name
        photo.ai_checked_at = db.func.now()
        db.session.commit()
    db.session.refresh(material)
    return jsonify(material=material.to_dict())


@wo_bp.patch("/<int:wo_id>/materials/<int:material_id>/photo/review")
@permission_required("work_orders:review_photos")
def review_material_photo(wo_id, material_id):
    """PATCH .../photo/review  {"decision": "Approved" | "Rejected" | null, "note"?}
    The supervisor's own judgement of the photo (null clears it). Recorded
    and audited; it doesn't change costs or status."""
    _require_photos()
    work_order = _load_work_order(wo_id, lock=True)
    material = _load_material(work_order, material_id)
    photo = _load_photo(material)
    data = get_json_body()
    reject_unknown_fields(data, {"decision", "note"})
    if "decision" not in data:
        raise APIError("Missing required field(s): decision", 400)
    decision = data["decision"]
    if decision is not None:
        validate_choice(decision, REVIEW_STATUSES, "decision")
    user = current_user()
    photo.review_status = decision
    photo.review_note = clean_str(data.get("note"), "note", 255) if decision else None
    photo.reviewed_by = user.id if decision else None
    photo.reviewed_at = db.func.now() if decision else None
    verb = decision.lower() if decision else "cleared the review of"
    audit.record(user, "material.photo_reviewed", "material", material.id, wo_label(work_order),
                 f"{user.full_name} {verb} the photo of {material.material_name} on {wo_label(work_order)}",
                 {"work_order_id": work_order.id, "decision": decision, "note": photo.review_note,
                  "ai_status": photo.ai_status})
    db.session.commit()
    db.session.refresh(material)
    return jsonify(material=material.to_dict())


@wo_bp.delete("/<int:wo_id>/materials/<int:material_id>/photo")
@permission_required("work_orders:view")
def delete_material_photo(wo_id, material_id):
    """DELETE .../photo - remove the photo (same rules as editing the material)."""
    _require_photos()
    work_order = _load_for_costs(wo_id)
    material = _load_material(work_order, material_id)
    photo = _load_photo(material)
    public_id = photo.public_id
    db.session.delete(photo)
    user = current_user()
    audit.record(user, "material.photo_removed", "material", material.id, wo_label(work_order),
                 f"{user.full_name} removed the photo of {material.material_name} from {wo_label(work_order)}",
                 {"work_order_id": work_order.id})
    db.session.commit()
    photo_storage.destroy_quietly(public_id)
    db.session.refresh(material)
    return jsonify(material=material.to_dict())
