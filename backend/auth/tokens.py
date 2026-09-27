"""Create and verify JWT access tokens (HS256, signed with SECRET_KEY)."""
import hashlib
import hmac
from datetime import datetime, timedelta, timezone

import jwt
from flask import current_app

ALGORITHM = "HS256"


def _password_fingerprint(user):
    # Changes whenever the user's password changes, so tokens issued before a
    # password change/reset stop working - without storing tokens anywhere.
    return hashlib.sha256(user.password_hash.encode()).hexdigest()[:16]


def create_access_token(user):
    """Return (token, expires_in_seconds)."""
    now = datetime.now(timezone.utc)
    lifetime = timedelta(minutes=current_app.config["JWT_EXPIRES_MINUTES"])
    payload = {
        "sub": str(user.id),
        "pwd": _password_fingerprint(user),
        "iat": now,
        "exp": now + lifetime,
    }
    token = jwt.encode(payload, current_app.config["SECRET_KEY"], algorithm=ALGORITHM)
    return token, int(lifetime.total_seconds())


def decode_access_token(token):
    """Return the payload; raises jwt.ExpiredSignatureError / jwt.InvalidTokenError."""
    return jwt.decode(
        token,
        current_app.config["SECRET_KEY"],
        algorithms=[ALGORITHM],
        options={"require": ["sub", "exp", "iat"]},
    )


def token_matches_password(payload, user):
    return hmac.compare_digest(str(payload.get("pwd", "")), _password_fingerprint(user))


# ---- Browser sessions: the same token in an HttpOnly cookie (JS can't read it).

AUTH_COOKIE = "wo_token"


def set_auth_cookie(response, token, max_age):
    response.set_cookie(
        AUTH_COOKIE, token, max_age=max_age, path="/api",
        httponly=True, samesite="Strict",
        secure=current_app.config["AUTH_COOKIE_SECURE"],
    )


def clear_auth_cookie(response):
    response.delete_cookie(AUTH_COOKIE, path="/api", httponly=True, samesite="Strict",
                           secure=current_app.config["AUTH_COOKIE_SECURE"])
