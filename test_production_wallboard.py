"""Regression tests for the sheet-fed Production Pipeline wall board."""

import unittest
from datetime import date
from unittest.mock import patch

import production_wallboard as wallboard


class ProductionWallboardParsingTests(unittest.TestCase):
    def test_optional_manpower_column_is_carried_to_line_and_factory_payload(self):
        grid, warnings = wallboard._parse_grid([
            ["Sewing Line", "Date", "Time Slot", "Target", "Actual", "ManPower"],
            ["A", "3/9/2026", "8:00-9:00", "50", "30", "16"],
            ["A", "3/9/2026", "9:00-10:00", "50", "50", "16"],
        ])

        line = wallboard._line_payload(
            "A", grid[date(2026, 9, 3)]["A"],
            wallboard.datetime(2026, 9, 3, 17, tzinfo=wallboard.EAT),
            "past",
        )
        self.assertEqual(warnings, {"duplicate_rows": 0, "skipped_rows": 0})
        self.assertEqual(line["manpower"], 16)
        self.assertEqual(line["made_so_far"], 80)

    def test_legacy_five_column_sheet_remains_compatible(self):
        grid, _ = wallboard._parse_grid([
            ["Sewing Line", "Date", "Time Slot", "Target", "Actual"],
            ["A", "3/9/2026", "8:00-9:00", "50", "30"],
        ])
        line = wallboard._line_payload(
            "A", grid[date(2026, 9, 3)]["A"],
            wallboard.datetime(2026, 9, 3, 17, tzinfo=wallboard.EAT),
            "past",
        )
        self.assertIsNone(line["manpower"])

    def test_requested_historical_date_is_returned_with_all_available_dates(self):
        rows = [
            ["Sewing Line", "Date", "Time Slot", "Target", "Actual", "ManPower"],
            ["A", "1/9/2026", "8:00-9:00", "50", "30", "16"],
            ["A", "3/9/2026", "8:00-9:00", "50", "40", "16"],
        ]
        with patch.object(wallboard, "_read_sheet_rows", return_value=rows):
            payload = wallboard.hourly_tracker("2026-09-01")
        self.assertEqual(payload["work_date"], "2026-09-01")
        self.assertEqual(payload["available_dates"], ["2026-09-01", "2026-09-03"])
        self.assertEqual(payload["lines"][0]["manpower"], 16)
        self.assertFalse(payload["is_today"])

    def test_missing_requested_date_fails_instead_of_showing_another_day(self):
        rows = [
            ["Sewing Line", "Date", "Time Slot", "Target", "Actual", "ManPower"],
            ["A", "3/9/2026", "8:00-9:00", "50", "40", "16"],
        ]
        with patch.object(wallboard, "_read_sheet_rows", return_value=rows):
            with self.assertRaises(wallboard.HTTPException) as ctx:
                wallboard.hourly_tracker("2026-09-02")
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()