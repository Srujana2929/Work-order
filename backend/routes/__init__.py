"""Blueprint registration."""
from routes.assistant import assistant_bp
from routes.audit_log import audit_bp
from routes.auth import auth_bp
from routes.dashboard import dashboard_bp
from routes.health import health_bp
from routes.machines import machines_bp
from routes.users import users_bp
from routes.work_orders import wo_bp


def register_blueprints(app):
    app.register_blueprint(health_bp, url_prefix="/api")
    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(users_bp, url_prefix="/api/users")
    app.register_blueprint(wo_bp, url_prefix="/api/work-orders")
    app.register_blueprint(machines_bp, url_prefix="/api/machines")
    app.register_blueprint(dashboard_bp, url_prefix="/api/dashboard")
    app.register_blueprint(audit_bp, url_prefix="/api/audit-log")
    app.register_blueprint(assistant_bp, url_prefix="/api/assistant")
