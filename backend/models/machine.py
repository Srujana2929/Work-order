from extensions import db
from models.enums import MACHINE_STATUSES


class Machine(db.Model):
    __tablename__ = "machines"

    id = db.Column(db.Integer, primary_key=True)
    machine_code = db.Column(db.String(30), nullable=False, unique=True)
    name = db.Column(db.String(120), nullable=False)
    department = db.Column(db.String(100), nullable=False)
    location = db.Column(db.String(120))
    manufacturer = db.Column(db.String(100))
    model = db.Column(db.String(100))
    serial_number = db.Column(db.String(100), unique=True)
    install_date = db.Column(db.Date)
    status = db.Column(db.Enum(*MACHINE_STATUSES, name="machine_status"), nullable=False,
                       server_default="Operational")
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())
    updated_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now(),
                           server_onupdate=db.FetchedValue())

    work_orders = db.relationship("WorkOrder", back_populates="machine", lazy="dynamic")
    maintenance_history = db.relationship(
        "MaintenanceHistory", back_populates="machine", lazy="dynamic",
        order_by="MaintenanceHistory.maintenance_date.desc()",
    )

    def to_dict(self):
        from models.work_order import to_iso
        return {
            "id": self.id,
            "machine_code": self.machine_code,
            "name": self.name,
            "department": self.department,
            "location": self.location,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "serial_number": self.serial_number,
            "install_date": to_iso(self.install_date),
            "status": self.status,
            "created_at": to_iso(self.created_at),
            "updated_at": to_iso(self.updated_at),
        }

    def to_summary(self):
        return {"id": self.id, "machine_code": self.machine_code, "name": self.name,
                "department": self.department, "status": self.status}

    def __repr__(self):
        return f"<Machine {self.machine_code}>"
