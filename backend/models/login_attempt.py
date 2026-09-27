from extensions import db


class LoginAttempt(db.Model):
    """A failed sign-in, used to throttle password guessing.

    Persisted here (not in memory) so LOGIN_MAX_FAILURES/LOGIN_LOCKOUT_SECONDS
    holds across every gunicorn worker/process and survives restarts - an
    in-memory counter is per-process and would be wiped by a redeploy or
    reset independently by each worker. Rows are pruned as new failures are
    recorded (routes/auth.py); a successful login clears the matching rows.
    """
    __tablename__ = "login_attempts"

    id = db.Column(db.BigInteger, primary_key=True)
    username = db.Column(db.String(120), nullable=False)
    ip_address = db.Column(db.String(45), nullable=False)
    attempted_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now(3))
