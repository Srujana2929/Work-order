"""Which optional tables exist (tables added by later migrations).

Features that depend on a migration check here first, so an existing
database that hasn't run the migration yet keeps working with that feature
switched off instead of every request failing. Once a table is found it's
cached; while missing it's re-checked every 30 s, so running the migration
takes effect without restarting the app.
"""
import time

from flask import current_app
from sqlalchemy import inspect

from extensions import db

_found = set()
_checked_at = {}

MIGRATION_HINT = {
    "technician_ratings": "database/migrations/004_ratings_and_photos.sql",
    "material_photos": "database/migrations/004_ratings_and_photos.sql",
}


def has_table(name):
    if name in _found:
        return True
    if time.monotonic() - _checked_at.get(name, -1e9) < 30:
        return False
    _checked_at[name] = time.monotonic()
    if inspect(db.engine).has_table(name):
        _found.add(name)
        return True
    current_app.logger.warning("%s table not found - run %s as root", name,
                               MIGRATION_HINT.get(name, "the latest migration"))
    return False


def ratings_available():
    return has_table("technician_ratings")


def photos_available():
    return has_table("material_photos")
