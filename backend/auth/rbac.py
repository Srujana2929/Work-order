"""Role-based access control.

Usage in a route:

    @users_bp.post("/users")
    @permission_required("users:manage")
    def create_user(): ...

    @wo_bp.get("/work-orders/<int:wo_id>")
    @permission_required("work_orders:view")
    def get_work_order(wo_id):
        wo = db.get_or_404(WorkOrder, wo_id)
        ensure_work_order_access(current_user(), wo)   # technicians: own only
        ...

Admin passes every check. The role is always read from the database on each
request (never trusted from the token), so role changes and deactivation take
effect immediately.
"""
from functools import wraps

import jwt
from flask import g, request

from errors import APIError
from extensions import db
from models import User
from auth.tokens import AUTH_COOKIE, decode_access_token, token_matches_password

ADMIN, SUPERVISOR, TECHNICIAN = "Admin", "Supervisor", "Technician"

# Which non-Admin roles may do what. Admin implicitly has every permission.
PERMISSIONS = {
    # Users
    "users:manage":            set(),                   # create/edit/deactivate users
    "users:list_technicians":  {SUPERVISOR},            # to pick an assignee
    "users:view_ratings":      {SUPERVISOR},            # individual ratings + comments (self: average only)
    # Work orders
    "work_orders:view":        {SUPERVISOR, TECHNICIAN},  # technicians: own only
    "work_orders:create":      {SUPERVISOR},
    "work_orders:edit":        {SUPERVISOR},            # title, priority, due date, ...
    "work_orders:assign":      {SUPERVISOR},
    "work_orders:update_work": {TECHNICIAN},            # start/hold/complete, progress; own only
    "work_orders:log_costs":   {SUPERVISOR, TECHNICIAN},  # materials + labour; technicians: own only
    "work_orders:verify":      {SUPERVISOR},            # also: send completed work back for rework
    "work_orders:close":       {SUPERVISOR},
    "work_orders:rate":        {SUPERVISOR},            # rate the technician on verified/closed work
    "work_orders:review_photos": {SUPERVISOR},          # approve/reject material photos
    "work_orders:delete":      set(),                   # Admin only
    # Machines & maintenance history
    "machines:view":           {SUPERVISOR, TECHNICIAN},  # registry + history
    "machines:manage":         {SUPERVISOR},            # register machines
    "machines:log_notes":      {SUPERVISOR, TECHNICIAN},  # manual history notes
    # Dashboard (technicians see figures for their own work only)
    "dashboard:view":          {SUPERVISOR, TECHNICIAN},
    # AI assistant (staffing and planning questions are a supervisor's call)
    "assistant:use":           {SUPERVISOR},
    # Activity / audit log
    "audit:view":              set(),                   # Admin only
}


def has_permission(user, permission):
    if permission not in PERMISSIONS:
        raise KeyError(f"Unknown permission '{permission}'")
    return user.role == ADMIN or user.role in PERMISSIONS[permission]


def current_user():
    """The authenticated User for this request (set by login_required)."""
    return g.current_user


SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def _authenticate():
    # API clients (curl, Postman) send a Bearer header; the browser frontend
    # uses the HttpOnly cookie set at login.
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        token = request.cookies.get(AUTH_COOKIE)
        if not token:
            raise APIError("Authentication required: log in, or send "
                           "'Authorization: Bearer <token>'", 401)
        # CSRF defence for cookie auth: another site can't add this header
        # (on top of the cookie being SameSite=Strict).
        if request.method not in SAFE_METHODS and request.headers.get("X-Requested-With") != "fetch":
            raise APIError("Missing 'X-Requested-With: fetch' header", 403)

    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise APIError("Token has expired - please log in again", 401)
    except jwt.InvalidTokenError:
        raise APIError("Invalid token", 401)

    user = db.session.get(User, int(payload["sub"])) if payload["sub"].isdigit() else None
    if user is None or not token_matches_password(payload, user):
        raise APIError("Invalid token", 401)
    if not user.is_active:
        raise APIError("Account is deactivated", 403)
    return user


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.current_user = _authenticate()
        return fn(*args, **kwargs)
    return wrapper


def roles_required(*roles):
    """Allow only the given roles (Admin is always allowed)."""
    def decorator(fn):
        @login_required
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if user.role != ADMIN and user.role not in roles:
                raise APIError("You do not have permission to perform this action", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def permission_required(permission):
    """Allow only roles granted `permission` in PERMISSIONS (Admin always allowed)."""
    if permission not in PERMISSIONS:  # catch typos at import time
        raise KeyError(f"Unknown permission '{permission}'")

    def decorator(fn):
        @login_required
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not has_permission(current_user(), permission):
                raise APIError("You do not have permission to perform this action", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


# ---- Row-level rules for work orders (used by the work-order routes) ----

def can_access_work_order(user, work_order):
    """Admins and supervisors see every work order; technicians only their own."""
    if user.role in (ADMIN, SUPERVISOR):
        return True
    return work_order.assigned_technician_id == user.id


def ensure_work_order_access(user, work_order):
    if not can_access_work_order(user, work_order):
        # 404 rather than 403 so technicians can't probe which IDs exist.
        raise APIError("Work order not found", 404)


def scope_work_orders(query, user):
    """Restrict a WorkOrder query to what `user` may see."""
    from models import WorkOrder
    if user.role == TECHNICIAN:
        return query.filter(WorkOrder.assigned_technician_id == user.id)
    return query
