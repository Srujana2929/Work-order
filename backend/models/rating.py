from extensions import db


class TechnicianRating(db.Model):
    """Optional 1-5 star rating of a technician's work on one work order."""
    __tablename__ = "technician_ratings"

    id = db.Column(db.Integer, primary_key=True)
    work_order_id = db.Column(db.Integer, db.ForeignKey("work_orders.id", ondelete="SET NULL"), unique=True)
    technician_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    rated_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    stars = db.Column(db.SmallInteger, nullable=False)
    comment = db.Column(db.String(500))
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())
    updated_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now(),
                           server_onupdate=db.FetchedValue())

    work_order = db.relationship("WorkOrder")
    rater = db.relationship("User", foreign_keys=[rated_by])

    def to_dict(self):
        from models.work_order import to_iso
        wo = self.work_order
        return {
            "id": self.id,
            "work_order": {"id": wo.id, "title": wo.title} if wo else None,
            "technician_id": self.technician_id,
            "stars": self.stars,
            "comment": self.comment,
            "rated_by": ({"id": self.rater.id, "full_name": self.rater.full_name} if self.rater else None),
            "created_at": to_iso(self.created_at),
            "updated_at": to_iso(self.updated_at),
        }
