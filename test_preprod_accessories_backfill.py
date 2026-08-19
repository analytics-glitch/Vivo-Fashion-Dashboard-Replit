"""Regression tests for the one-time Pre-production Accessories % retrofit.

The tests exercise the real batch function against a narrow in-memory database
fake. They verify the controlled locked-sheet bypass, one common Done-DPS pick,
targeted line updates, no-history retention, audit rows, and idempotent reruns.
"""
import copy
import json
import os
import threading
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr


class Store:
    def __init__(self):
        self.sheets = []
        self.lines = []
        self.history = []

    def add_sheet(self, sheet_id, *, stage="pre_production", pct=13,
                  meta=None, locked=False, style=None):
        self.sheets.append({
            "id": sheet_id,
            "style_name": style or f"Style {sheet_id}",
            "stage": stage,
            "accessories_pct": pct,
            "accessories_pct_meta": meta,
            "locked": locked,
        })

    def add_line(self, line_id, sheet_id, kind, label, qty, unit_cost,
                 total=None, is_auto=False, source=None, position=0,
                 component_id=None):
        self.lines.append({
            "id": line_id, "sheet_id": sheet_id, "kind": kind,
            "label": label, "qty": qty, "unit_cost": unit_cost,
            "total": qty * unit_cost if total is None else total,
            "is_auto": is_auto, "source": source, "position": position,
            "component_id": component_id,
        })


class Cursor:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=()):
        normalized = " ".join(sql.split())
        if normalized.startswith(("SAVEPOINT ", "RELEASE SAVEPOINT ",
                                  "ROLLBACK TO SAVEPOINT ")):
            return
        if normalized.startswith("UPDATE fabric_costing_sheets SET accessories_pct="):
            pct, meta_json, sheet_id = params
            sheet = next(s for s in self.store.sheets if s["id"] == sheet_id)
            if sheet["accessories_pct_meta"] is None:
                sheet["accessories_pct"] = pct
                sheet["accessories_pct_meta"] = json.loads(meta_json)
            return
        if (normalized.startswith("UPDATE fabric_costing_lines SET label=")
                and "qty=%s" in normalized):
            (label, qty, unit_cost, total, is_auto, source, component_id,
             line_id, sheet_id) = params
            line = next(l for l in self.store.lines
                        if l["id"] == line_id and l["sheet_id"] == sheet_id)
            line.update({
                "label": label, "qty": qty, "unit_cost": unit_cost,
                "total": total, "is_auto": is_auto, "source": source,
                "component_id": component_id,
            })
            return
        if normalized.startswith("UPDATE fabric_costing_lines SET label="):
            label, is_auto, source, line_id, sheet_id = params
            line = next(l for l in self.store.lines
                        if l["id"] == line_id and l["sheet_id"] == sheet_id)
            line.update({"label": label, "is_auto": is_auto, "source": source})
            return
        if normalized.startswith("DELETE FROM fabric_costing_lines"):
            sheet_id, ids = params
            ids = set(ids)
            self.store.lines = [
                l for l in self.store.lines
                if not (l["sheet_id"] == sheet_id and l["id"] in ids)]
            return
        if normalized.startswith("INSERT INTO fabric_costing_history"):
            self.store.history.append({
                "sheet_id": params[0], "action": params[1],
                "changed_by": params[2], "changed_by_name": params[3],
                "summary": params[4], "snapshot": json.loads(params[5]),
            })
            return
        raise AssertionError(f"Unexpected SQL: {sql}")


class Conn:
    def __init__(self, store):
        self.store = store
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self, *args, **kwargs):
        return Cursor(self.store)

    def commit(self):
        self.commits += 1


def fake_q(store):
    def q(conn, sql, params=()):
        if "FROM fabric_costing_sheets s" in sql:
            return [copy.deepcopy(s) for s in store.sheets
                    if (s.get("stage") or "main_production") == "pre_production"]
        if "FROM fabric_costing_lines" in sql:
            sheet_id = params[0]
            return [copy.deepcopy(l) for l in sorted(
                (l for l in store.lines if l["sheet_id"] == sheet_id),
                key=lambda row: (row["position"], row["id"]))]
        raise AssertionError(f"Unexpected query: {sql}")
    return q


PICK = {
    "pct": 8.981039134139472,
    "meta": {
        "pct": 8.981039134139472,
        "source_month": "2026-07",
        "month_label": "Jul 2026",
        "dps_count": 75,
        "fallback": False,
        "is_default": False,
        "requested_month": "2026-07",
        "requested_month_label": "Jul 2026",
        "picked_at": "2026-08-19T10:00:00+03:00",
    },
}


def seed_costing(store, sheet_id, *, basis, pct=13, locked=False):
    store.add_sheet(sheet_id, pct=pct, locked=locked)
    store.add_line(sheet_id * 10, sheet_id, "fabric", "Main fabric",
                   1, basis, position=0, component_id=sheet_id)
    store.add_line(sheet_id * 10 + 1, sheet_id, "trim",
                   f"Accessories ({pct}% of fabric cost)",
                   1, round(basis * pct / 100, 2), is_auto=False,
                   source=None, position=1)
    store.add_line(sheet_id * 10 + 2, sheet_id, "trim", "Buttons",
                   2, 7.5, total=15, is_auto=False, source="manual",
                   position=2, component_id=999)


class PickedBackfill(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        seed_costing(self.store, 1, basis=908.10, locked=False)
        seed_costing(self.store, 2, basis=451.00, locked=True)
        self.store.add_sheet(3, stage="main_production", pct=13)
        self.patch_q = mock.patch.object(fr, "q", fake_q(self.store))
        self.patch_pick = mock.patch.object(
            fr, "_preprod_accessories_pick",
            lambda conn, today=None: copy.deepcopy(PICK))
        self.patch_q.start()
        self.patch_pick.start()
        self.addCleanup(self.patch_q.stop)
        self.addCleanup(self.patch_pick.stop)
        self.conn = Conn(self.store)

    def test_common_pick_updates_locked_and_unlocked_sheets(self):
        out = fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        self.assertEqual(out["picked"], 2)
        self.assertEqual(out["retained"], 0)
        self.assertEqual(out["locked_updated"], 1)
        self.assertEqual(out["source_month"], "2026-07")
        self.assertEqual(out["dps_count"], 75)

        sheets = {s["id"]: s for s in self.store.sheets}
        self.assertEqual(sheets[3]["accessories_pct_meta"], None,
                         "Main Production must not be touched")
        for sid in (1, 2):
            self.assertAlmostEqual(
                sheets[sid]["accessories_pct"], PICK["pct"], places=10)
            meta = sheets[sid]["accessories_pct_meta"]
            self.assertEqual(meta["source_month"], "2026-07")
            self.assertEqual(meta["dps_count"], 75)
            self.assertEqual(meta["retrofit_status"], "picked")
            self.assertEqual(meta["migration_key"], fr._PP_ACC_BACKFILL_KEY)

        accessories = {
            l["sheet_id"]: l for l in self.store.lines
            if l["label"].startswith("Accessories (")}
        self.assertEqual(accessories[1]["unit_cost"], 81.56)
        self.assertEqual(accessories[1]["total"], 81.56)
        self.assertEqual(accessories[2]["unit_cost"], 40.50)
        self.assertIn("Jul 2026 Done-DPS avg, 75 DPS",
                      accessories[1]["label"])
        self.assertTrue(accessories[2]["is_auto"])

    def test_unrelated_lines_and_fields_remain_unchanged(self):
        before = copy.deepcopy([
            l for l in self.store.lines if l["label"] == "Buttons"])
        fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        after = [l for l in self.store.lines if l["label"] == "Buttons"]
        self.assertEqual(after, before)

    def test_one_audit_event_per_changed_sheet(self):
        fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(
            {h["action"] for h in self.store.history},
            {"accessories_pct_retrofit"})
        locked_snapshot = next(
            h["snapshot"] for h in self.store.history
            if h["sheet_id"] == 2)
        self.assertTrue(locked_snapshot["approved_sheet"])
        self.assertEqual(
            locked_snapshot["accessories_pct_meta"]["source_month"],
            "2026-07")

    def test_rerun_is_idempotent(self):
        first = fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        lines_after_first = copy.deepcopy(self.store.lines)
        second = fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        self.assertEqual(first["picked"], 2)
        self.assertEqual(second["picked"], 0)
        self.assertEqual(second["skipped"], 2)
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(self.store.lines, lines_after_first,
                         "reruns must not compound rounding or labels")


class RetainedBackfill(unittest.TestCase):
    def test_no_history_keeps_percentage_and_cost_but_records_reason(self):
        store = Store()
        seed_costing(store, 4, basis=800, pct=15, locked=True)
        original_accessories = next(
            l for l in store.lines if l["label"].startswith("Accessories ("))
        original_cost = (original_accessories["qty"],
                         original_accessories["unit_cost"],
                         original_accessories["total"])
        no_history = copy.deepcopy(PICK)
        no_history["pct"] = 13.0
        no_history["meta"].update({
            "pct": 13.0, "source_month": None, "month_label": None,
            "dps_count": 0, "is_default": True,
        })
        with mock.patch.object(fr, "q", fake_q(store)), \
                mock.patch.object(
                    fr, "_preprod_accessories_pick",
                    lambda conn, today=None: copy.deepcopy(no_history)):
            out = fr._preprod_accessories_backfill(
                Conn(store), "admin-1", "Admin User")

        self.assertEqual(out["picked"], 0)
        self.assertEqual(out["retained"], 1)
        sheet = store.sheets[0]
        self.assertEqual(sheet["accessories_pct"], 15)
        self.assertEqual(
            sheet["accessories_pct_meta"]["retrofit_status"],
            "retained_no_history")
        line = next(
            l for l in store.lines if l["label"].startswith("Accessories ("))
        self.assertEqual((line["qty"], line["unit_cost"], line["total"]),
                         original_cost)
        self.assertIn("retained (no qualifying Done-DPS history)",
                      line["label"])
        self.assertIn("retained 15%", store.history[0]["summary"])


class AccessAndSurfaceContract(unittest.TestCase):
    def test_maintenance_endpoint_rejects_non_admin(self):
        request = SimpleNamespace(state=SimpleNamespace(
            user={"role": "leadership", "user_id": "u-1", "name": "Lead"}))
        with self.assertRaises(HTTPException) as ctx:
            fr.costing_backfill_preprod_accessories(request)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_list_and_editor_sources_expose_retrofit_provenance(self):
        with open("fabric_dashboard_live.html", encoding="utf-8") as fh:
            html = fh.read()
        self.assertIn("s.accessories_pct_meta", html)
        self.assertIn("retained (no qualifying Done-DPS history)", html)
        self.assertIn("backfilled automatically", html)


TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")


@unittest.skipUnless(TEST_DB_URL, "TEST_DATABASE_URL not set")
class PostgresConcurrentRetrofit(unittest.TestCase):
    """Exercise the real row locks with two PostgreSQL sessions.

    The normal unit fakes cannot show whether ``FOR UPDATE`` actually queues a
    stale editor behind the retrofit.  Each test creates a private schema and
    shadows only the costing tables there, so no application data is read or
    written.
    """

    PICK = {
        "pct": 8.981039134139472,
        "meta": {
            "pct": 8.981039134139472,
            "source_month": "2026-07",
            "month_label": "Jul 2026",
            "dps_count": 75,
            "fallback": False,
            "is_default": False,
            "requested_month": "2026-07",
            "requested_month_label": "Jul 2026",
        },
    }

    def setUp(self):
        import psycopg2

        self.psycopg2 = psycopg2
        self.schema = "costing_retrofit_test_" + uuid.uuid4().hex
        # TEST_DATABASE_URL is deliberately separate from the application's
        # DATABASE_URL.  The registered integration-test command supplies a
        # disposable local PostgreSQL database and never exposes app data.
        bootstrap = psycopg2.connect(TEST_DB_URL)
        bootstrap.autocommit = True
        try:
            with bootstrap.cursor() as cur:
                cur.execute(f"CREATE SCHEMA {self.schema}")
        finally:
            bootstrap.close()

        self.admin = self._scoped_conn()
        self.admin.autocommit = True
        with self.admin.cursor() as cur:
            cur.execute("""
                CREATE TABLE fabric_costing_sheets (
                    id SERIAL PRIMARY KEY,
                    style_name TEXT NOT NULL,
                    selling_price NUMERIC,
                    selling_price_is_auto BOOLEAN DEFAULT TRUE,
                    notes TEXT,
                    dps_ref TEXT,
                    color TEXT,
                    embroidery_data JSONB,
                    stage TEXT DEFAULT 'main_production',
                    accessories_pct NUMERIC DEFAULT 13,
                    accessories_pct_meta JSONB,
                    defect_allowance_pct NUMERIC DEFAULT 10,
                    mtrs_per_garment NUMERIC,
                    cost_per_minute NUMERIC,
                    cmt_start_time TEXT,
                    cmt_stop_time TEXT,
                    production_multiplier NUMERIC,
                    created_by TEXT,
                    created_by_name TEXT,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    updated_by TEXT,
                    updated_by_name TEXT,
                    updated_at TIMESTAMPTZ DEFAULT now()
                );
                CREATE TABLE fabric_costing_lines (
                    id SERIAL PRIMARY KEY,
                    sheet_id INTEGER NOT NULL REFERENCES fabric_costing_sheets(id)
                        ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    label TEXT,
                    qty NUMERIC,
                    unit_cost NUMERIC,
                    total NUMERIC,
                    is_auto BOOLEAN DEFAULT FALSE,
                    source TEXT,
                    position INTEGER DEFAULT 0,
                    component_id BIGINT
                );
                CREATE TABLE fabric_costing_history (
                    id SERIAL PRIMARY KEY,
                    sheet_id INTEGER NOT NULL REFERENCES fabric_costing_sheets(id)
                        ON DELETE CASCADE,
                    action TEXT NOT NULL,
                    changed_by TEXT,
                    changed_by_name TEXT,
                    changed_at TIMESTAMPTZ DEFAULT now(),
                    summary TEXT,
                    snapshot JSONB
                );
                CREATE TABLE fabric_costing_signoffs (
                    id SERIAL PRIMARY KEY,
                    sheet_id INTEGER NOT NULL REFERENCES fabric_costing_sheets(id)
                        ON DELETE CASCADE,
                    step INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    signed_by TEXT,
                    signed_by_name TEXT,
                    signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    UNIQUE (sheet_id, step)
                );
            """)
        self.addCleanup(self._drop_schema)

    def _drop_schema(self):
        try:
            self.admin.rollback()
            with self.admin.cursor() as cur:
                cur.execute(f"DROP SCHEMA IF EXISTS {self.schema} CASCADE")
        finally:
            self.admin.close()

    def _scoped_conn(self):
        # Set the schema in the startup packet for every physical connection;
        # no post-commit/session SET can be lost to a transaction pooler.
        return self.psycopg2.connect(
            TEST_DB_URL,
            options=f"-c search_path={self.schema},pg_catalog")

    def _conn(self):
        conn = self._scoped_conn()
        self.addCleanup(conn.close)
        return conn

    @staticmethod
    def _direct_q(conn, sql, params=()):
        with conn.cursor(cursor_factory=fr.psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def _seed_legacy_sheet(self, *, approved=False):
        with self.admin.cursor() as cur:
            cur.execute("""
                INSERT INTO fabric_costing_sheets
                    (style_name, selling_price, stage, accessories_pct,
                     defect_allowance_pct, mtrs_per_garment, cost_per_minute)
                VALUES ('Concurrent legacy style', 1000, 'pre_production',
                        13, 10, 1, 5)
                RETURNING id
            """)
            sheet_id = cur.fetchone()[0]
            cur.executemany("""
                INSERT INTO fabric_costing_lines
                    (sheet_id, kind, label, qty, unit_cost, total, is_auto,
                     source, position)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, [
                (sheet_id, "fabric", "Main fabric", 1, 100, 100, True, None, 0),
                (sheet_id, "trim", "Accessories (13% of fabric cost)",
                 1, 13, 13, False, None, 1),
                (sheet_id, "trim", "Buttons", 2, 7.5, 15, False, "manual", 2),
            ])
            if approved:
                cur.execute("""
                    INSERT INTO fabric_costing_signoffs
                        (sheet_id, step, title, signed_by, signed_by_name)
                    VALUES (%s, 3, 'Approved by', 'approver', 'Approver')
                """, (sheet_id,))
        return sheet_id

    @staticmethod
    def _editor_body():
        return {
            "stage": "pre_production",
            "selling_price": None,
            "notes": "stale editor save",
            "defect_allowance_pct": 10,
            "mtrs_per_garment": 1,
            "cost_per_minute": 5,
            "lines": [
                {"kind": "fabric", "label": "Main fabric", "qty": 1,
                 "unit_cost": 100, "is_auto": True, "source": None},
                # This is intentionally stale: the save must re-stamp it from
                # the retrofit state it reads after obtaining the row lock.
                {"kind": "trim", "label": "Accessories (13% of fabric cost)",
                 "qty": 1, "unit_cost": 13, "is_auto": False, "source": None},
                {"kind": "trim", "label": "Buttons", "qty": 2,
                 "unit_cost": 7.5, "is_auto": False, "source": "manual"},
            ],
        }

    def _assert_editor_is_lock_blocked(self, backend_pid, editor_done):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with self.admin.cursor() as cur:
                cur.execute("""
                    SELECT wait_event_type
                    FROM pg_catalog.pg_stat_activity
                    WHERE pid=%s
                """, (backend_pid,))
                row = cur.fetchone()
            if row and row[0] == "Lock":
                self.assertFalse(
                    editor_done.is_set(),
                    "editor completed despite reporting a lock wait")
                return
            if editor_done.is_set():
                self.fail("editor completed before blocking on the sheet row")
            time.sleep(0.02)
        self.fail("PostgreSQL never reported the editor waiting on the row lock")

    def _run_race(self, sheet_id):
        backfill_conn, editor_conn = self._conn(), self._conn()
        retrofit_locked = threading.Event()
        editor_attempted_lock = threading.Event()
        editor_done = threading.Event()
        release_retrofit = threading.Event()
        errors, outcomes = [], {}

        def serializing_q(conn, sql, params=()):
            normalized = " ".join(sql.split())
            if ("FROM fabric_costing_sheets s" in normalized
                    and "FOR UPDATE" in normalized):
                rows = self._direct_q(conn, sql, params)
                retrofit_locked.set()
                self.assertTrue(
                    release_retrofit.wait(10),
                    "test did not release the retrofit transaction")
                return rows
            if (normalized.startswith("SELECT * FROM fabric_costing_sheets")
                    and "FOR UPDATE" in normalized):
                editor_attempted_lock.set()
            return self._direct_q(conn, sql, params)

        def retrofit():
            try:
                outcomes["retrofit"] = fr._preprod_accessories_backfill(
                    backfill_conn, "admin", "Admin", today=None)
                backfill_conn.commit()
            except BaseException as exc:
                backfill_conn.rollback()
                errors.append(exc)

        def editor():
            try:
                outcomes["editor"] = fr.costing_sheet_update(
                    sheet_id,
                    SimpleNamespace(state=SimpleNamespace(user={
                        "user_id": "editor", "name": "Editor"})),
                    self._editor_body())
            except BaseException as exc:
                editor_conn.rollback()
                outcomes["editor_error"] = exc
            finally:
                editor_done.set()

        with mock.patch.object(fr, "q", serializing_q), \
                mock.patch.object(fr, "_get_conn", lambda: editor_conn), \
                mock.patch.object(fr, "_ensure_costing_tables", lambda conn: None), \
                mock.patch.object(fr, "_costing_require_editor", lambda request: None), \
                mock.patch.object(fr, "_preprod_accessories_pick",
                                  lambda conn, today=None: copy.deepcopy(self.PICK)), \
                mock.patch.object(fr, "_sheet_payload",
                                  lambda conn, sid, **kwargs: {"id": sid}):
            retrofit_thread = threading.Thread(target=retrofit)
            retrofit_thread.start()
            self.assertTrue(retrofit_locked.wait(10), "retrofit never locked sheet")
            editor_thread = threading.Thread(target=editor)
            editor_thread.start()
            self.assertTrue(editor_attempted_lock.wait(10), "editor never attempted lock")
            try:
                self._assert_editor_is_lock_blocked(
                    editor_conn.get_backend_pid(), editor_done)
            finally:
                release_retrofit.set()
            retrofit_thread.join(15)
            editor_thread.join(15)

        self.assertFalse(retrofit_thread.is_alive(), "retrofit deadlocked")
        self.assertFalse(editor_thread.is_alive(), "editor deadlocked")
        self.assertEqual(errors, [])
        return outcomes

    def test_retrofit_and_stale_editor_save_keep_one_consistent_state(self):
        sheet_id = self._seed_legacy_sheet()
        outcomes = self._run_race(sheet_id)
        self.assertNotIn("editor_error", outcomes)
        self.assertEqual(outcomes["retrofit"]["picked"], 1)

        with self.admin.cursor() as cur:
            cur.execute("""
                SELECT accessories_pct, accessories_pct_meta
                FROM fabric_costing_sheets WHERE id=%s
            """, (sheet_id,))
            pct, meta = cur.fetchone()
            cur.execute("""
                SELECT label, qty, unit_cost, total, is_auto, source
                FROM fabric_costing_lines WHERE sheet_id=%s ORDER BY position, id
            """, (sheet_id,))
            lines = cur.fetchall()
            cur.execute("""
                SELECT action, COUNT(*) FROM fabric_costing_history
                WHERE sheet_id=%s GROUP BY action
            """, (sheet_id,))
            history = dict(cur.fetchall())

        self.assertAlmostEqual(float(pct), self.PICK["pct"], places=10)
        self.assertEqual(meta["retrofit_status"], "picked")
        accessories = next(line for line in lines if line[0].startswith("Accessories"))
        self.assertEqual(float(accessories[2]), 8.98)
        self.assertEqual(float(accessories[3]), 8.98)
        self.assertTrue(accessories[4])
        self.assertIn("Jul 2026 Done-DPS avg, 75 DPS", accessories[0])
        self.assertIn(("Buttons", 2, 7.5, 15, False, "manual"), lines)
        self.assertEqual(history.get("accessories_pct_retrofit"), 1)
        self.assertEqual(history.get("updated"), 1)

    def test_retrofit_still_applies_once_when_approved_editor_is_queued(self):
        sheet_id = self._seed_legacy_sheet(approved=True)
        outcomes = self._run_race(sheet_id)
        self.assertEqual(outcomes["retrofit"]["picked"], 1)
        self.assertIsInstance(outcomes.get("editor_error"), HTTPException)
        self.assertEqual(outcomes["editor_error"].status_code, 409)

        with self.admin.cursor() as cur:
            cur.execute("""
                SELECT accessories_pct_meta FROM fabric_costing_sheets WHERE id=%s
            """, (sheet_id,))
            meta = cur.fetchone()[0]
            cur.execute("""
                SELECT label, qty, unit_cost, total FROM fabric_costing_lines
                WHERE sheet_id=%s ORDER BY position, id
            """, (sheet_id,))
            lines = cur.fetchall()
            cur.execute("""
                SELECT action, COUNT(*) FROM fabric_costing_history
                WHERE sheet_id=%s GROUP BY action
            """, (sheet_id,))
            history = dict(cur.fetchall())

        self.assertEqual(meta["retrofit_status"], "picked")
        self.assertEqual(len(lines), 3, "approved save must not delete any lines")
        self.assertIn(("Buttons", 2, 7.5, 15), lines)
        self.assertEqual(history, {"accessories_pct_retrofit": 1})


if __name__ == "__main__":
    unittest.main()