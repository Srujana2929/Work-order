from extensions import db


class AuditLog(db.Model):
    """Append-only activity record. The app only ever inserts rows."""
    __tablename__ = "audit_log"

    id = db.Column(db.BigInteger, primary_key=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now(3))
    actor_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    actor_name = db.Column(db.String(100), nullable=False)
    actor_role = db.Column(db.String(20), nullable=False)
    action = db.Column(db.String(40), nullable=False)
    entity_type = db.Column(db.String(30), nullable=False)
    entity_id = db.Column(db.Integer)
    entity_label = db.Column(db.String(150))
    summary = db.Column(db.String(255), nullable=False)
    details = db.Column(db.JSON)
    ip_address = db.Column(db.String(45))

    def to_dict(self):
        from models.work_order import to_iso
        return {
            "id": self.id,
            "created_at": to_iso(self.created_at),
            "actor": {"id": self.actor_id, "name": self.actor_name, "role": self.actor_role},
            "action": self.action,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "entity_label": self.entity_label,
            "summary": self.summary,
            "details": self.details,
        }
