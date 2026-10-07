"""Fill a LOCAL database with realistic demo data (or remove it again).

    python scripts/seed_demo.py           # add the demo data (does nothing if it's already there)
    python scripts/seed_demo.py --clear   # remove only the demo data this script created

Run from the backend folder with the venv active. Refuses to run unless
DB_HOST is localhost / 127.0.0.1 / ::1 - never point it at Railway.

What it adds: 6 DEMO- machines in 3 departments, 3 technicians + 2
supervisors (usernames demo_*, names ending "(Demo)"), and 40 work orders
spread over the last 8 weeks. Everything goes through the real API in
process - as the demo supervisors and technicians - so validation, audit
entries, cost triggers, maintenance history (created when a work order
reaches Completed) and ratings are produced exactly as in the app; the
timestamps are then moved back to the simulated dates. It all happens in one
transaction: either everything is added or nothing is.

Existing users, machines and work orders are never modified.
"""
import argparse
import os
import random
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import bindparam, text  # noqa: E402
from sqlalchemy.orm import Session, scoped_session, sessionmaker  # noqa: E402

from app import app  # noqa: E402
from auth.tokens import create_access_token  # noqa: E402
from extensions import db  # noqa: E402
from maintenance import upsert_history  # noqa: E402
from models import User, WorkOrder  # noqa: E402
from schema_check import ratings_available  # noqa: E402

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
USER_PREFIX = "demo_"
MACHINE_PREFIX = "DEMO-"
DEMO_PASSWORD = "DemoPass123!"

TECHNICIANS = [("demo_alex", "Alex Morgan (Demo)", "Machining"),
               ("demo_priya", "Priya Nair (Demo)", "Packaging"),
               ("demo_marco", "Marco Silva (Demo)", "Utilities")]
SUPERVISORS = [("demo_dana", "Dana Brooks (Demo)", "Maintenance"),
               ("demo_sam", "Sam Okafor (Demo)", "Maintenance")]

MACHINES = [
    dict(machine_code="DEMO-CNC-01", name="5-axis CNC mill", department="Machining", location="Bay A",
         manufacturer="Haas", model="UMC-750", serial_number="DEMO-SN-1001", install_date="2019-04-12"),
    dict(machine_code="DEMO-LTH-02", name="CNC turning lathe", department="Machining", location="Bay A",
         manufacturer="DMG Mori", model="NLX 2500", serial_number="DEMO-SN-1002", install_date="2020-09-03"),
    dict(machine_code="DEMO-CNV-03", name="Packing line conveyor", department="Packaging", location="Line 2",
         manufacturer="Dorner", model="3200", serial_number="DEMO-SN-2001", install_date="2018-02-20"),
    dict(machine_code="DEMO-SEAL-04", name="Case sealer", department="Packaging", location="Line 2",
         manufacturer="3M-Matic", model="200a", serial_number="DEMO-SN-2002", install_date="2021-06-15"),
    dict(machine_code="DEMO-CMP-05", name="Rotary screw air compressor", department="Utilities",
         location="Compressor room", manufacturer="Atlas Copco", model="GA 30", serial_number="DEMO-SN-3001",
         install_date="2017-11-08"),
    dict(machine_code="DEMO-CHL-06", name="Process water chiller", department="Utilities", location="Roof plant",
         manufacturer="Carrier", model="30RB", serial_number="DEMO-SN-3002", install_date="2016-05-30"),
]

# (machine index, title, category, typical materials [(name, part, unit, unit cost)])
JOBS = [
    (0, "Spindle vibration above limit", "Corrective", [("Spindle bearing set", "HB-7014", "set", 412.0)]),
    (0, "Quarterly way-lube and coolant service", "Preventive", [("Way oil ISO 68", "WO-68", "L", 6.4), ("Coolant concentrate", "CC-5", "L", 9.8)]),
    (0, "Tool changer misses pocket 14", "Corrective", [("Tool changer proximity sensor", "PX-12", "pcs", 86.0)]),
    (0, "Axis backlash calibration", "Calibration", [("Shim kit", "SK-3", "set", 24.5)]),
    (0, "Coolant pump not priming", "Breakdown", [("Coolant pump", "CP-450", "pcs", 265.0)]),
    (1, "Chuck jaws worn - parts out of round", "Corrective", [("Hard jaw set", "HJ-8", "set", 148.0)]),
    (1, "Turret indexing fault", "Breakdown", [("Turret clamp seal kit", "TS-21", "set", 92.0)]),
    (1, "Monthly lathe inspection", "Inspection", [("Way wiper", "WW-2", "pcs", 18.0)]),
    (1, "Hydraulic chuck pressure low", "Corrective", [("Hydraulic oil ISO 32", "HO-32", "L", 5.2), ("Pressure switch", "PS-90", "pcs", 74.0)]),
    (1, "Tailstock alignment check", "Calibration", []),
    (2, "Belt tracking off on infeed", "Corrective", [("Belt lacing kit", "BL-40", "set", 38.0)]),
    (2, "Drive motor overheating", "Breakdown", [("Gear motor 0.75 kW", "GM-075", "pcs", 540.0)]),
    (2, "Replace worn conveyor belt", "Corrective", [("Conveyor belt 6 m", "CB-600", "pcs", 310.0)]),
    (2, "Lubricate roller bearings", "Preventive", [("Bearing grease EP2", "GR-EP2", "kg", 11.5)]),
    (2, "Photo-eye misaligned at diverter", "Corrective", [("Retro-reflector", "RR-50", "pcs", 22.0)]),
    (2, "Emergency stop pull-cord inspection", "Inspection", []),
    (3, "Tape head jamming", "Corrective", [("Tape cutter blade", "TB-3", "pcs", 31.0)]),
    (3, "Side belt drive slipping", "Corrective", [("Side drive belt", "SB-12", "pcs", 64.0)]),
    (3, "Weekly sealer clean and check", "Preventive", [("Cleaning solvent", "CS-1", "L", 7.5)]),
    (3, "Flap folder air cylinder leaking", "Corrective", [("Air cylinder seal kit", "AC-25", "set", 45.0)]),
    (4, "Compressor tripping on high temperature", "Breakdown", [("Thermostatic valve", "TV-30", "pcs", 188.0), ("Compressor oil", "RO-46", "L", 14.0)]),
    (4, "2000-hour service", "Preventive", [("Oil filter", "OF-30", "pcs", 42.0), ("Air filter", "AF-30", "pcs", 58.0), ("Separator element", "SE-30", "pcs", 126.0)]),
    (4, "Condensate drain stuck open", "Corrective", [("Zero-loss drain valve", "DV-1", "pcs", 97.0)]),
    (4, "Air leak survey on main header", "Inspection", [("Push-in fittings", "PF-10", "pcs", 3.2)]),
    (4, "Pressure transducer reading erratic", "Calibration", [("Pressure transducer", "PT-16", "pcs", 132.0)]),
    (5, "Chiller low refrigerant alarm", "Breakdown", [("Refrigerant R410A", "R410A", "kg", 38.0)]),
    (5, "Condenser coil cleaning", "Preventive", [("Coil cleaner", "CC-9", "L", 12.0)]),
    (5, "Water pump mechanical seal leak", "Corrective", [("Mechanical seal", "MS-35", "pcs", 155.0)]),
    (5, "Flow switch calibration", "Calibration", []),
    (5, "Annual chiller inspection", "Inspection", [("Filter drier", "FD-08", "pcs", 49.0)]),
]

# 40 work orders: final status and how many days ago each was raised.
PLAN = (["Closed"] * 16 + ["Verified"] * 6 + ["Completed"] * 5 + ["In Progress"] * 4 + ["On Hold"]
        + ["Assigned"] * 4 + ["Pending"] * 4)
AGE_DAYS = {"Closed": (10, 56), "Verified": (5, 40), "Completed": (2, 14), "In Progress": (1, 12),
            "On Hold": (4, 10), "Assigned": (0, 7), "Pending": (0, 6)}
DUE_IN_DAYS = {"Critical": 1, "High": 3, "Medium": 7, "Low": 14}
RATINGS = [(5, "Fixed first time and left the area spotless."), (4, "Good work, slightly over the estimate."),
           (5, "Found the root cause, not just the symptom."), (3, "Needed a second visit to finish."),
           (4, "Clear notes in the history - thanks."), (2, "Machine back down the next day; rework needed."),
           (5, "Quick turnaround on a critical job."), (4, "Solid job, parts list was complete.")]
DONE_NOTES = ["Replaced worn parts, tested under load for 30 minutes.", "Adjusted and re-tested; within tolerance.",
              "Cleaned, lubricated and checked all fasteners.", "Root cause found and fixed; monitored after restart."]


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def check_local():
    host = (os.getenv("DB_HOST") or "").strip().lower()
    if host not in LOCAL_HOSTS:
        die(f"DB_HOST is '{host}'. This script only runs against a local database (localhost).")
    railway = [k for k in os.environ if k.startswith("RAILWAY_")]
    if railway:
        die(f"Railway environment detected ({railway[0]}). This script is local-only.")
    if (os.getenv("FLASK_ENV") or "").lower() == "production":
        die("FLASK_ENV=production. This script is local-only.")


class Api:
    """The real API, called in process as one user."""
    def __init__(self, user):
        self.client = app.test_client()
        token = create_access_token(user)
        self.headers = {"Authorization": f"Bearer {token[0] if isinstance(token, tuple) else token}"}

    def call(self, method, path, **body):
        resp = getattr(self.client, method)("/api" + path, headers=self.headers, json=body or None)
        data = resp.get_json(silent=True) or {}
        if resp.status_code >= 400:
            raise RuntimeError(f"{method.upper()} {path} -> {resp.status_code}: {data.get('error', data)}")
        return data


def max_audit_id():
    return db.session.execute(text("SELECT COALESCE(MAX(id), 0) FROM audit_log")).scalar()


def at(when, fn):
    """Run one API action and date the audit entries it wrote to `when`."""
    before = max_audit_id()
    result = fn()
    db.session.execute(text("UPDATE audit_log SET created_at = :t WHERE id > :id"), {"t": when, "id": before})
    return result


def demo_state():
    users = db.session.execute(text("SELECT id FROM users WHERE username LIKE 'demo\\_%'")).scalars().all()
    machines = db.session.execute(text("SELECT id FROM machines WHERE machine_code LIKE 'DEMO-%'")).scalars().all()
    wos = []
    if users and machines:
        wos = db.session.execute(
            text("SELECT id FROM work_orders WHERE created_by IN :u AND machine_id IN :m")
            .bindparams(bindparam("u", expanding=True), bindparam("m", expanding=True)),
            {"u": users, "m": machines}).scalars().all()
    return users, machines, wos


# ---------------------------------------------------------------- seed

def seed():
    users, machines, wos = demo_state()
    if users or machines:
        print(f"Demo data is already present ({len(users)} demo users, {len(machines)} demo machines, "
              f"{len(wos)} demo work orders) - nothing added.\n"
              "To start fresh: python scripts/seed_demo.py --clear, then run it again.")
        return
    with_ratings = ratings_available()
    rng = random.Random(2026)
    now = datetime.now().replace(microsecond=0)
    today = now.date()
    start_of_history = now - timedelta(days=70)

    # Users: created directly (an admin would otherwise appear in the audit log as creating them).
    people = {}
    for role, rows in (("Technician", TECHNICIANS), ("Supervisor", SUPERVISORS)):
        for username, name, dept in rows:
            u = User(username=username, full_name=name, email=f"{username}@demo.local", role=role, department=dept)
            u.set_password(DEMO_PASSWORD)
            db.session.add(u)
            people[username] = u
    db.session.flush()
    db.session.execute(text("UPDATE users SET created_at = :t, updated_at = :t WHERE username LIKE 'demo\\_%'"),
                       {"t": start_of_history})
    db.session.commit()
    techs = [people[u] for u, _, _ in TECHNICIANS]
    sups = [people[u] for u, _, _ in SUPERVISORS]
    as_user = {u.id: Api(u) for u in techs + sups}

    machine_ids = []
    for i, spec in enumerate(MACHINES):
        m = at(start_of_history, lambda spec=spec: as_user[sups[i % 2].id].call("post", "/machines", **spec))
        machine_ids.append(m["machine"]["id"])
    db.session.execute(text("UPDATE machines SET created_at = :t, updated_at = :t WHERE machine_code LIKE 'DEMO-%'"),
                       {"t": start_of_history})

    # Which open work orders end up overdue: 2 in progress, 1 assigned, 1 pending.
    overdue_slots = {("In Progress", 0), ("In Progress", 1), ("Assigned", 0), ("Pending", 0)}
    seen = {}
    jobs = rng.sample(JOBS, len(JOBS)) + rng.sample(JOBS, len(PLAN) - len(JOBS))
    tech_cycle = [techs[i % 3] for i in range(len(PLAN))]
    rng.shuffle(tech_cycle)
    rating_pool = list(RATINGS)
    closed_seen = 0
    summary = {}

    for n, (status, job) in enumerate(zip(PLAN, jobs)):
        nth = seen.get(status, 0)
        seen[status] = nth + 1
        mi, title, category, materials = job
        machine = MACHINES[mi]
        # Tech by department where possible, otherwise the shuffled rotation.
        tech = next((t for t in techs if t.department == machine["department"]), tech_cycle[n])
        if rng.random() < 0.3:
            tech = tech_cycle[n]
        sup = sups[n % 2]
        priority = rng.choices(["Low", "Medium", "High", "Critical"], weights=[2, 5, 3, 1])[0]
        if category == "Breakdown":
            priority = rng.choice(["High", "Critical"])
        lo, hi = AGE_DAYS[status]
        age = lo + (hi - lo) * (nth + rng.uniform(0.2, 0.8)) / PLAN.count(status)    # evenly spread, jittered
        created = datetime.combine(today - timedelta(days=round(age)), time(rng.randint(7, 15), rng.choice([0, 15, 30, 45])))
        created = min(created, now - timedelta(hours=2))
        due = created.date() + timedelta(days=DUE_IN_DAYS[priority] + rng.randint(0, 3))
        is_overdue = (status, nth) in overdue_slots
        if is_overdue:
            created = min(created, datetime.combine(today - timedelta(days=8 + nth), time(9)))
            due = today - timedelta(days=rng.randint(1, 5))
        elif status not in ("Completed", "Verified", "Closed") and due <= today:
            due = today + timedelta(days=rng.randint(1, 6))

        S = as_user[sup.id]
        T = as_user[tech.id]
        body = dict(title=title, machine_id=machine_ids[mi], category=category, priority=priority,
                    description=f"Reported by {machine['department'].lower()} shift lead.")
        if status != "Pending":
            body["assigned_technician_id"] = tech.id
        wo_id = at(created, lambda: S.call("post", "/work-orders", **body))["work_order"]["id"]

        t = {"created": created, "started": None, "completed": None, "verified": None, "closed": None}
        clock = created
        def step(hours_lo, hours_hi):
            nonlocal clock
            clock = min(clock + timedelta(hours=rng.uniform(hours_lo, hours_hi)), now - timedelta(minutes=30))
            return clock.replace(microsecond=0)

        if status in ("In Progress", "On Hold", "Completed", "Verified", "Closed"):
            t["started"] = step(1, 20)
            at(t["started"], lambda: T.call("patch", f"/work-orders/{wo_id}/status", status="In Progress"))
            progress_at = step(1, 6)
            if status in ("In Progress", "On Hold"):
                at(progress_at, lambda: T.call("put", f"/work-orders/{wo_id}", progress=rng.choice([20, 40, 60, 75])))
            done = status in ("Completed", "Verified", "Closed")
            # Costs: always on finished work; sometimes already on work in progress.
            if done or rng.random() < 0.5:
                for name, part, unit, cost in (materials if done else materials[:1]):
                    qty = {"L": rng.choice([4, 5, 10, 20]), "kg": rng.choice([1, 2, 3]), "pcs": rng.choice([1, 1, 2, 4])}.get(unit, 1)
                    at(progress_at, lambda: T.call("post", f"/work-orders/{wo_id}/materials", material_name=name,
                                                   part_number=part, quantity=qty, unit=unit, unit_cost=cost))
                at(progress_at, lambda: T.call("post", f"/work-orders/{wo_id}/labour-cost",
                                               hours=round(rng.uniform(1, 7) * 2) / 2, hourly_rate=rng.choice([32, 36, 40, 45])))
            if status == "On Hold":
                at(step(1, 4), lambda: T.call("patch", f"/work-orders/{wo_id}/status", status="On Hold"))
            if done:
                t["completed"] = step(2, 30)
                at(t["completed"], lambda: T.call("patch", f"/work-orders/{wo_id}/status", status="Completed",
                                                   work_performed=f"{title}: {rng.choice(DONE_NOTES)}",
                                                   downtime_hours=round(rng.uniform(0.5, 8), 1)))
            if status in ("Verified", "Closed"):
                t["verified"] = step(3, 40)
                at(t["verified"], lambda: S.call("patch", f"/work-orders/{wo_id}/status", status="Verified"))
            if status == "Closed":
                t["closed"] = step(1, 60)
                extra = {}
                closed_seen += 1
                if with_ratings and closed_seen % 2 == 1:      # about half the closed work orders get a rating
                    stars, comment = rating_pool[(closed_seen // 2) % len(rating_pool)]
                    extra = {"rating": stars, "rating_comment": comment}
                at(t["closed"], lambda: S.call("patch", f"/work-orders/{wo_id}/status", status="Closed", **extra))

        # Move the work order's own timestamps to the simulated dates.
        last = max(v for v in t.values() if v)
        db.session.execute(text("UPDATE materials SET created_at = :t WHERE work_order_id = :id"),
                           {"t": t["started"] or created, "id": wo_id})
        db.session.execute(text(
            "UPDATE work_orders SET created_at = :created, started_at = :started, completed_at = :completed, "
            "verified_at = :verified, closed_at = :closed, due_date = :due, updated_at = :last WHERE id = :id"),
            {**t, "due": due, "last": last, "id": wo_id})
        db.session.execute(text("UPDATE technician_ratings SET created_at = :t, updated_at = :t WHERE work_order_id = :id")
                           if with_ratings else text("SELECT 1"), {"t": t["closed"], "id": wo_id})
        if t["completed"]:
            # Re-run the app's own history sync so the entry's date follows the moved completion date.
            wo = db.session.get(WorkOrder, wo_id, populate_existing=True)
            entry = upsert_history(wo)
            db.session.flush()
            db.session.execute(text("UPDATE maintenance_history SET created_at = :t WHERE id = :id"),
                               {"t": t["completed"], "id": entry.id})
        db.session.commit()
        summary[status] = summary.get(status, 0) + 1

    counts = db.session.execute(text(
        "SELECT (SELECT COUNT(*) FROM maintenance_history h JOIN machines m ON m.id = h.machine_id WHERE m.machine_code LIKE 'DEMO-%'), "
        "(SELECT COUNT(*) FROM materials x JOIN work_orders w ON w.id = x.work_order_id JOIN machines m ON m.id = w.machine_id "
        " WHERE m.machine_code LIKE 'DEMO-%'), "
        "(SELECT COUNT(*) FROM work_orders w JOIN machines m ON m.id = w.machine_id WHERE m.machine_code LIKE 'DEMO-%' "
        " AND w.due_date < CURDATE() AND w.status NOT IN ('Completed','Verified','Closed'))")).one()
    rated = 0
    if with_ratings:
        rated = db.session.execute(text("SELECT COUNT(*) FROM technician_ratings r JOIN users u ON u.id = r.technician_id "
                                        "WHERE u.username LIKE 'demo\\_%'")).scalar()
    print("Demo data added:")
    print(f"  users:        {len(techs)} technicians, {len(sups)} supervisors (password for all: {DEMO_PASSWORD})")
    print(f"                {', '.join(u for u, _, _ in TECHNICIANS + SUPERVISORS)}")
    print(f"  machines:     {len(machine_ids)} (DEMO-*) in Machining, Packaging, Utilities")
    print(f"  work orders:  {sum(summary.values())} - " + ", ".join(f"{k} {v}" for k, v in summary.items()))
    print(f"  overdue:      {counts[2]}")
    print(f"  materials:    {counts[1]} lines;  maintenance history: {counts[0]} entries;  ratings: {rated}"
          + ("" if with_ratings else " (ratings table missing - run migration 004)"))


# ---------------------------------------------------------------- clear

def clear():
    users, machines, wos = demo_state()
    if not (users or machines):
        print("No demo data found - nothing to remove.")
        return
    p = {"u": users or [-1], "m": machines or [-1], "w": wos or [-1]}
    exp = lambda sql: text(sql).bindparams(*(bindparam(k, expanding=True) for k in ("u", "m", "w") if f":{k}" in sql))  # noqa: E731
    run = lambda sql: db.session.execute(exp(sql), {k: v for k, v in p.items() if f":{k}" in sql}).rowcount  # noqa: E731

    removed = {}
    if ratings_available():
        removed["ratings"] = run("DELETE FROM technician_ratings WHERE work_order_id IN :w "
                                 "OR (technician_id IN :u AND rated_by IN :u)")
    removed["history"] = run("DELETE FROM maintenance_history WHERE work_order_id IN :w "
                             "OR (machine_id IN :m AND performed_by IN :u AND work_order_id IS NULL)")
    removed["work orders"] = run("DELETE FROM work_orders WHERE id IN :w")   # materials (+ photos) cascade
    removed["audit entries"] = run("DELETE FROM audit_log WHERE actor_id IN :u")
    removed["login attempts"] = db.session.execute(text("DELETE FROM login_attempts WHERE username LIKE 'demo\\_%'")).rowcount

    # Machines / users still referenced by someone else's records are kept (and reported), never forced.
    kept = []
    for mid in machines:
        refs = db.session.execute(text("SELECT (SELECT COUNT(*) FROM work_orders WHERE machine_id = :id) + "
                                       "(SELECT COUNT(*) FROM maintenance_history WHERE machine_id = :id)"), {"id": mid}).scalar()
        if refs:
            kept.append(f"machine id {mid} (used by {refs} non-demo record(s))")
        else:
            db.session.execute(text("DELETE FROM machines WHERE id = :id"), {"id": mid})
            removed["machines"] = removed.get("machines", 0) + 1
    for uid in users:
        try:
            with db.session.begin_nested():
                db.session.execute(text("DELETE FROM users WHERE id = :id"), {"id": uid})
            removed["users"] = removed.get("users", 0) + 1
        except Exception:  # noqa: BLE001 - still referenced by a non-demo record (FK RESTRICT)
            db.session.execute(text("UPDATE users SET is_active = 0 WHERE id = :id"), {"id": uid})
            kept.append(f"user id {uid} (referenced by non-demo records - deactivated instead)")
    db.session.commit()
    print("Demo data removed: " + ", ".join(f"{v} {k}" for k, v in removed.items()))
    for k in kept:
        print(f"  kept {k}")


def main():
    parser = argparse.ArgumentParser(description="Add (or --clear) local demo data.")
    parser.add_argument("--clear", action="store_true", help="remove only the demo data this script created")
    args = parser.parse_args()
    check_local()
    with app.app_context():
        print(f"Database: {os.getenv('DB_NAME')} on {os.getenv('DB_HOST')}")
        # One outer transaction: the API's own commits become savepoints, so a
        # failure part-way leaves the database exactly as it was.
        conn = db.engine.connect()
        outer = conn.begin()
        original = db.session
        db.session = scoped_session(sessionmaker(class_=Session, bind=conn, join_transaction_mode="create_savepoint"),
                                    scopefunc=original.registry.scopefunc)
        try:
            clear() if args.clear else seed()
            outer.commit()
        except BaseException:
            outer.rollback()
            print("Nothing was changed.", file=sys.stderr)
            raise
        finally:
            db.session.remove()
            db.session = original
            conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
