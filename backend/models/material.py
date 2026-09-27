from extensions import db


class Material(db.Model):
    __tablename__ = "materials"

    id = db.Column(db.Integer, primary_key=True)
    work_order_id = db.Column(db.Integer, db.ForeignKey("work_orders.id", ondelete="CASCADE"),
                              nullable=False)
    material_name = db.Column(db.String(120), nullable=False)
    part_number = db.Column(db.String(60))
    quantity = db.Column(db.Numeric(10, 2), nullable=False)
    unit = db.Column(db.String(20), nullable=False, server_default="pcs")
    unit_cost = db.Column(db.Numeric(10, 2), nullable=False, server_default="0")
    # Calculated by MySQL - never assign from Python.
    line_total = db.Column(db.Numeric(12, 2),
                           db.Computed("ROUND(quantity * unit_cost, 2)", persisted=True))
    added_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())

    work_order = db.relationship("WorkOrder", back_populates="materials")

    added_by_user = db.relationship("User")

    def to_dict(self):
        from models.work_order import to_iso, to_number
        return {
            "id": self.id,
            "work_order_id": self.work_order_id,
            "material_name": self.material_name,
            "part_number": self.part_number,
            "quantity": to_number(self.quantity),
            "unit": self.unit,
            "unit_cost": to_number(self.unit_cost),
            "line_total": to_number(self.line_total),
            "added_by": ({"id": self.added_by_user.id, "full_name": self.added_by_user.full_name}
                         if self.added_by_user else None),
            "created_at": to_iso(self.created_at),
        }

    def __repr__(self):
        return f"<Material {self.material_name} x{self.quantity}>"
