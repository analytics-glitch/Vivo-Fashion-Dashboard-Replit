"""Regression coverage for the Finance & Operations L10 recovery path.

These tests deliberately exercise the source selection and the production row
inserter with a tiny cursor fake.  They prove that a historic source is remapped
instead of reusing IDs, that every linked section stays connected, and that the
SLT/Supply Chain fence cannot be used as a restore target.
"""

import asyncio
import copy
import re
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import api_pg


def _snapshot():
    tables = {table: [] for table in api_pg._L10_INSERT_ORDER}
    tables["l10_folders"] = [
        {"id": 1, "name": "SLT"},
        {"id": 42, "name": "Finance & Operations", "description": "Historic Finance", "color": "#123456"},
        {"id": 2, "name": "Supply Chain"},
    ]
    tables["l10_meetings"] = [
        {"id": 101, "folder_id": 42, "week_label": "2025-W01", "meeting_date": "2025-01-06", "start_time": "09:00"},
        {"id": 102, "folder_id": 42, "week_label": "2025-W02", "meeting_date": "2025-01-13", "start_time": "09:00"},
        {"id": 201, "folder_id": 1, "week_label": "2025-W01", "meeting_date": "2025-01-06", "start_time": "08:00"},
    ]
    tables["l10_members"] = [{"id": 301, "folder_id": 42, "name": "Finance Lead", "sort_order": 1, "active": True}]
    tables["l10_scorecard_metrics"] = [{"id": 401, "folder_id": 42, "who": "Finance Lead", "measurable": "Cash", "goal": ">=1", "uom": "KES", "goal_direction": "up", "sort_order": 1, "active": True}]
    tables["l10_rocks"] = [{"id": 501, "folder_id": 42, "description": "Close books", "rock_type": "Company", "on_track": True, "done": False, "sort_order": 1, "active": True}]
    tables["l10_todos"] = [{"id": 601, "folder_id": 42, "description": "Send report", "status": "open", "opened_meeting_id": 101, "closed_meeting_id": 102}]
    tables["l10_checkin"] = [{"id": 701, "meeting_id": 101, "member_name": "Finance Lead", "personal_news": "Good", "professional_news": "Closed"}]
    tables["l10_scorecard_values"] = [{"id": 801, "metric_id": 401, "meeting_id": 101, "value": "2", "on_track": True}]
    tables["l10_headlines"] = [{"id": 901, "meeting_id": 101, "headline": "Budget approved", "sort_order": 1, "moved_to_ids": False}]
    tables["l10_ids_issues"] = [{"id": 1001, "meeting_id": 102, "issue": "Variance", "sort_order": 1, "status": "open", "scorecard_metric_id": 401, "rock_id": 501}]
    tables["l10_conclude"] = [{"id": 1101, "meeting_id": 102, "cascading_messages": "Share cash plan"}]
    tables["l10_ratings"] = [{"id": 1201, "meeting_id": 102, "member_name": "Finance Lead", "rating": 9}]
    return {
        "surface": "main",
        "exported_at": "2026-01-01T00:00:00Z",
        "tables": tables,
        "row_counts": {table: len(rows) for table, rows in tables.items()},
    }


class _RestoreCursor:
    def __init__(self):
        self.next_id = 5000
        self.rows = []
        self.queries = []
        self.last_id = None

    def execute(self, query, params=None):
        self.queries.append((" ".join(query.split()), params))
        match = re.match(r"INSERT INTO (\w+)\s*\(([^)]+)\)", " ".join(query.split()))
        if match:
            table = match.group(1)
            columns = [column.strip() for column in match.group(2).split(",")]
            self.last_id = self.next_id
            self.next_id += 1
            self.rows.append((table, dict(zip(columns, params or [])), self.last_id))

    def fetchone(self):
        return {"id": self.last_id}


class FinanceSourceValidationTests(unittest.TestCase):
    def test_extracts_only_named_finance_department_and_all_sections(self):
        prepared = api_pg._l10_validate_finance_source(_snapshot())

        self.assertEqual(prepared["source_folder_id"], 42)
        self.assertEqual(prepared["source_counts"]["l10_folders"], 1)
        self.assertEqual(prepared["source_counts"]["l10_meetings"], 2)
        self.assertEqual(prepared["source_counts"]["l10_ratings"], 1)
        self.assertEqual(prepared["source"]["l10_meetings"][0]["folder_id"], 42)

    def test_rejects_declared_count_mismatch_before_any_restore(self):
        snapshot = _snapshot()
        snapshot["row_counts"]["l10_headlines"] += 1

        with self.assertRaises(HTTPException) as error:
            api_pg._l10_validate_finance_source(snapshot)
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("l10_headlines", error.exception.detail)

    def test_rejects_cross_department_metric_reference(self):
        snapshot = _snapshot()
        snapshot["tables"]["l10_scorecard_values"][0]["metric_id"] = 999

        with self.assertRaises(HTTPException) as error:
            api_pg._l10_validate_finance_source(snapshot)
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("metric", error.exception.detail)

    def test_rejects_supply_chain_surface_snapshot(self):
        snapshot = _snapshot()
        snapshot["surface"] = "fabric"

        with self.assertRaises(HTTPException) as error:
            api_pg._l10_validate_finance_source(snapshot)
        self.assertEqual(error.exception.status_code, 403)


class FinanceRestoreRemappingTests(unittest.TestCase):
    def test_remaps_every_meeting_metric_and_rock_reference(self):
        prepared = api_pg._l10_validate_finance_source(_snapshot())
        cursor = _RestoreCursor()

        with mock.patch.object(api_pg, "_l10_find_finance_folder", return_value=None):
            target_id, counts = api_pg._l10_restore_finance_source(
                cursor, prepared, "admin@example.com")

        self.assertEqual(target_id, 5000)
        self.assertEqual(counts, prepared["source_counts"])
        by_table = {}
        for table, values, new_id in cursor.rows:
            by_table.setdefault(table, []).append((values, new_id))

        meeting_ids = {new_id for _, new_id in by_table["l10_meetings"]}
        metric_ids = {new_id for _, new_id in by_table["l10_scorecard_metrics"]}
        rock_ids = {new_id for _, new_id in by_table["l10_rocks"]}
        self.assertTrue(all(values["folder_id"] == target_id for values, _ in by_table["l10_meetings"]))
        self.assertIn(by_table["l10_scorecard_values"][0][0]["meeting_id"], meeting_ids)
        self.assertIn(by_table["l10_scorecard_values"][0][0]["metric_id"], metric_ids)
        self.assertIn(by_table["l10_ids_issues"][0][0]["meeting_id"], meeting_ids)
        self.assertIn(by_table["l10_ids_issues"][0][0]["scorecard_metric_id"], metric_ids)
        self.assertIn(by_table["l10_ids_issues"][0][0]["rock_id"], rock_ids)
        self.assertNotIn(101, meeting_ids)
        self.assertNotIn(401, metric_ids)
        self.assertNotIn(501, rock_ids)
        self.assertIn(
            "SELECT setval(pg_get_serial_sequence('l10_folders', 'id'), COALESCE((SELECT MAX(id) FROM l10_folders), 1), true)",
            [query for query, _ in cursor.queries],
        )

    def test_advances_legacy_seed_sequence_before_creating_folder(self):
        cursor = _RestoreCursor()
        api_pg._l10_sync_folder_sequence(cursor)
        query, params = cursor.queries[0]
        self.assertIn("pg_get_serial_sequence('l10_folders', 'id')", query)
        self.assertIsNone(params)

    def test_cross_department_reference_blocks_before_delete(self):
        class _ReferenceCursor:
            def __init__(self):
                self.queries = []

            def execute(self, query, params=None):
                self.queries.append((" ".join(query.split()), params))

            def fetchone(self):
                return {
                    "reference_type": "scorecard value crosses department",
                    "record_id": 88,
                }

        cursor = _ReferenceCursor()
        with self.assertRaises(HTTPException) as error:
            api_pg._l10_assert_no_external_department_references(cursor, 77)
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("crosses department", error.exception.detail)
        self.assertIn("l10_scorecard_values", cursor.queries[0][0])
        self.assertEqual(cursor.queries[0][1], (77, 77, 77, 77, 77, 77, 77, 77))

    def test_refuses_to_delete_slt_or_supply_chain(self):
        cursor = _RestoreCursor()
        for folder_id in (1, 2):
            with self.assertRaises(HTTPException) as error:
                api_pg._l10_delete_department_rows(cursor, folder_id)
            self.assertEqual(error.exception.status_code, 403)

    def test_same_verified_source_is_deterministic_for_retry(self):
        prepared = api_pg._l10_validate_finance_source(_snapshot())
        first, second = _RestoreCursor(), _RestoreCursor()
        with mock.patch.object(api_pg, "_l10_find_finance_folder", return_value=None):
            _, first_counts = api_pg._l10_restore_finance_source(first, prepared)
            _, second_counts = api_pg._l10_restore_finance_source(second, copy.deepcopy(prepared))
        self.assertEqual(first_counts, second_counts)
        self.assertEqual(
            [table for table, _, _ in first.rows],
            [table for table, _, _ in second.rows],
        )

    def test_retry_replaces_only_existing_finance_folder(self):
        prepared = api_pg._l10_validate_finance_source(_snapshot())
        cursor = _RestoreCursor()
        with mock.patch.object(api_pg, "_l10_find_finance_folder", return_value={"id": 77}), \
                mock.patch.object(api_pg, "_l10_assert_no_external_department_references") as protected, \
                mock.patch.object(api_pg, "_l10_delete_department_rows") as delete:
            target_id, counts = api_pg._l10_restore_finance_source(cursor, prepared)

        self.assertEqual(target_id, 77)
        self.assertEqual(counts, prepared["source_counts"])
        protected.assert_called_once_with(cursor, 77)
        delete.assert_called_once_with(cursor, 77)
        self.assertNotIn(
            "DELETE FROM l10_folders",
            "\n".join(query for query, _ in cursor.queries),
        )


class FinanceRestoreEndpointTests(unittest.TestCase):
    def test_direct_confirm_stores_retrievable_backup_before_restore(self):
        calls = []

        class _Request:
            state = SimpleNamespace(user={"email": "admin@example.com"})

            async def json(self):
                return {"snapshot": _snapshot(), "confirm": True}

        class _Cursor:
            def execute(self, *_args, **_kwargs):
                calls.append("lock")

        @contextmanager
        def _transaction():
            yield _Cursor()

        def _capture(_cur, *, fabric):
            self.assertFalse(fabric)
            calls.append("capture")
            return _snapshot()

        def _store(_cur, snapshot, **kwargs):
            self.assertEqual(snapshot["surface"], "main")
            self.assertEqual(kwargs["actor"], "admin@example.com")
            calls.append("backup")
            return 9001

        def _restore(_cur, prepared, _actor):
            self.assertIn("backup", calls)
            calls.append("restore")
            return 77, prepared["source_counts"]

        with mock.patch.object(api_pg, "_l10_require_admin_request"), \
                mock.patch.object(api_pg, "_ensure_l10_tables"), \
                mock.patch.object(api_pg, "_l10_find_finance_folder", return_value=None), \
                mock.patch.object(api_pg, "_l10_folder_record_counts"), \
                mock.patch.object(api_pg, "_users_tx", _transaction), \
                mock.patch.object(api_pg, "_l10_export_snapshot_from_cursor", _capture), \
                mock.patch.object(api_pg, "_l10_store_finance_restore_backup", _store), \
                mock.patch.object(api_pg, "_l10_restore_finance_source", _restore), \
                mock.patch.object(api_pg, "_reset_l10_sequences"):
            loop = asyncio.new_event_loop()
            try:
                result = loop.run_until_complete(
                    api_pg.l10_restore_finance_operations(_Request()))
            finally:
                loop.close()

        self.assertEqual(result["status"], "restored")
        self.assertEqual(result["pre_restore_backup"]["id"], 9001)
        self.assertEqual(
            result["pre_restore_backup"]["download_path"],
            "/api/admin/l10/finance-operations/backups/9001",
        )
        self.assertLess(calls.index("backup"), calls.index("restore"))

    def test_backup_download_endpoint_returns_stored_snapshot(self):
        request = SimpleNamespace(state=SimpleNamespace(user={"email": "admin@example.com"}))
        stored = _snapshot()
        with mock.patch.object(api_pg, "_l10_require_admin_request"), \
                mock.patch.object(api_pg, "_ensure_l10_tables"), \
                mock.patch.object(api_pg, "_users_exec", return_value=[{"snapshot": stored}]) as query:
            returned = api_pg.l10_download_finance_restore_backup(9001, request)

        self.assertEqual(returned, stored)
        query.assert_called_once_with(
            "SELECT snapshot FROM l10_finance_restore_backups WHERE id=%s",
            (9001,),
            fetch=True,
        )


if __name__ == "__main__":
    unittest.main()