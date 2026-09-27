"""Activity log (Admin only): read-only view of the audit_log table."""
from datetime import timedelta

from flask import Blueprint, jsonify, request
from sqlalchemy import func, or_

from audit import ACTIONS, audit_available
from auth.rbac import permission_required
from errors import APIError
from extensions import db
from models import AuditLog
from validation import like_pattern, parse_date, parse_int, parse_page_args

audit_bp = Blueprint("audit_log", __name__)

CATEGORIES = sorted({a.split(".")[0] for a in ACTIONS})


def _require_table():
    if not audit_available():
        raise APIError("The activity log isn't set up yet. Run database/migrations/002_audit_log.sql "
                       "as root (see README), then try again.", 503)


@audit_bp.get("")
@permission_required("audit:view")
def list_entries():
    """GET /api/audit-log
    Filters: actor_id, action (comma-separated action keys), category
    (work_order | material | labour | machine | maintenance | user),
    entity_type + entity_id, date_from / date_to (YYYY-MM-DD, inclusive),
    q (search the summary text). Paging: per_page (max 100) plus either
    before_id (id of the last entry shown - use for "load older") or page.
    Newest first."""
    _require_table()
    args = request.args
    query = AuditLog.query

    if args.get("actor_id"):
        query = query.filter(AuditLog.actor_id == parse_int(args["actor_id"], "actor_id", minimum=1))
    if args.get("action"):
        actions = [a.strip() for a in args["action"].split(",") if a.strip()]
        unknown = [a for a in actions if a not in ACTIONS]
        if unknown:
            raise APIError(f"Unknown action(s): {', '.join(unknown)}", 400)
        query = query.filter(AuditLog.action.in_(actions))
    if args.get("category"):
        if args["category"] not in CATEGORIES:
            raise APIError(f"'category' must be one of: {', '.join(CATEGORIES)}", 400)
        query = query.filter(AuditLog.action.like(args["category"] + ".%"))
    if args.get("entity_type"):
        query = query.filter(AuditLog.entity_type == args["entity_type"][:30])
    if args.get("entity_id"):
        query = query.filter(AuditLog.entity_id == parse_int(args["entity_id"], "entity_id", minimum=1))

    date_from = parse_date(args.get("date_from"), "date_from")
    date_to = parse_date(args.get("date_to"), "date_to")
    if date_from and date_to and date_from > date_to:
        raise APIError("'date_from' must be on or before 'date_to'", 400)
    if date_from:
        query = query.filter(AuditLog.created_at >= date_from)
    if date_to:
        query = query.filter(AuditLog.created_at < date_to + timedelta(days=1))

    # Cursor for "load older": entries before this id. Stable even while new
    # activity is being written (page numbers would shift).
    if args.get("before_id"):
        query = query.filter(AuditLog.id < parse_int(args["before_id"], "before_id", minimum=1, maximum=2 ** 63 - 1))

    search = (args.get("q") or "").strip()
    if search:
        like = like_pattern(search[:100])
        query = query.filter(or_(AuditLog.summary.like(like, escape="\\"),
                                 AuditLog.entity_label.like(like, escape="\\")))

    page, per_page = parse_page_args(args, default_per_page=50)
    result = query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).paginate(
        page=page, per_page=per_page, error_out=False)
    return jsonify(
        entries=[e.to_dict() for e in result.items],
        pagination={"page": result.page, "per_page": result.per_page,
                    "total": result.total, "pages": result.pages},
    )


@audit_bp.get("/filters")
@permission_required("audit:view")
def filter_options():
    """GET /api/audit-log/filters - options for the Activity Log filters:
    every action type, and everyone who appears in the log."""
    _require_table()
    actors = (db.session.query(AuditLog.actor_id, AuditLog.actor_name, AuditLog.actor_role,
                               func.max(AuditLog.created_at))
              .group_by(AuditLog.actor_id, AuditLog.actor_name, AuditLog.actor_role)
              .order_by(AuditLog.actor_name).all())
    return jsonify(
        actions=[{"key": k, "label": v, "category": k.split(".")[0]} for k, v in ACTIONS.items()],
        categories=CATEGORIES,
        actors=[{"id": a[0], "name": a[1], "role": a[2]} for a in actors if a[0] is not None],
    )
