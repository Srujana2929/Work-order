"""Technician ratings: one optional 1-5 star rating per work order, given by
a supervisor/admin when the work is verified or closed (or afterwards).

Averages are calculated on read from technician_ratings (migration 004);
until that table exists, summaries are None and rating requests get a 503.
"""
from sqlalchemy import func

import audit
from errors import APIError
from extensions import db
from models import TechnicianRating
from schema_check import ratings_available
from validation import clean_str, parse_int

RATABLE_STATUSES = ("Verified", "Closed")


def require_ratings():
    if not ratings_available():
        raise APIError("Ratings aren't set up on this server yet - an administrator needs to run "
                       "database/migrations/004_ratings_and_photos.sql", 503)


def parse_rating(stars, comment, stars_field="stars", comment_field="comment"):
    """Validated (stars, comment); error messages name the given fields."""
    stars = parse_int(stars, stars_field, minimum=1, maximum=5)
    comment = clean_str(comment, comment_field, 500)
    return stars, comment


def rating_for(work_order):
    if not ratings_available():
        return None
    return TechnicianRating.query.filter_by(work_order_id=work_order.id).first()


def save_rating(work_order, rater, stars, comment):
    """Create or replace the rating on a Verified/Closed work order (same transaction
    as the caller; audited). Returns the TechnicianRating."""
    require_ratings()
    if work_order.assigned_technician_id is None:
        raise APIError("This work order has no technician to rate", 409)
    if work_order.status not in RATABLE_STATUSES:
        raise APIError(f"Work can be rated once it is {' or '.join(RATABLE_STATUSES)} "
                       f"(it is {work_order.status})", 409)
    rating = rating_for(work_order)
    before = {"stars": rating.stars, "comment": rating.comment} if rating else None
    if rating is None:
        rating = TechnicianRating(work_order_id=work_order.id)
        db.session.add(rating)
    rating.technician_id = work_order.assigned_technician_id
    rating.rated_by = rater.id
    rating.stars = stars
    rating.comment = comment
    db.session.flush()

    tech = work_order.technician
    label = f"WO-{work_order.id:05d}"
    verb = "re-rated" if before else "rated"
    audit.record(rater, "work_order.rated", "work_order", work_order.id, label,
                 f"{rater.full_name} {verb} {tech.full_name if tech else 'the technician'}'s work on "
                 f"{label}: {stars}/5",
                 {"technician": tech.username if tech else None, "stars": stars,
                  "comment": comment, "previous": before})
    return rating


def summaries(user_ids):
    """{user_id: {"average": 4.3, "count": 12}} for the given users (users
    without ratings get count 0, average None). None if ratings aren't set up."""
    if not ratings_available():
        return None
    ids = list({int(i) for i in user_ids})
    result = {i: {"average": None, "count": 0} for i in ids}
    if not ids:
        return result
    rows = (db.session.query(TechnicianRating.technician_id, func.avg(TechnicianRating.stars),
                             func.count(TechnicianRating.id))
            .filter(TechnicianRating.technician_id.in_(ids))
            .group_by(TechnicianRating.technician_id).all())
    for tech_id, avg, count in rows:
        result[tech_id] = {"average": round(float(avg), 2), "count": int(count)}
    return result


def distribution(user_id):
    """{5: n, 4: n, ...} star counts for one technician."""
    rows = (db.session.query(TechnicianRating.stars, func.count(TechnicianRating.id))
            .filter(TechnicianRating.technician_id == user_id)
            .group_by(TechnicianRating.stars).all())
    counts = {s: 0 for s in range(5, 0, -1)}
    counts.update({int(s): int(n) for s, n in rows})
    return counts


def recent(user_id, limit=10):
    return (TechnicianRating.query.filter_by(technician_id=user_id)
            .order_by(TechnicianRating.created_at.desc(), TechnicianRating.id.desc())
            .limit(limit).all())
