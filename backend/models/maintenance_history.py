from extensions import db
from models.enums import MAINTENANCE_CATEGORIES


class MaintenanceHistory(db.Model):
    __tablename__ = "maintenance_history"

    id = db.Column(db.Integer, primary_key=True)
    machine_id = db.Column(db.Integer, db.ForeignKey("machines.id"), nullable=False)
    work_order_id = db.Column(db.Integer, db.ForeignKey("work_orders.id", ondelete="SET NULL"),
                              unique=True)
    maintenance_type = db.Column(db.Enum(*MAINTENANCE_CATEGORIES, name="history_type"),
                                 nullable=False)
    maintenance_date = db.Column(db.Date, nullable=False)
    performed_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    work_performed = db.Column(db.Text, nullable=False)
    downtime_hours = db.Column(db.Numeric(8, 2), nullable=False, server_default="0")
    labour_cost = db.Column(db.Numeric(12, 2), nullable=False, server_default="0")
    material_cost = db.Column(db.Numeric(12, 2), nullable=False, server_default="0")
    # Calculated by MySQL - never assign from Python.
    total_cost = db.Column(db.Numeric(12, 2),
                           db.Computed("labour_cost + material_cost", persisted=True))
    remarks = db.Column(db.Text)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())

    machine = db.relationship("Machine", back_populates="maintenance_history")
    work_order = db.relationship("WorkOrder")
    technician = db.relationship("User")

    def to_dict(self):
        from models.work_order import to_iso, to_number
        wo = self.work_order
        return {
            "id": self.id,
            "machine_id": self.machine_id,
            # None for manual log notes, or if the work order was deleted.
            "work_order": ({"id": wo.id, "title": wo.title, "status": wo.status,
                            "priority": wo.priority} if wo else None),
            "maintenance_type": self.maintenance_type,
            "maintenance_date": to_iso(self.maintenance_date),
            "performed_by": ({"id": self.technician.id, "full_name": self.technician.full_name,
                              "username": self.technician.username} if self.technician else None),
            "work_performed": self.work_performed,
            "downtime_hours": to_number(self.downtime_hours),
            "labour_cost": to_number(self.labour_cost),
            "material_cost": to_number(self.material_cost),
            "total_cost": to_number(self.total_cost),
            "remarks": self.remarks,
            "created_at": to_iso(self.created_at),
        }

    def __repr__(self):
        return f"<MaintenanceHistory machine={self.machine_id} {self.maintenance_date}>"
