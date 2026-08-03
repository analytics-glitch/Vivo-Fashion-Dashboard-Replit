"""Safety tests for the L10 data import endpoint (POST /api/admin/l10/import).

Verifies three properties:

1. A payload missing the ``l10_meetings`` key (or any other required table) is
   rejected with HTTP 400 *before* any rows are deleted from the DB.
2. A payload containing a row that references a non-existent ``meeting_id``
   (FK violation) causes the whole transaction to roll back — the original
   rows survive intact.
3. A round-trip export→import restores identical row counts and original IDs.

The real ``l10_import`` / ``l10_export`` endpoint functions are driven against a
small stateful in-memory fake of ``_users_tx`` / ``_users_exec`` (no live
Postgres required), so the actual production code path is exercised rather than
a reimplementation.

Run with the stdlib test runner::

    python -m unittest test_l10_import_safety
"""
import asyncio
import contextlib
import copy
import re
import unittest
from unittest import mock

import psycopg2

import api_pg


# ──────────────────────────────────────────────────────────────────────────────
# Test fixtures
# ──────────────────────────────────────────────────────────────────────────────

_FOLDER_ID = 42  # arbitrary but consistent across all fixtures


def _initial_state():
    """Minimal L10 DB state: one folder, two meetings, one member, rest empty."""
    return {
        "l10_folders":          [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}],
        "l10_meetings":         [
            {"id": 100, "folder_id": _FOLDER_ID, "week_label": "2026-W01",
             "meeting_date": "2026-01-05", "start_time": None},
            {"id": 101, "folder_id": _FOLDER_ID, "week_label": "2026-W02",
             "meeting_date": "2026-01-12", "start_time": None},
        ],
        "l10_members":          [{"id": 200, "folder_id": _FOLDER_ID, "name": "Alice"}],
        "l10_scorecard_metrics":[],
        "l10_rocks":            [],
        "l10_todos":            [],
        "l10_checkin":          [],
        "l10_scorecard_values": [],
        "l10_headlines":        [],
        "l10_ids_issues":       [],
        "l10_conclude":         [],
        "l10_ratings":          [],
    }


# ──────────────────────────────────────────────────────────────────────────────
# In-memory fake DB helpers
# ──────────────────────────────────────────────────────────────────────────────

class _FakeCursor:
    """Minimal psycopg2-cursor stand-in backed by a shared mutable state dict.

    Supports:
    * ``DELETE FROM <table> …`` — clears every row from that table (the tests
      only contain a single folder so this is equivalent to the real WHERE
      clause).
    * ``INSERT INTO <table> (cols) VALUES (…) ON CONFLICT DO NOTHING`` — appends
      a row dict or no-ops on duplicate ``id``.
    * ``setval`` / ``pg_get_serial_sequence`` — silently ignored (sequence
      resets have no meaningful fake equivalent).

    If ``raise_on_insert`` names a table, the first INSERT into that table
    raises ``psycopg2.IntegrityError`` to simulate a FK violation.
    """

    def __init__(self, state, raise_on_insert=None):
        self._state = state
        self._raise_on_insert = raise_on_insert
        self.rowcount = 0

    def execute(self, query, params=None):
        q = " ".join(query.split())

        # Sequence resets — no-op in fake.
        if "setval" in q or "pg_get_serial_sequence" in q:
            self.rowcount = 0
            return

        # DELETE FROM <table> …
        m = re.match(r"DELETE FROM (\w+)", q)
        if m:
            tbl = m.group(1)
            if tbl in self._state:
                before = len(self._state[tbl])
                self._state[tbl] = []
                self.rowcount = before
            else:
                self.rowcount = 0
            return

        # INSERT INTO <table> (<cols>) VALUES (…)
        m = re.match(r"INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES", q)
        if m:
            tbl = m.group(1)
            if self._raise_on_insert and tbl == self._raise_on_insert:
                raise psycopg2.IntegrityError(
                    f"insert or update on table \"{tbl}\" violates foreign key constraint"
                )
            cols = [c.strip() for c in m.group(2).split(",")]
            if params is not None and tbl in self._state:
                row = dict(zip(cols, params))
                existing_ids = {r.get("id") for r in self._state[tbl]}
                if row.get("id") not in existing_ids:
                    self._state[tbl].append(row)
                    self.rowcount = 1
                else:
                    self.rowcount = 0  # ON CONFLICT DO NOTHING
            else:
                self.rowcount = 0
            return

        self.rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def close(self):
        pass


def _make_users_tx(state, raise_on_insert=None):
    """Return a drop-in replacement for ``api_pg._users_tx`` that operates on
    the supplied ``state`` dict.  Commits by leaving the state mutated in-place;
    rolls back by restoring the snapshot taken at transaction start."""

    @contextlib.contextmanager
    def _fake_tx(lock=False):
        snapshot = copy.deepcopy(state)
        cursor = _FakeCursor(state, raise_on_insert)
        try:
            yield cursor
            # commit — state already mutated in-place
        except Exception:
            # rollback — restore pre-transaction snapshot
            state.clear()
            state.update(snapshot)
            raise

    return _fake_tx


def _make_users_exec(state):
    """Return a drop-in for ``api_pg._users_exec`` that serves SELECT queries
    for the export path and silently absorbs DDL/writes."""

    def _fake_exec(query, params=None, fetch=False):
        q = " ".join(query.split())
        m = re.match(r"SELECT \* FROM (\w+)", q)
        if m:
            tbl = m.group(1)
            return [dict(r) for r in state.get(tbl, [])]
        # DDL and other write queries.
        return [] if fetch else None

    return _fake_exec


class _FakeRequest:
    """Minimal stand-in for a FastAPI ``Request`` with a JSON body."""

    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ──────────────────────────────────────────────────────────────────────────────
# Test 1: missing required table key → 400, no rows deleted
# ──────────────────────────────────────────────────────────────────────────────

class MissingTableKeyTests(unittest.TestCase):
    """A payload that omits ``l10_meetings`` (or any other required table) must
    be rejected with HTTP 400 *before* any DELETE is executed."""

    def setUp(self):
        self.state = _initial_state()
        # Patch _users_tx so any accidental DB touch would register.
        self._tx_mock = mock.patch.object(
            api_pg, "_users_tx", side_effect=_make_users_tx(self.state)
        )
        self._ensure_mock = mock.patch.object(
            api_pg, "_ensure_l10_tables", lambda: None
        )
        self._tx_mock.start()
        self._ensure_mock.start()
        self.addCleanup(self._tx_mock.stop)
        self.addCleanup(self._ensure_mock.stop)

    def _import(self, payload):
        from fastapi.responses import JSONResponse
        resp = _run(api_pg.l10_import(_FakeRequest(payload)))
        # FastAPI endpoint returns a JSONResponse for 400 cases.
        if isinstance(resp, JSONResponse):
            import json as _json
            body = _json.loads(resp.body)
            return resp.status_code, body
        return 200, resp

    def test_missing_l10_meetings_returns_400(self):
        """Payload with l10_folders but no l10_meetings key → 400 error."""
        payload = {
            "tables": {
                "l10_folders": [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}],
                # l10_meetings intentionally absent
                "l10_members":          [],
                "l10_scorecard_metrics":[],
                "l10_rocks":            [],
                "l10_todos":            [],
                "l10_checkin":          [],
                "l10_scorecard_values": [],
                "l10_headlines":        [],
                "l10_ids_issues":       [],
                "l10_conclude":         [],
                "l10_ratings":          [],
            }
        }
        status, body = self._import(payload)
        self.assertEqual(status, 400)
        self.assertIn("error", body)
        self.assertIn("l10_meetings", body["error"])

    def test_missing_l10_meetings_leaves_meetings_intact(self):
        """The original meetings must survive a rejected import (no rows wiped)."""
        payload = {
            "tables": {
                "l10_folders": [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}],
                # l10_meetings intentionally absent
                "l10_members":          [],
                "l10_scorecard_metrics":[],
                "l10_rocks":            [],
                "l10_todos":            [],
                "l10_checkin":          [],
                "l10_scorecard_values": [],
                "l10_headlines":        [],
                "l10_ids_issues":       [],
                "l10_conclude":         [],
                "l10_ratings":          [],
            }
        }
        self._import(payload)
        # Two original meetings must still be present.
        self.assertEqual(len(self.state["l10_meetings"]), 2)
        meeting_ids = {r["id"] for r in self.state["l10_meetings"]}
        self.assertEqual(meeting_ids, {100, 101})

    def test_missing_any_required_table_returns_400(self):
        """Any table missing from the payload (not just l10_meetings) → 400."""
        # Build a complete payload then remove l10_rocks.
        tables = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        tables["l10_folders"] = [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}]
        del tables["l10_rocks"]
        status, body = self._import({"tables": tables})
        self.assertEqual(status, 400)
        self.assertIn("l10_rocks", body["error"])

    def test_no_folders_returns_400(self):
        """Payload with no l10_folders rows → 400 (existing guard, unchanged)."""
        tables = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        tables["l10_folders"] = []  # empty list: no folder_ids
        status, body = self._import({"tables": tables})
        self.assertEqual(status, 400)

    def test_no_db_touch_on_rejected_import(self):
        """_users_tx must never be entered when the payload is rejected."""
        tx_entered = []

        @contextlib.contextmanager
        def spy_tx(lock=False):
            tx_entered.append(True)
            yield _FakeCursor(self.state)

        with mock.patch.object(api_pg, "_users_tx", side_effect=spy_tx):
            tables = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
            tables["l10_folders"] = [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}]
            del tables["l10_meetings"]
            _run(api_pg.l10_import(_FakeRequest({"tables": tables})))

        self.assertEqual(tx_entered, [],
                         "Transaction was entered despite rejected payload")


# ──────────────────────────────────────────────────────────────────────────────
# Test 2: FK violation → transaction rolls back, original rows intact
# ──────────────────────────────────────────────────────────────────────────────

class FKViolationRollbackTests(unittest.TestCase):
    """A row referencing a non-existent meeting_id raises IntegrityError inside
    the transaction; ``_users_tx`` must roll back so that the DELETE that already
    ran is also undone and original data is preserved."""

    def setUp(self):
        self.state = _initial_state()

    def _call_import(self, payload, raise_on_insert):
        """Run l10_import with a fake _users_tx that raises FK error on the
        named table and verify state is rolled back."""
        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_tx",
                               side_effect=_make_users_tx(self.state, raise_on_insert)):
            try:
                _run(api_pg.l10_import(_FakeRequest(payload)))
            except Exception:
                pass  # FK IntegrityError propagates; we care about state only

    def _complete_payload(self, extra_rows=None):
        """Return a complete valid payload for folder 42, with optional extra
        rows per table added on top of the base fixture."""
        tables = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        tables["l10_folders"] = [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}]
        tables["l10_meetings"] = [
            {"id": 100, "folder_id": _FOLDER_ID, "week_label": "2026-W01",
             "meeting_date": "2026-01-05", "start_time": None},
            {"id": 101, "folder_id": _FOLDER_ID, "week_label": "2026-W02",
             "meeting_date": "2026-01-12", "start_time": None},
        ]
        tables["l10_members"] = [{"id": 200, "folder_id": _FOLDER_ID, "name": "Alice"}]
        if extra_rows:
            for tbl, rows in extra_rows.items():
                tables[tbl].extend(rows)
        return {"tables": tables}

    def test_fk_violation_on_checkin_rolls_back_meetings(self):
        """When l10_checkin INSERT raises a FK error the whole tx rolls back,
        restoring both the deleted meetings and the deleted members."""
        payload = self._complete_payload(extra_rows={
            "l10_checkin": [
                {"id": 999, "meeting_id": 9999,  # 9999 does not exist
                 "member_id": 200, "score": 7},
            ]
        })
        self._call_import(payload, raise_on_insert="l10_checkin")

        # Original two meetings must still be present.
        self.assertEqual(len(self.state["l10_meetings"]), 2,
                         "Meetings were not restored after FK rollback")
        meeting_ids = {r["id"] for r in self.state["l10_meetings"]}
        self.assertEqual(meeting_ids, {100, 101})

    def test_fk_violation_on_checkin_rolls_back_members(self):
        """The member row (deleted in the same tx before the INSERT) is also
        rolled back."""
        payload = self._complete_payload(extra_rows={
            "l10_checkin": [
                {"id": 999, "meeting_id": 9999, "member_id": 200, "score": 7},
            ]
        })
        self._call_import(payload, raise_on_insert="l10_checkin")

        self.assertEqual(len(self.state["l10_members"]), 1,
                         "Members were not restored after FK rollback")
        self.assertEqual(self.state["l10_members"][0]["id"], 200)

    def test_fk_violation_on_scorecard_values_rolls_back(self):
        """A FK violation on l10_scorecard_values (another meeting-child table)
        rolls back the entire transaction."""
        payload = self._complete_payload(extra_rows={
            "l10_scorecard_values": [
                {"id": 500, "meeting_id": 8888,  # 8888 does not exist
                 "metric_id": 1, "value": 42},
            ]
        })
        self._call_import(payload, raise_on_insert="l10_scorecard_values")

        self.assertEqual(len(self.state["l10_meetings"]), 2,
                         "Meetings not restored after scorecard_values FK rollback")

    def test_fk_violation_leaves_folders_intact(self):
        """The folder row itself is also rolled back (was deleted inside the tx)."""
        payload = self._complete_payload(extra_rows={
            "l10_checkin": [
                {"id": 999, "meeting_id": 9999, "member_id": 200, "score": 7},
            ]
        })
        self._call_import(payload, raise_on_insert="l10_checkin")

        folder_ids = {r["id"] for r in self.state["l10_folders"]}
        self.assertIn(_FOLDER_ID, folder_ids,
                      "Folder was not restored after FK rollback")


# ──────────────────────────────────────────────────────────────────────────────
# Test 3: round-trip export → import restores identical counts and IDs
# ──────────────────────────────────────────────────────────────────────────────

class RoundTripTests(unittest.TestCase):
    """Exporting then immediately importing the snapshot must restore the exact
    same row counts and IDs with no data loss or duplication."""

    def setUp(self):
        self.source_state = _initial_state()

    def _export(self):
        """Call l10_export() with a fake _users_exec backed by source_state."""
        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_exec",
                               side_effect=_make_users_exec(self.source_state)):
            return api_pg.l10_export()

    def _import(self, export_payload, dest_state):
        """Call l10_import() on dest_state with the given payload."""
        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_tx",
                               side_effect=_make_users_tx(dest_state)):
            return _run(api_pg.l10_import(_FakeRequest(export_payload)))

    def test_round_trip_row_counts_match(self):
        """Each table's imported row count equals its exported count."""
        snapshot = self._export()
        self.assertIn("tables", snapshot)
        self.assertIn("row_counts", snapshot)

        dest = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        result = self._import(snapshot, dest)

        for tbl in api_pg._L10_INSERT_ORDER:
            exported = snapshot["row_counts"][tbl]
            imported = result["imported"][tbl]
            self.assertEqual(
                imported, exported,
                f"Row count mismatch for {tbl}: exported {exported}, imported {imported}",
            )

    def test_round_trip_preserves_meeting_ids(self):
        """Original meeting IDs (100, 101) survive the export→import round-trip."""
        snapshot = self._export()
        dest = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        self._import(snapshot, dest)

        imported_ids = {r["id"] for r in dest["l10_meetings"]}
        self.assertEqual(imported_ids, {100, 101})

    def test_round_trip_preserves_folder_id(self):
        """The original folder ID is preserved after import."""
        snapshot = self._export()
        dest = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        self._import(snapshot, dest)

        folder_ids = {r["id"] for r in dest["l10_folders"]}
        self.assertIn(_FOLDER_ID, folder_ids)

    def test_round_trip_total_rows_consistent(self):
        """total_rows in the import response equals the sum of all exported counts."""
        snapshot = self._export()
        dest = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        result = self._import(snapshot, dest)

        expected_total = sum(snapshot["row_counts"].values())
        self.assertEqual(result["total_rows"], expected_total)

    def test_round_trip_second_import_is_idempotent(self):
        """Importing the same snapshot twice produces the exact same final state.

        The endpoint deletes then re-inserts on every call, so the second run
        writes the same row count as the first.  Idempotency means the *result*
        is identical, not that the second run is a no-op.
        """
        snapshot = self._export()
        dest = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        self._import(snapshot, dest)
        state_after_1 = copy.deepcopy(dest)

        self._import(snapshot, dest)
        state_after_2 = copy.deepcopy(dest)

        for tbl in api_pg._L10_INSERT_ORDER:
            self.assertEqual(
                len(state_after_2[tbl]), len(state_after_1[tbl]),
                f"Row count for {tbl} changed between the two imports "
                f"({len(state_after_1[tbl])} → {len(state_after_2[tbl])})",
            )
        # Spot-check that meeting IDs are preserved both times.
        ids_1 = {r["id"] for r in state_after_1["l10_meetings"]}
        ids_2 = {r["id"] for r in state_after_2["l10_meetings"]}
        self.assertEqual(ids_1, ids_2)

    def test_export_payload_contains_all_required_tables(self):
        """The export payload must include every table key that the import
        requires, so the round-trip never triggers the 'missing table' guard."""
        snapshot = self._export()
        for tbl in api_pg._L10_INSERT_ORDER:
            self.assertIn(
                tbl, snapshot["tables"],
                f"Export payload is missing required table key '{tbl}'",
            )


# ──────────────────────────────────────────────────────────────────────────────
# Test 4: concurrent imports are serialized — no interleaving, consistent state
# ──────────────────────────────────────────────────────────────────────────────

def _make_users_tx_serializing(state, py_lock):
    """Like _make_users_tx but the cursor acquires *py_lock* when it sees a
    ``pg_advisory_xact_lock`` call, simulating Postgres advisory-lock
    serialization.  The lock is released in the ``finally`` block so it is
    freed on both commit and rollback."""

    @contextlib.contextmanager
    def _fake_tx(lock=False):
        snapshot = copy.deepcopy(state)
        lock_acquired = []

        class _SerializingCursor(_FakeCursor):
            def execute(self, query, params=None):
                if "pg_advisory_xact_lock" in query:
                    py_lock.acquire()
                    lock_acquired.append(True)
                    return
                super().execute(query, params)

        cursor = _SerializingCursor(state)
        try:
            yield cursor
            # commit — state already mutated in-place by _SerializingCursor
        except Exception:
            state.clear()
            state.update(snapshot)
            raise
        finally:
            if lock_acquired:
                py_lock.release()

    return _fake_tx


class ConcurrentImportTests(unittest.TestCase):
    """Two simultaneous imports for the same folder must not corrupt each other.

    The endpoint acquires ``pg_advisory_xact_lock(_L10_IMPORT_LOCK_KEY)`` as
    the first statement inside its transaction so concurrent callers queue
    behind the lock rather than interleave their delete→insert sequences.

    The fake ``_users_tx`` provided here uses a real ``threading.Lock`` on the
    ``pg_advisory_xact_lock`` call to reproduce the serialization in the
    in-memory test environment.
    """

    def _complete_payload(self, extra_meetings=None):
        """Return a complete valid payload for folder 42, optionally with
        additional meeting rows beyond the base two."""
        tables = {tbl: [] for tbl in api_pg._L10_INSERT_ORDER}
        tables["l10_folders"] = [{"id": _FOLDER_ID, "name": "Leadership", "team_name": "L10"}]
        tables["l10_meetings"] = [
            {"id": 100, "folder_id": _FOLDER_ID, "week_label": "2026-W01",
             "meeting_date": "2026-01-05", "start_time": None},
            {"id": 101, "folder_id": _FOLDER_ID, "week_label": "2026-W02",
             "meeting_date": "2026-01-12", "start_time": None},
        ]
        if extra_meetings:
            tables["l10_meetings"].extend(extra_meetings)
        tables["l10_members"] = [{"id": 200, "folder_id": _FOLDER_ID, "name": "Alice"}]
        return {"tables": tables}

    @staticmethod
    def _run_in_thread(coro):
        """Run an async coroutine in the calling thread using a fresh event loop.

        ``asyncio.get_event_loop()`` raises RuntimeError in non-main threads on
        Python ≥ 3.10; creating an explicit new loop avoids the failure."""
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def test_concurrent_imports_both_complete_without_error(self):
        """Both concurrent imports must finish successfully (neither is rejected
        and neither raises — they queue behind the advisory lock)."""
        import threading

        state = _initial_state()
        py_lock = threading.Lock()

        payload_a = self._complete_payload(extra_meetings=[
            {"id": 102, "folder_id": _FOLDER_ID, "week_label": "2026-W03",
             "meeting_date": "2026-01-19", "start_time": None},
        ])
        payload_b = self._complete_payload(extra_meetings=[
            {"id": 103, "folder_id": _FOLDER_ID, "week_label": "2026-W04",
             "meeting_date": "2026-01-26", "start_time": None},
        ])

        errors = []
        results = []
        barrier = threading.Barrier(2)

        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_tx",
                               side_effect=_make_users_tx_serializing(state, py_lock)):

            def run_import(payload):
                try:
                    barrier.wait()  # both threads enter the endpoint together
                    r = self._run_in_thread(api_pg.l10_import(_FakeRequest(payload)))
                    results.append(r)
                except Exception as e:  # pragma: no cover
                    errors.append(e)

            t1 = threading.Thread(target=run_import, args=(payload_a,), daemon=True)
            t2 = threading.Thread(target=run_import, args=(payload_b,), daemon=True)
            t1.start()
            t2.start()
            t1.join(timeout=5)
            t2.join(timeout=5)

        self.assertEqual(errors, [], f"Unexpected errors from concurrent imports: {errors}")
        self.assertEqual(len(results), 2, "Not all concurrent imports returned a result")

    def test_concurrent_imports_leave_consistent_final_state(self):
        """After two concurrent imports the DB state must exactly match one of
        the two payloads — no rows from both, no empty tables."""
        import threading

        state = _initial_state()
        py_lock = threading.Lock()

        # Payload A: base meetings (100, 101) + meeting 102
        payload_a = self._complete_payload(extra_meetings=[
            {"id": 102, "folder_id": _FOLDER_ID, "week_label": "2026-W03",
             "meeting_date": "2026-01-19", "start_time": None},
        ])
        # Payload B: base meetings (100, 101) + meeting 103
        payload_b = self._complete_payload(extra_meetings=[
            {"id": 103, "folder_id": _FOLDER_ID, "week_label": "2026-W04",
             "meeting_date": "2026-01-26", "start_time": None},
        ])

        errors = []
        barrier = threading.Barrier(2)

        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_tx",
                               side_effect=_make_users_tx_serializing(state, py_lock)):

            def run_import(payload):
                barrier.wait()
                try:
                    self._run_in_thread(api_pg.l10_import(_FakeRequest(payload)))
                except Exception as e:  # pragma: no cover
                    errors.append(e)

            t1 = threading.Thread(target=run_import, args=(payload_a,), daemon=True)
            t2 = threading.Thread(target=run_import, args=(payload_b,), daemon=True)
            t1.start()
            t2.start()
            t1.join(timeout=5)
            t2.join(timeout=5)

        self.assertEqual(errors, [], f"Errors during concurrent imports: {errors}")

        meeting_ids = frozenset(r["id"] for r in state["l10_meetings"])

        # Final state must exactly match one of the two payloads.
        valid_a = frozenset({100, 101, 102})
        valid_b = frozenset({100, 101, 103})
        self.assertIn(
            meeting_ids, (valid_a, valid_b),
            f"Final meeting IDs {meeting_ids} are not consistent with either payload "
            f"(expected {valid_a} or {valid_b}); concurrent writes interleaved.",
        )

    def test_advisory_lock_is_acquired_during_import(self):
        """The import must call ``pg_advisory_xact_lock`` inside the transaction
        so the serialization guarantee is actually in place."""
        state = _initial_state()
        lock_calls = []

        class _SpyCursor(_FakeCursor):
            def execute(self, query, params=None):
                if "pg_advisory_xact_lock" in query:
                    lock_calls.append(params)
                    return
                super().execute(query, params)

        @contextlib.contextmanager
        def _spy_tx(lock=False):
            snapshot = copy.deepcopy(state)
            cursor = _SpyCursor(state)
            try:
                yield cursor
            except Exception:
                state.clear()
                state.update(snapshot)
                raise

        payload = self._complete_payload()
        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_tx", side_effect=_spy_tx):
            _run(api_pg.l10_import(_FakeRequest(payload)))

        self.assertGreater(
            len(lock_calls), 0,
            "pg_advisory_xact_lock was never called — advisory lock is missing",
        )
        # Verify it was called with _L10_IMPORT_LOCK_KEY, not some other key.
        self.assertIn(
            (api_pg._L10_IMPORT_LOCK_KEY,), lock_calls,
            f"pg_advisory_xact_lock was not called with _L10_IMPORT_LOCK_KEY "
            f"({api_pg._L10_IMPORT_LOCK_KEY:#x}); calls were {lock_calls}",
        )


if __name__ == "__main__":
    unittest.main()
