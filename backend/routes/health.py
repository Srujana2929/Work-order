from flask import Blueprint, jsonify
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from extensions import db

health_bp = Blueprint("health", __name__)


@health_bp.get("/health")
def health():
    """GET /api/health - reports whether the database is reachable."""
    try:
        db.session.execute(text("SELECT 1"))
        return jsonify(status="ok", database="connected")
    except SQLAlchemyError as exc:
        return jsonify(status="error", database="unreachable",
                       detail=str(exc.__cause__ or exc)), 503
