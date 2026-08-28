from datetime import datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from openpyxl import Workbook

from import_atelier_history import (
    HEADERS,
    map_legacy_status,
    map_tailor_name,
    normalize_kenyan_phone,
    parse_tracker_row,
    parse_workbook,
    preserve_sku,
)


def valid_row(**overrides):
    row = {
        "date_in": datetime(2026, 7, 10),
        "customer_name": " A Customer ",
        "phone": "0722 123 456",
        "service_type": "Scheduled",
        "sku": 60066999.0,
        "item_description": "Trousers",
        "tailor_name": "Maxmilla",
        "qty": 1,
        "alteration_detail": "Hem",
        "promised_date": datetime(2026, 7, 11),
        "status": "Ready",
        "date_out": datetime(2026, 7, 11),
        "notes": "-",
    }
    row.update(overrides)
    return row


class AtelierImporterTests(unittest.TestCase):
    def test_normalize_kenyan_phone(self):
        cases = [
            ("0722123456", "+254722123456"),
            (722123456, "+254722123456"),
            ("254 722 123 456", "+254722123456"),
            ("+254722123456", "+254722123456"),
            ("0112-345-678", "+254112345678"),
            ("-", None),
            ("missing", None),
            ("12345", None),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_kenyan_phone(raw), expected)

    def test_sku_and_tailor_normalization(self):
        self.assertEqual(preserve_sku(60066999.0), "60066999")
        self.assertEqual(preserve_sku("0060066999"), "0060066999")
        self.assertIsNone(preserve_sku("-"))
        for spelling in ("Maxi", "MAXI", "Maxmilla", "Maximilla", "maximillia"):
            with self.subTest(spelling=spelling):
                self.assertEqual(
                    map_tailor_name(spelling), "Maximillia Kubochi"
                )

    def test_quantity_is_split_with_stable_distinct_source_identity(self):
        jobs, quarantine, invalid_phone = parse_tracker_row(valid_row(qty=3), 42)
        self.assertIsNone(quarantine)
        self.assertFalse(invalid_phone)
        self.assertEqual(len(jobs), 3)
        self.assertEqual({job.qty for job in jobs}, {1})
        self.assertEqual(len({job.source_identity for job in jobs}), 3)
        self.assertEqual([job.source_item for job in jobs], [1, 2, 3])
        self.assertTrue(
            all(job.charge_amount == Decimal("0") for job in jobs)
        )
        rerun, _, _ = parse_tracker_row(valid_row(qty=3), 42)
        self.assertEqual(
            [job.source_identity for job in jobs],
            [job.source_identity for job in rerun],
        )

    def test_legacy_statuses_and_derived_dates(self):
        self.assertEqual(map_legacy_status("Pending"), "Received")
        self.assertEqual(map_legacy_status("Ready"), "Ready for Pickup")
        self.assertEqual(map_legacy_status("Collected"), "Collected")
        jobs, quarantine, _ = parse_tracker_row(
            valid_row(status="Collected", date_out=datetime(2026, 7, 12)), 2
        )
        self.assertIsNone(quarantine)
        self.assertEqual(jobs[0].date_ready, datetime(2026, 7, 12))
        self.assertEqual(jobs[0].collected_at, datetime(2026, 7, 12))

    def test_bad_dates_quarantine_the_whole_source_row(self):
        cases = [
            ({"date_in": "#VALUE!"}, "unparseable"),
            ({"date_in": datetime(2025, 7, 10)}, "outside log range"),
            ({"promised_date": datetime(2026, 7, 9)}, "earlier than date_in"),
            ({"date_out": datetime(2026, 7, 9)}, "earlier than date_in"),
        ]
        for changes, reason in cases:
            with self.subTest(changes=changes):
                jobs, quarantine, _ = parse_tracker_row(
                    valid_row(qty=2, **changes), 8
                )
                self.assertEqual(jobs, [])
                self.assertIsNotNone(quarantine)
                self.assertEqual(quarantine.expanded_quantity, 2)
                self.assertTrue(
                    any(reason in item for item in quarantine.reasons)
                )

    def test_missing_markers_are_null_and_invalid_phone_is_counted(self):
        jobs, quarantine, invalid = parse_tracker_row(
            valid_row(phone="not a phone", sku="-", notes="missing"), 4
        )
        self.assertIsNone(quarantine)
        self.assertTrue(invalid)
        self.assertIsNone(jobs[0].phone)
        self.assertIsNone(jobs[0].sku)
        self.assertIsNone(jobs[0].notes)

    def test_workbook_reads_only_tracker_and_reconciles(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "history.xlsx"
            workbook = Workbook()
            tracker = workbook.active
            tracker.title = "Tracker"
            labels = list(HEADERS.values())
            tracker.append(labels)

            def append(row):
                tracker.append([row[key] for key in HEADERS])

            append(valid_row(qty=2))
            append(valid_row(date_in="#REF!", qty=3))
            tracker.append([None] * len(labels))
            requisitions = workbook.create_sheet("Requisitions")
            requisitions.append(labels)
            requisitions.append([datetime(2026, 7, 10)] * len(labels))
            workbook.save(path)

            result = parse_workbook(path)
            report = result.report()
            self.assertEqual(len(result.jobs), 2)
            self.assertEqual(len(result.quarantined), 1)
            self.assertEqual(report["mode"], "dry-run")
            self.assertEqual(report["reconciliation"]["source_rows"], 2)
            self.assertEqual(report["reconciliation"]["source_quantity"], 5)
            self.assertEqual(report["reconciliation"]["quarantined_jobs"], 3)
            self.assertEqual(report["reconciliation"]["importable_jobs"], 2)


if __name__ == "__main__":
    unittest.main()