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
    # One optional photo (migration 004). passive_deletes: MySQL's ON DELETE
    # CASCADE removes it - and the ORM never touches the table on delete, so
    # deleting a material works before the migration has run.
    photo = db.relationship("MaterialPhoto", back_populates="material", uselist=False,
                            cascade="all, delete-orphan", passive_deletes=True)

    def to_dict(self):
        from models.work_order import to_iso, to_number
        from schema_check import photos_available
        photo = self.photo if photos_available() else None
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
            "photo": photo.to_dict() if photo else None,
        }

    def __repr__(self):
        return f"<Material {self.material_name} x{self.quantity}>"
