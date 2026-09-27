"""Flask application entry point.

Local dev:   python app.py   then open http://127.0.0.1:5000
Production:  gunicorn app:app  (see ../Procfile) - binds 0.0.0.0:$PORT
Serves the API under /api and the frontend (../frontend) at /.
"""
import mimetypes
import os
from pathlib import Path

from flask import Flask, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

from config import get_config
from errors import register_error_handlers
from extensions import db

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Windows sometimes maps .js to text/plain in the registry, which makes
# browsers refuse to run ES modules. Pin the correct types.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


def create_app(config_class=None):
    # Frontend files are served from the site root: /css/app.css, /js/app.js ...
    app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
    app.config.from_object(config_class or get_config())

    # Railway (like most PaaS) terminates HTTPS at a proxy in front of the app
    # and forwards the real client IP/scheme via X-Forwarded-*. Trust exactly
    # one hop so request.remote_addr (login throttling, audit log IPs) and the
    # detected scheme reflect the real client instead of the proxy.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

    db.init_app(app)
    register_error_handlers(app)

    # Import models so SQLAlchemy knows about every table.
    import models  # noqa: F401

    from routes import register_blueprints
    register_blueprints(app)

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    return app


# Module-level instance: gunicorn imports this file and looks for `app` on it
# (see Procfile: `gunicorn ... app:app`); the dev server below reuses it too.
app = create_app()

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=app.config["DEBUG"],
    )
