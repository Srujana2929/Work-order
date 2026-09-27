"""Request-body helpers and field validators. All raise APIError(400) on bad input."""
import re
from datetime import date
from decimal import Decimal, InvalidOperation

from flask import request

from errors import APIError
from models.enums import ROLES

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,50}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 8


def get_json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise APIError("Request body must be a JSON object", 400)
    return data


def require_fields(data, *fields):
    missing = [f for f in fields if data.get(f) in (None, "")]
    if missing:
        raise APIError(f"Missing required field(s): {', '.join(missing)}", 400)


TEXT_MAX_BYTES = 65535          # MySQL TEXT limit is in bytes, not characters
MAX_ID = 4294967295             # INT UNSIGNED


def clean_str(value, field, max_length, required=False):
    """Strip a string field; return None for empty optional values."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        if required:
            raise APIError(f"'{field}' is required", 400)
        return None
    if not isinstance(value, str):
        raise APIError(f"'{field}' must be a string", 400)
    value = value.strip()
    if len(value) > max_length:
        raise APIError(f"'{field}' must be at most {max_length} characters", 400)
    if len(value.encode("utf-8")) > TEXT_MAX_BYTES:
        raise APIError(f"'{field}' is too long", 400)
    return value


def like_pattern(term):
    """A LIKE '%term%' pattern with the user's % and _ matched literally."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def validate_username(value):
    value = clean_str(value, "username", 50, required=True)
    if not USERNAME_RE.match(value):
        raise APIError("'username' must be 3-50 characters: letters, digits, '_', '.', '-'", 400)
    return value


def validate_email(value):
    value = clean_str(value, "email", 120, required=True).lower()
    if not EMAIL_RE.match(value):
        raise APIError("'email' is not a valid email address", 400)
    return value


def validate_role(value):
    if value not in ROLES:
        raise APIError(f"'role' must be one of: {', '.join(ROLES)}", 400)
    return value


def validate_password(value, field="password"):
    if not isinstance(value, str) or len(value) < MIN_PASSWORD_LENGTH:
        raise APIError(f"'{field}' must be at least {MIN_PASSWORD_LENGTH} characters", 400)
    if len(value) > 128:
        raise APIError(f"'{field}' must be at most 128 characters", 400)
    return value


def validate_bool(value, field):
    if not isinstance(value, bool):
        raise APIError(f"'{field}' must be true or false", 400)
    return value


def reject_unknown_fields(data, allowed):
    unknown = set(data) - set(allowed)
    if unknown:
        raise APIError(f"Unknown field(s): {', '.join(sorted(unknown))}. "
                       f"Allowed: {', '.join(sorted(allowed))}", 400)


def validate_choice(value, choices, field):
    if value not in choices:
        raise APIError(f"'{field}' must be one of: {', '.join(choices)}", 400)
    return value


def parse_int(value, field, minimum=None, maximum=MAX_ID):
    # bool is a subclass of int in Python - reject it explicitly.
    if isinstance(value, bool):
        raise APIError(f"'{field}' must be a whole number", 400)
    try:
        number = int(value)
        if isinstance(value, float) and value != number:
            raise ValueError
    except (TypeError, ValueError, OverflowError):   # OverflowError: JSON Infinity
        raise APIError(f"'{field}' must be a whole number", 400)
    if minimum is not None and number < minimum:
        raise APIError(f"'{field}' must be at least {minimum}", 400)
    if maximum is not None and number > maximum:
        raise APIError(f"'{field}' must be at most {maximum}", 400)
    return number


def parse_decimal(value, field, minimum=None, maximum=None, allow_zero=True):
    """Parse a money/quantity value with at most 2 decimal places."""
    if isinstance(value, bool) or value is None or value == "":
        raise APIError(f"'{field}' must be a number", 400)
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise APIError(f"'{field}' must be a number", 400)
    if not number.is_finite():
        raise APIError(f"'{field}' must be a number", 400)
    if abs(number) >= Decimal("1e15"):          # far beyond any column; also avoids huge exponents
        raise APIError(f"'{field}' is too large", 400)
    try:
        rounded = number.quantize(Decimal("0.01"))
    except InvalidOperation:
        raise APIError(f"'{field}' must be a number", 400)
    if number != rounded:
        raise APIError(f"'{field}' can have at most 2 decimal places", 400)
    if not allow_zero and number == 0:
        raise APIError(f"'{field}' must be greater than 0", 400)
    if minimum is not None and number < minimum:
        raise APIError(f"'{field}' must be at least {minimum}", 400)
    if maximum is not None and number > maximum:
        raise APIError(f"'{field}' must be at most {maximum}", 400)
    return number.quantize(Decimal("0.01"))


def parse_date(value, field):
    """Parse 'YYYY-MM-DD'; None/empty -> None."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise APIError(f"'{field}' must be a date string YYYY-MM-DD", 400)
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise APIError(f"'{field}' must be a valid date in YYYY-MM-DD format", 400)
    if parsed.year < 1900:                      # MySQL DATE starts at 1000; nothing real is older
        raise APIError(f"'{field}' must be after 1900", 400)
    return parsed


def parse_page_args(args, default_per_page=20):
    """Validated (page, per_page) from query args; bounded so OFFSET can't overflow."""
    page = parse_int(args.get("page", 1), "page", minimum=1, maximum=100000)
    per_page = parse_int(args.get("per_page", default_per_page), "per_page", minimum=1, maximum=100)
    return page, per_page
