from datetime import date

from extensions import db
from models.enums import MAINTENANCE_CATEGORIES, PRIORITIES, WORK_ORDER_STATUSES


class WorkOrder(db.Model):
    __tablename__ = "work_orders"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(150), nullable=False)
    description = db.Column(db.Text)
    machine_id = db.Column(db.Integer, db.ForeignKey("machines.id"), nullable=False)
    department = db.Column(db.String(100), nullable=False)
    category = db.Column(db.Enum(*MAINTENANCE_CATEGORIES, name="wo_category"), nullable=False,
                         server_default="Corrective")
    priority = db.Column(db.Enum(*PRIORITIES, name="wo_priority"), nullable=False,
                         server_default="Medium")
    status = db.Column(db.Enum(*WORK_ORDER_STATUSES, name="wo_status"), nullable=False,
                       server_default="Pending")
    assigned_technician_id = db.Column(db.Integer, db.ForeignKey("users.id"))
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    verified_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    progress = db.Column(db.SmallInteger, nullable=False, server_default="0")

    labour_hours = db.Column(db.Numeric(8, 2), nullable=False, server_default="0")
    labour_rate = db.Column(db.Numeric(10, 2), nullable=False, server_default="0")
    # Calculated by MySQL - never assign these from Python.
    labour_cost = db.Column(db.Numeric(12, 2),
                            db.Computed("ROUND(labour_hours * labour_rate, 2)", persisted=True))
    # Maintained by the materials triggers. After adding/removing materials,
    # call db.session.refresh(work_order) to see the new value.
    material_cost = db.Column(db.Numeric(12, 2), nullable=False, server_default="0",
                              server_onupdate=db.FetchedValue())
    total_cost = db.Column(db.Numeric(12, 2),
                           db.Computed("labour_cost + material_cost", persisted=True))

    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())
    due_date = db.Column(db.Date)
    started_at = db.Column(db.DateTime)
    completed_at = db.Column(db.DateTime)
    verified_at = db.Column(db.DateTime)
    closed_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now(),
                           server_onupdate=db.FetchedValue())

    machine = db.relationship("Machine", back_populates="work_orders")
    technician = db.relationship("User", foreign_keys=[assigned_technician_id])
    creator = db.relationship("User", foreign_keys=[created_by])
    verifier = db.relationship("User", foreign_keys=[verified_by])
    # passive_deletes: let MySQL's ON DELETE CASCADE remove the materials.
    materials = db.relationship("Material", back_populates="work_order",
                                cascade="all, delete-orphan", passive_deletes=True)

    @property
    def is_overdue(self):
        return (self.due_date is not None
                and self.status not in FINISHED_STATUSES
                and self.due_date < date.today())

    def to_dict(self, include_materials=False):
        data = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "machine": self.machine.to_summary() if self.machine else None,
            "department": self.department,
            "category": self.category,
            "priority": self.priority,
            "status": self.status,
            "progress": self.progress,
            "assigned_technician": _user_summary(self.technician),
            "created_by": _user_summary(self.creator),
            "verified_by": _user_summary(self.verifier),
            # Costs are calculated by MySQL (generated columns + triggers).
            "labour_hours": to_number(self.labour_hours),
            "labour_rate": to_number(self.labour_rate),
            "labour_cost": to_number(self.labour_cost),
            "material_cost": to_number(self.material_cost),
            "total_cost": to_number(self.total_cost),
            "created_at": to_iso(self.created_at),
            "due_date": to_iso(self.due_date),
            "is_overdue": self.is_overdue,
            "started_at": to_iso(self.started_at),
            "completed_at": to_iso(self.completed_at),
            "verified_at": to_iso(self.verified_at),
            "closed_at": to_iso(self.closed_at),
            "updated_at": to_iso(self.updated_at),
        }
        if include_materials:
            data["materials"] = [m.to_dict() for m in
                                 sorted(self.materials, key=lambda m: m.id)]
        return data

    def __repr__(self):
        return f"<WorkOrder #{self.id} {self.status}>"


FINISHED_STATUSES = ("Completed", "Verified", "Closed")


def to_number(value):
    """Decimal -> float for JSON (None stays None)."""
    return float(value) if value is not None else None


def to_iso(value):
    return value.isoformat() if value is not None else None


def _user_summary(user):
    if user is None:
        return None
    return {"id": user.id, "full_name": user.full_name, "username": user.username}
