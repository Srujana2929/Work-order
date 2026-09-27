"""JSON error responses for the API."""
from flask import jsonify
from sqlalchemy.exc import DBAPIError
from werkzeug.exceptions import HTTPException

from extensions import db


class APIError(Exception):
    """Raise from anywhere in a request to return {"error": message} with a status code."""

    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details


def _error_response(message, status, details=None):
    body = {"error": message}
    if details:
        body["details"] = details
    response = jsonify(body)
    response.status_code = status
    if status == 401:
        response.headers["WWW-Authenticate"] = "Bearer"
    return response


def register_error_handlers(app):
    @app.errorhandler(APIError)
    def handle_api_error(exc):
        response = _error_response(exc.message, exc.status, exc.details)
        if getattr(exc, "retry_after", None):
            response.headers["Retry-After"] = str(exc.retry_after)
        return response

    @app.errorhandler(413)
    def handle_too_large(exc):
        limit_kb = app.config.get("MAX_CONTENT_LENGTH", 0) // 1024
        return _error_response(f"Request body is too large (limit {limit_kb} KB)", 413)

    @app.errorhandler(HTTPException)
    def handle_http_exception(exc):
        # Unknown routes, wrong methods, malformed requests, etc.
        return _error_response(exc.description, exc.code)

    @app.errorhandler(DBAPIError)
    def handle_db_error(exc):
        # Safety net: routes validate input first, so reaching here means a
        # database rule caught something the route didn't.
        db.session.rollback()
        code = exc.orig.args[0] if exc.orig is not None and exc.orig.args else None
        if code == 1644:   # SIGNAL from a trigger - its message is meant for users
            return _error_response(str(exc.orig.args[1]), 400)
        if code == 3819:   # CHECK constraint
            return _error_response("The request violates a data rule", 400,
                                   {"db_message": str(exc.orig.args[1])})
        if code == 1062:
            return _error_response("A record with that value already exists", 409)
        if code in (1406, 1264, 1292, 1366):   # too long / out of range / bad date / bad value
            app.logger.warning("Value rejected by MySQL: %s", exc.orig)
            return _error_response("A value is too long or out of range", 400,
                                   {"db_message": str(exc.orig.args[1])})
        if code == 1048:   # NOT NULL - a bug if it happens, but say what's missing
            app.logger.exception("NOT NULL violation", exc_info=exc)
            return _error_response("A required value was missing", 400,
                                   {"db_message": str(exc.orig.args[1])})
        if code in (1451, 1452):
            return _error_response("The request conflicts with related records", 409)
        if code in (2003, 2006, 2013):
            return _error_response("Database unavailable - try again shortly", 503)
        app.logger.exception("Database error", exc_info=exc)
        return _error_response("Internal server error", 500)

    @app.errorhandler(500)
    def handle_server_error(exc):
        app.logger.exception("Unhandled error", exc_info=getattr(exc, "original_exception", exc))
        return _error_response("Internal server error", 500)
