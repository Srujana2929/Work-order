"""Verify the MySQL connection, schema, and ORM mapping.

Run from the backend folder with the venv active:
    python scripts/check_db.py
Exits with code 0 if everything is OK, 1 otherwise.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from decimal import Decimal  # noqa: E402

from sqlalchemy import text  # noqa: E402
from sqlalchemy.exc import DBAPIError  # noqa: E402

EXPECTED_TABLES = {"users", "machines", "work_orders", "materials", "maintenance_history",
                   "audit_log", "login_attempts"}
TECHNICIAN_RULE_MESSAGE = "must have an assigned technician"


def _expect_rejected(conn, sql, params):
    """Run sql inside a savepoint; True if the technician trigger rejected it."""
    savepoint = conn.begin_nested()
    try:
        conn.execute(text(sql), params)
    except DBAPIError as exc:
        savepoint.rollback()
        return TECHNICIAN_RULE_MESSAGE in str(exc.orig)
    savepoint.rollback()
    return False


def check_triggers(db):
    """Exercise every trigger on throwaway rows, then roll everything back.

    The app user has no TRIGGER privilege, so information_schema.TRIGGERS
    hides the triggers from it; testing their behaviour needs only DML rights.
    (Rolled-back inserts still consume AUTO_INCREMENT ids - harmless gaps.)
    """
    results = []
    with db.engine.connect() as conn:
        trans = conn.begin()
        try:
            machine_id = conn.execute(text(
                "INSERT INTO machines (machine_code, name, department) "
                "VALUES ('__CHECK_DB__', 'check_db test', 'Test')"
            )).lastrowid

            results.append(("trg_work_orders_before_insert", _expect_rejected(
                conn,
                "INSERT INTO work_orders (title, machine_id, department, status) "
                "VALUES ('check', :m, 'Test', 'Assigned')",
                {"m": machine_id},
            )))

            wo_id = conn.execute(text(
                "INSERT INTO work_orders (title, machine_id, department) "
                "VALUES ('check', :m, 'Test')"
            ), {"m": machine_id}).lastrowid

            results.append(("trg_work_orders_before_update", _expect_rejected(
                conn,
                "UPDATE work_orders SET status = 'In Progress' WHERE id = :w",
                {"w": wo_id},
            )))

            def material_cost():
                return conn.execute(text(
                    "SELECT material_cost FROM work_orders WHERE id = :w"
                ), {"w": wo_id}).scalar_one()

            mat_id = conn.execute(text(
                "INSERT INTO materials (work_order_id, material_name, quantity, unit_cost) "
                "VALUES (:w, 'check', 2, 10.50)"
            ), {"w": wo_id}).lastrowid
            results.append(("trg_materials_after_insert", material_cost() == Decimal("21.00")))

            conn.execute(text("UPDATE materials SET quantity = 3 WHERE id = :id"), {"id": mat_id})
            results.append(("trg_materials_after_update", material_cost() == Decimal("31.50")))

            conn.execute(text("DELETE FROM materials WHERE id = :id"), {"id": mat_id})
            results.append(("trg_materials_after_delete", material_cost() == Decimal("0.00")))
        except Exception as exc:
            print(f"[FAIL] Trigger test could not run: {exc.__cause__ or exc}")
            return False
        finally:
            trans.rollback()

    failed = [name for name, ok in results if not ok]
    if failed:
        print(f"[FAIL] Triggers missing or not working: {', '.join(failed)} "
              f"- run database/schema.sql as root")
        return False
    print(f"[OK] All {len(results)} triggers working (test rows rolled back)")
    return True


def main():
    try:
        from app import create_app
        from extensions import db
        from models import AuditLog, LoginAttempt, MaintenanceHistory, Machine, Material, User, WorkOrder

        app = create_app()
    except Exception as exc:
        print(f"[FAIL] Could not load app config: {exc}")
        return 1

    with app.app_context():
        try:
            row = db.session.execute(
                text("SELECT VERSION(), DATABASE(), CURRENT_USER()")
            ).one()
        except Exception as exc:
            print(f"[FAIL] Could not connect to MySQL: {exc.__cause__ or exc}")
            return 1
        print(f"[OK] Connected to MySQL {row[0]} | database={row[1]} | user={row[2]}")

        tables = set(db.session.execute(text("SHOW TABLES")).scalars())
        missing = EXPECTED_TABLES - tables
        if missing:
            print(f"[FAIL] Missing tables: {', '.join(sorted(missing))} - run database/schema.sql")
            return 1
        print(f"[OK] Tables present: {', '.join(sorted(EXPECTED_TABLES))}")

        if not check_triggers(db):
            return 1

        # Querying through each model proves the ORM columns match the real tables.
        for model in (User, Machine, WorkOrder, Material, MaintenanceHistory, AuditLog, LoginAttempt):
            try:
                model.query.first()
                count = db.session.query(model).count()
            except Exception as exc:
                print(f"[FAIL] {model.__name__} does not match its table: {exc.__cause__ or exc}")
                return 1
            print(f"[OK] {model.__name__:<20} rows={count}")

    print("\nDatabase connection verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
