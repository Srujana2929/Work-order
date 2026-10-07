"""Timestamps leave the API as UTC with an explicit "Z" (no database needed).

Run from the project root:  backend\\.venv\\Scripts\\python -m unittest discover -s backend/tests -v
"""
import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import Config  # noqa: E402
from models.work_order import to_iso  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


class ToIsoTests(unittest.TestCase):
    def test_stored_utc_datetime_gets_z(self):
        # DATETIME values come back naive, in UTC (the DB session runs in UTC)
        self.assertEqual(to_iso(datetime(2026, 10, 7, 17, 12, 0)), "2026-10-07T17:12:00Z")

    def test_minutes_precision(self):
        self.assertEqual(to_iso(datetime(2026, 10, 7, 17, 12, 59), timespec="minutes"), "2026-10-07T17:12Z")

    def test_milliseconds_kept(self):
        self.assertEqual(to_iso(datetime(2026, 10, 7, 17, 12, 5, 123000)), "2026-10-07T17:12:05.123000Z")

    def test_aware_datetime_is_converted_to_utc(self):
        self.assertEqual(to_iso(datetime(2026, 10, 7, 22, 42, tzinfo=IST)), "2026-10-07T17:12:00Z")

    def test_round_trip_to_ist(self):
        # what a UTC+5:30 browser does with it: 17:12 UTC is 22:42 IST
        sent = to_iso(datetime(2026, 10, 7, 17, 12))
        shown = datetime.fromisoformat(sent.replace("Z", "+00:00")).astimezone(IST)
        self.assertEqual(shown.strftime("%Y-%m-%d %H:%M"), "2026-10-07 22:42")

    def test_plain_dates_unchanged(self):
        self.assertEqual(to_iso(date(2026, 10, 6)), "2026-10-06")

    def test_none(self):
        self.assertIsNone(to_iso(None))


class SessionTimeZoneTests(unittest.TestCase):
    def test_db_session_is_pinned_to_utc(self):
        init = Config.SQLALCHEMY_ENGINE_OPTIONS["connect_args"]["init_command"]
        self.assertEqual(init, "SET time_zone = '+00:00'")


if __name__ == "__main__":
    unittest.main()
