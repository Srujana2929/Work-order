from functools import lru_cache

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import or_, text
from werkzeug.security import check_password_hash, generate_password_hash

import audit
import ratings
from auth.rbac import current_user, login_required
from auth.tokens import clear_auth_cookie, create_access_token, set_auth_cookie
from errors import APIError
from extensions import db
from models import User
from validation import get_json_body, reject_unknown_fields, require_fields, validate_password

auth_bp = Blueprint("auth", __name__)


@lru_cache(maxsize=1)
def _dummy_hash():
    return generate_password_hash("timing-equaliser")


def _token_response(user, **extra):
    """JSON with the token (for API clients) + the HttpOnly cookie (for the browser)."""
    token, expires_in = create_access_token(user)
    response = jsonify(
        access_token=token,
        token_type="Bearer",
        expires_in=expires_in,
        user=user.to_dict(),
        **extra,
    )
    set_auth_cookie(response, token, expires_in)
    return response


# ---- Login throttling (persisted in MySQL, table login_attempts) ---------
# Failed attempts per (username, client IP). Stored in the database - not in
# memory - so the limit holds across every gunicorn worker/process and
# survives restarts (in production, several worker processes each keeping
# their own in-memory counter would let an attacker get LOGIN_MAX_FAILURES
# guesses per worker instead of in total, and a redeploy would reset it).
# All timing is computed by MySQL (NOW()) so it can't drift from app-server
# clocks.


def _throttle_identity(identifier):
    return identifier.lower(), (request.remote_addr or "?")


def _check_throttle(username, ip):
    window = current_app.config["LOGIN_LOCKOUT_SECONDS"]
    count, oldest, db_now = db.session.execute(
        text(
            "SELECT COUNT(*), MIN(attempted_at), NOW(3) FROM login_attempts "
            "WHERE username = :username AND ip_address = :ip "
            "  AND attempted_at > NOW(3) - INTERVAL :window SECOND"
        ),
        {"username": username, "ip": ip, "window": window},
    ).one()
    if count >= current_app.config["LOGIN_MAX_FAILURES"]:
        retry = int(window - (db_now - oldest).total_seconds()) + 1
        minutes = max(1, -(-retry // 60))        # round up
        err = APIError(f"Too many failed sign-in attempts. Try again in {minutes} minute{'s' if minutes != 1 else ''}.", 429)
        err.retry_after = max(retry, 1)
        raise err


def _record_failure(username, ip):
    window = current_app.config["LOGIN_LOCKOUT_SECONDS"]
    # Opportunistic global cleanup so the table doesn't grow unbounded -
    # cheap here since it only runs on a wrong password, not every login.
    db.session.execute(
        text("DELETE FROM login_attempts WHERE attempted_at <= NOW(3) - INTERVAL :window SECOND"),
        {"window": window},
    )
    db.session.execute(
        text("INSERT INTO login_attempts (username, ip_address) VALUES (:username, :ip)"),
        {"username": username, "ip": ip},
    )
    db.session.commit()


def _clear_failures(username, ip):
    db.session.execute(
        text("DELETE FROM login_attempts WHERE username = :username AND ip_address = :ip"),
        {"username": username, "ip": ip},
    )
    db.session.commit()


@auth_bp.post("/login")
def login():
    """POST /api/auth/login  {"username": "...", "password": "..."}
    `username` may also be the user's email address.
    After LOGIN_MAX_FAILURES wrong passwords for the same username from the
    same IP, further attempts get 429 until LOGIN_LOCKOUT_SECONDS pass."""
    data = get_json_body()
    require_fields(data, "username", "password")
    if not isinstance(data["username"], str) or not isinstance(data["password"], str):
        raise APIError("'username' and 'password' must be strings", 400)
    identifier = data["username"].strip()
    password = data["password"]
    if len(identifier) > 120 or len(password) > 256:
        raise APIError("Invalid username or password", 401)

    username, ip = _throttle_identity(identifier)
    _check_throttle(username, ip)

    user = User.query.filter(
        or_(User.username == identifier, User.email == identifier.lower())
    ).first()

    if user is None:
        # Hash anyway so response time doesn't reveal whether the user exists.
        check_password_hash(_dummy_hash(), password)
        _record_failure(username, ip)
        raise APIError("Invalid username or password", 401)
    if not user.check_password(password):
        _record_failure(username, ip)
        raise APIError("Invalid username or password", 401)
    if not user.is_active:
        raise APIError("Account is deactivated - contact an administrator", 403)

    _clear_failures(username, ip)
    return _token_response(user)


@auth_bp.post("/logout")
def logout():
    """POST /api/auth/logout - clears the browser session cookie."""
    response = jsonify(message="Logged out")
    clear_auth_cookie(response)
    return response


@auth_bp.get("/me")
@login_required
def me():
    """GET /api/auth/me - the logged-in user (technicians: plus their own
    rating average, or null before migration 004)."""
    user = current_user()
    body = user.to_dict()
    if user.role == "Technician":
        summary = ratings.summaries([user.id])
        body["rating"] = summary[user.id] if summary else None
    return jsonify(user=body)


@auth_bp.post("/change-password")
@login_required
def change_password():
    """POST /api/auth/change-password  {"current_password": "...", "new_password": "..."}
    Returns a fresh token; all previously issued tokens stop working."""
    data = get_json_body()
    reject_unknown_fields(data, {"current_password", "new_password"})
    require_fields(data, "current_password", "new_password")
    user = current_user()

    if not user.check_password(str(data["current_password"])):
        raise APIError("Current password is incorrect", 400)
    new_password = validate_password(data["new_password"], "new_password")
    if user.check_password(new_password):
        raise APIError("New password must be different from the current one", 400)

    user.set_password(new_password)
    audit.record(user, "user.password_changed", "user", user.id, user.username,
                 f"{user.full_name} changed their password")
    db.session.commit()
    return _token_response(user, message="Password changed")
