"""Insert a few sample machines (skips any that already exist).

Handy for a fresh dev database (or use POST /api/machines):
    python scripts/seed_machines.py
"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import create_app  # noqa: E402
from extensions import db  # noqa: E402
from models import Machine  # noqa: E402

SAMPLE_MACHINES = [
    dict(machine_code="CNC-001", name="CNC Lathe", department="Production",
         location="Bay A", manufacturer="Haas", model="ST-20", install_date=date(2021, 3, 15)),
    dict(machine_code="CMP-001", name="Air Compressor", department="Utilities",
         location="Compressor Room", manufacturer="Atlas Copco", model="GA 30"),
    dict(machine_code="CNV-002", name="Packing Conveyor", department="Packaging",
         location="Line 2", manufacturer="Dorner", model="3200"),
]


def main():
    app = create_app()
    with app.app_context():
        for spec in SAMPLE_MACHINES:
            existing = Machine.query.filter_by(machine_code=spec["machine_code"]).first()
            if existing:
                print(f"exists   {existing.machine_code} (id={existing.id})")
                continue
            machine = Machine(**spec)
            db.session.add(machine)
            db.session.commit()
            print(f"created  {machine.machine_code} (id={machine.id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
