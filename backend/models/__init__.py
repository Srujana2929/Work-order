"""ORM models. database/schema.sql is the source of truth for the tables;
these classes mirror it (do not use db.create_all())."""
from models.user import User
from models.machine import Machine
from models.work_order import WorkOrder
from models.material import Material
from models.maintenance_history import MaintenanceHistory
from models.audit_log import AuditLog
from models.login_attempt import LoginAttempt
from models.rating import TechnicianRating
from models.material_photo import MaterialPhoto

__all__ = ["User", "Machine", "WorkOrder", "Material", "MaintenanceHistory", "AuditLog", "LoginAttempt",
           "TechnicianRating", "MaterialPhoto"]
