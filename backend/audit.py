"""Audit log: record who did what, when, to which record.

Call record(...) inside the request, before db.session.commit(): the entry is
written in the same transaction as the change it describes, so an action and
its log entry either both happen or neither does.

If the audit_log table is missing (migration 002 not run yet), auditing is
disabled with a warning instead of breaking every action.
"""
import time

from flask import current_app, request
from sqlalchemy import inspect

from extensions import db
from models import AuditLog

# Every action the app records - also the filter options in the Activity Log.
ACTIONS = {
    "work_order.created":        "Work order created",
    "work_order.updated":        "Work order edited",
    "work_order.status_changed": "Work order status changed",
    "work_order.deleted":        "Work order deleted",
    "material.added":            "Material added",
    "material.updated":          "Material edited",
    "material.deleted":          "Material deleted",
    "labour.logged":             "Labour logged",
    "machine.created":           "Machine registered",
    "machine.updated":           "Machine edited",
    "machine.retired":           "Machine retired",
    "machine.reactivated":       "Machine reactivated",
    "maintenance.note_added":    "Maintenance note added",
    "user.created":              "User created",
    "user.updated":              "User edited",
    "user.deactivated":          "User deactivated",
    "user.reactivated":          "User reactivated",
    "user.password_reset":       "Password reset by admin",
    "user.password_changed":     "Password changed",
}

_available = False
_checked_at = 0.0


def audit_available():
    """True when the audit_log table exists. Once found it's cached; while
    missing it's re-checked every 30 s, so running the migration takes effect
    without restarting the app."""
    global _available, _checked_at
    if _available or time.monotonic() - _checked_at < 30:
        return _available
    _checked_at = time.monotonic()
    _available = inspect(db.engine).has_table("audit_log")
    if not _available:
        current_app.logger.warning(
            "audit_log table not found - activity is NOT being recorded. "
            "Run database/migrations/002_audit_log.sql as root.")
    return _available


def record(actor, action, entity_type, entity_id, entity_label, summary, details=None):
    """Add an audit entry to the current transaction (committed with the change)."""
    if action not in ACTIONS:
        raise ValueError(f"Unknown audit action '{action}'")
    if not audit_available():
        return
    db.session.add(AuditLog(
        actor_id=actor.id if actor else None,
        actor_name=(actor.full_name if actor else "System")[:100],
        actor_role=actor.role if actor else "System",
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_label=(entity_label or "")[:150] or None,
        summary=summary[:255],
        details=details or None,
        ip_address=(request.remote_addr or "")[:45] or None,
    ))


def changes(before, after):
    """{field: {"from": old, "to": new}} for fields whose value changed."""
    diff = {}
    for key, new in after.items():
        old = before.get(key)
        if _plain(old) != _plain(new):
            diff[key] = {"from": _plain(old), "to": _plain(new)}
    return diff


def _plain(value):
    """JSON-safe version of a value (Decimal -> float, date -> ISO string)."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    try:
        return float(value)
    except (TypeError, ValueError):
        return str(value)
