"""Keeps each machine's maintenance history in step with its work orders.

A work order gets exactly one history entry (maintenance_history.work_order_id
is UNIQUE):
  - created when it reaches Completed,
  - refreshed on Verified / Closed, and whenever its costs or details change
    while it is still Completed,
  - removed if a supervisor sends it back for rework (the work isn't done).
Costs are copied into the entry, so history survives even if the work order
is later deleted.

Call these after db.session.flush() so generated columns (labour_cost,
total_cost), trigger-maintained material_cost and completed_at are current.
"""
from extensions import db
from models import MaintenanceHistory

HISTORY_STATUSES = ("Completed", "Verified", "Closed")


def _default_work_performed(work_order):
    if work_order.description:
        return f"{work_order.title}: {work_order.description}"
    return work_order.title


def upsert_history(work_order, work_performed=None, downtime_hours=None, remarks=None):
    """Create or refresh the history entry for a finished work order."""
    # Read everything from the work order first: these attributes may be
    # expired and reloading them autoflushes the session, which must not
    # happen while a half-filled entry is pending.
    snapshot = {
        "machine_id": work_order.machine_id,
        "maintenance_type": work_order.category,
        "maintenance_date": work_order.completed_at.date(),
        "performed_by": work_order.assigned_technician_id,
        "labour_cost": work_order.labour_cost,
        "material_cost": work_order.material_cost,
    }

    entry = MaintenanceHistory.query.filter_by(work_order_id=work_order.id).first()
    if entry is None:
        entry = MaintenanceHistory(work_order_id=work_order.id,
                                   work_performed=_default_work_performed(work_order),
                                   **snapshot)
        db.session.add(entry)
    else:
        for field, value in snapshot.items():
            setattr(entry, field, value)

    # Notes: new values win; otherwise keep what's there.
    if work_performed:
        entry.work_performed = work_performed
    if downtime_hours is not None:
        entry.downtime_hours = downtime_hours
    if remarks:
        entry.remarks = remarks
    return entry


def sync_history_if_finished(work_order):
    """Refresh the snapshot after an edit/cost change on a finished work order."""
    if work_order.status in HISTORY_STATUSES:
        upsert_history(work_order)


def remove_history(work_order):
    MaintenanceHistory.query.filter_by(work_order_id=work_order.id).delete()
