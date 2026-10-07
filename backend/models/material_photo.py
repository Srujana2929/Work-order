from extensions import db

AI_STATUSES = ("pending", "consistent", "unclear", "mismatch", "unavailable", "error")
REVIEW_STATUSES = ("Approved", "Rejected")


class MaterialPhoto(db.Model):
    """Photo attached to a logged material (stored in Cloudinary), with the
    experimental AI consistency hint and the supervisor's own review."""
    __tablename__ = "material_photos"

    id = db.Column(db.Integer, primary_key=True)
    material_id = db.Column(db.Integer, db.ForeignKey("materials.id", ondelete="CASCADE"),
                            nullable=False, unique=True)
    public_id = db.Column(db.String(255), nullable=False)
    url = db.Column(db.String(500), nullable=False)
    width = db.Column(db.Integer)
    height = db.Column(db.Integer)
    bytes = db.Column(db.Integer)
    uploaded_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    uploaded_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())

    ai_status = db.Column(db.Enum(*AI_STATUSES, name="photo_ai_status"), nullable=False,
                          server_default="pending")
    ai_note = db.Column(db.String(500))
    ai_detail = db.Column(db.String(500))
    ai_checked_for = db.Column(db.String(120))
    ai_model = db.Column(db.String(60))
    ai_checked_at = db.Column(db.DateTime)

    review_status = db.Column(db.Enum(*REVIEW_STATUSES, name="photo_review_status"))
    review_note = db.Column(db.String(255))
    reviewed_by = db.Column(db.Integer, db.ForeignKey("users.id"))
    reviewed_at = db.Column(db.DateTime)

    material = db.relationship("Material", back_populates="photo")
    uploader = db.relationship("User", foreign_keys=[uploaded_by])
    reviewer = db.relationship("User", foreign_keys=[reviewed_by])

    def to_dict(self):
        from models.work_order import to_iso
        person = lambda u: {"id": u.id, "full_name": u.full_name} if u else None  # noqa: E731
        return {
            "url": self.url,
            # Same image, small square crop (swaps the delivery transformation set in photo_storage).
            "thumb_url": self.url.replace("/c_limit,h_1600,q_auto,w_1600/", "/c_fill,g_auto,h_160,q_auto,w_160/"),
            "width": self.width,
            "height": self.height,
            "bytes": self.bytes,
            "uploaded_by": person(self.uploader),
            "uploaded_at": to_iso(self.uploaded_at),
            "ai_check": {
                "status": self.ai_status,
                "note": self.ai_note,
                "detail": self.ai_detail,
                "checked_for": self.ai_checked_for,
                "model": self.ai_model,
                "checked_at": to_iso(self.ai_checked_at),
            },
            "review": {
                "status": self.review_status,
                "note": self.review_note,
                "reviewed_by": person(self.reviewer),
                "reviewed_at": to_iso(self.reviewed_at),
            },
        }
