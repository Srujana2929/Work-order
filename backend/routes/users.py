"""User management.

Admin: full access. Supervisor: may list/view active technicians (to assign
work). Everyone: may view their own profile.
Users are never deleted - DELETE deactivates the account.
"""
from flask import Blueprint, jsonify, request
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError

import audit
from auth.rbac import (
    ADMIN, SUPERVISOR, TECHNICIAN,
    current_user, has_permission, login_required, permission_required,
)
from errors import APIError
from extensions import db
from models import User
from models.enums import ROLES
from validation import (
    clean_str, get_json_body, like_pattern, reject_unknown_fields, require_fields, validate_bool, validate_email,
    validate_password, validate_role, validate_username,
)

users_bp = Blueprint("users", __name__)


def _get_user_or_404(user_id):
    user = db.session.get(User, user_id)
    if user is None:
        raise APIError("User not found", 404)
    return user


def _ensure_unique(username=None, email=None, exclude_id=None):
    conditions = []
    if username is not None:
        conditions.append(User.username == username)
    if email is not None:
        conditions.append(User.email == email)
    query = User.query.filter(or_(*conditions))
    if exclude_id is not None:
        query = query.filter(User.id != exclude_id)
    clash = query.first()
    if clash is not None:
        field = "username" if username is not None and clash.username.lower() == username.lower() else "email"
        raise APIError(f"A user with that {field} already exists", 409)


def _commit():
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise APIError("A user with that username or email already exists", 409)


def _parse_bool_arg(name):
    value = request.args.get(name)
    if value is None:
        return None
    if value.lower() in ("true", "1", "yes"):
        return True
    if value.lower() in ("false", "0", "no"):
        return False
    raise APIError(f"Query parameter '{name}' must be true or false", 400)


@users_bp.get("")
@permission_required("users:list_technicians")
def list_users():
    """GET /api/users?role=Technician&is_active=true&q=search
    Supervisors only ever get active technicians."""
    user = current_user()
    query = User.query

    if has_permission(user, "users:manage"):
        role = request.args.get("role")
        if role:
            query = query.filter(User.role == validate_role(role))
        is_active = _parse_bool_arg("is_active")
        if is_active is not None:
            query = query.filter(User.is_active == is_active)
    else:
        query = query.filter(User.role == TECHNICIAN, User.is_active.is_(True))

    search = (request.args.get("q") or "").strip()
    if search:
        like = like_pattern(search[:100])
        query = query.filter(or_(User.full_name.like(like, escape="\\"), User.username.like(like, escape="\\"),
                                 User.email.like(like, escape="\\"), User.department.like(like, escape="\\")))

    users = query.order_by(User.full_name).all()
    return jsonify(users=[u.to_dict() for u in users], count=len(users))


@users_bp.post("")
@permission_required("users:manage")
def create_user():
    """POST /api/users  {full_name, username, email, password, role, department?, phone?}"""
    data = get_json_body()
    reject_unknown_fields(data, {"full_name", "username", "email", "password", "role", "department", "phone"})
    require_fields(data, "full_name", "username", "email", "password", "role")

    username = validate_username(data["username"])
    email = validate_email(data["email"])
    _ensure_unique(username=username, email=email)

    user = User(
        full_name=clean_str(data["full_name"], "full_name", 100, required=True),
        username=username,
        email=email,
        role=validate_role(data["role"]),
        department=clean_str(data.get("department"), "department", 100),
        phone=clean_str(data.get("phone"), "phone", 20),
    )
    user.set_password(validate_password(data["password"]))
    db.session.add(user)
    try:
        db.session.flush()
    except IntegrityError:
        db.session.rollback()
        raise APIError("A user with that username or email already exists", 409)
    admin = current_user()
    audit.record(admin, "user.created", "user", user.id, user.username,
                 f"{admin.full_name} created {user.role.lower()} account {user.username} ({user.full_name})",
                 {"role": user.role, "email": user.email, "department": user.department})
    _commit()
    return jsonify(user=user.to_dict()), 201


USER_AUDIT_FIELDS = ("full_name", "username", "email", "role", "department", "phone", "is_active")


def _user_snapshot(user):
    return {f: getattr(user, f) for f in USER_AUDIT_FIELDS}


def _audit_user_changes(admin, user, before, password_reset):
    """One entry per kind of change: activation, password reset, other edits.
    Passwords are never written to the log."""
    diff = audit.changes(before, _user_snapshot(user))
    active = diff.pop("is_active", None)
    if active:
        action = "user.reactivated" if active["to"] else "user.deactivated"
        verb = "reactivated" if active["to"] else "deactivated"
        audit.record(admin, action, "user", user.id, user.username,
                     f"{admin.full_name} {verb} user {user.username}")
    if password_reset:
        audit.record(admin, "user.password_reset", "user", user.id, user.username,
                     f"{admin.full_name} reset the password for {user.username}")
    if diff:
        role = diff.get("role")
        summary = (f"{admin.full_name} changed {user.username}'s role from {role['from']} to {role['to']}"
                   if role and len(diff) == 1 else
                   f"{admin.full_name} edited user {user.username} ({', '.join(diff)})")
        audit.record(admin, "user.updated", "user", user.id, user.username, summary, {"changes": diff})


@users_bp.get("/<int:user_id>")
@login_required
def get_user(user_id):
    """GET /api/users/<id> - Admin: anyone. Supervisor: active technicians.
    Anyone: themselves."""
    viewer = current_user()
    user = _get_user_or_404(user_id)

    allowed = (
        viewer.id == user.id
        or has_permission(viewer, "users:manage")
        or (viewer.role == SUPERVISOR and user.role == TECHNICIAN and user.is_active)
    )
    if not allowed:
        raise APIError("You do not have permission to view this user", 403)
    return jsonify(user=user.to_dict())


@users_bp.patch("/<int:user_id>")
@permission_required("users:manage")
def update_user(user_id):
    """PATCH /api/users/<id>  any of: full_name, username, email, role,
    department, phone, is_active, password (admin reset)."""
    admin = current_user()
    user = _get_user_or_404(user_id)
    data = get_json_body()

    allowed_fields = {"full_name", "username", "email", "role", "department",
                      "phone", "is_active", "password"}
    unknown = set(data) - allowed_fields
    if unknown:
        raise APIError(f"Unknown field(s): {', '.join(sorted(unknown))}", 400)
    if not data:
        raise APIError("No fields to update", 400)

    # An admin can't lock themselves out (this also guarantees at least one
    # active admin always remains).
    if user.id == admin.id:
        if "role" in data and data["role"] != ADMIN:
            raise APIError("You cannot change your own role", 400)
        if data.get("is_active") is False:
            raise APIError("You cannot deactivate your own account", 400)

    before = _user_snapshot(user)
    if "username" in data:
        username = validate_username(data["username"])
        _ensure_unique(username=username, exclude_id=user.id)
        user.username = username
    if "email" in data:
        email = validate_email(data["email"])
        _ensure_unique(email=email, exclude_id=user.id)
        user.email = email
    if "full_name" in data:
        user.full_name = clean_str(data["full_name"], "full_name", 100, required=True)
    if "role" in data:
        user.role = validate_role(data["role"])
    if "department" in data:
        user.department = clean_str(data["department"], "department", 100)
    if "phone" in data:
        user.phone = clean_str(data["phone"], "phone", 20)
    if "is_active" in data:
        user.is_active = validate_bool(data["is_active"], "is_active")
    if "password" in data:
        user.set_password(validate_password(data["password"]))  # also revokes their tokens

    _audit_user_changes(admin, user, before, password_reset="password" in data)
    _commit()
    db.session.refresh(user)
    return jsonify(user=user.to_dict())


@users_bp.delete("/<int:user_id>")
@permission_required("users:manage")
def deactivate_user(user_id):
    """DELETE /api/users/<id> - deactivates (soft delete). Their tokens stop
    working immediately; their work-order history is kept."""
    user = _get_user_or_404(user_id)
    admin = current_user()
    if user.id == admin.id:
        raise APIError("You cannot deactivate your own account", 400)
    before = _user_snapshot(user)
    user.is_active = False
    _audit_user_changes(admin, user, before, password_reset=False)   # no entry if already inactive
    _commit()
    db.session.refresh(user)
    return jsonify(message="User deactivated", user=user.to_dict())


@users_bp.get("/roles")
@login_required
def list_roles():
    """GET /api/users/roles - the valid role names (for dropdowns)."""
    return jsonify(roles=list(ROLES))
