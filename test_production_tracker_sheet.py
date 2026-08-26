"""Regression coverage for the Production Tracker 2026 Google Sheet feed
(Task #1607).

Two independent layers of coverage:

1. Pure-Python tests (no database) against `production_tracker_sheet_sync`'s
   parsing/validation/calculation functions — these enforce the governance
   rules that must never regress: missing data is `is_available=False`
   (never a zero), the sheet's broken "Average Output per Person" formula is
   never trusted, the three conflicting annual totals are all surfaced
   verbatim, and "Wooven" is normalized to "Woven" without losing the raw
   label.

2. Disposable-PostgreSQL integration tests (only run when TEST_DATABASE_URL
   is set, per this repo's convention) against the real staging/promotion
   SQL and the real `production_workspace` route handlers (with `_API`
   monkeypatched onto the throwaway database) — covering idempotent
   promotion, quarantine, permissions/audit, connection-pending, and
   last-known-good behavior on a failed run.
"""

import os
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone

import production_tracker_sheet_sync as sync


# --------------------------------------------------------------------------- #
# 1. Pure-Python parsing / calculation tests                                  #
# --------------------------------------------------------------------------- #
class ParsePayloadTests(unittest.TestCase):
    def test_missing_monthly_cell_is_unavailable_never_zero(self):
        rows, warnings = sync.parse_payload(
            {"monthly": [["Stitched Actual 2026", "100", "", "300"]]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        by_month = {r["period_key"]: r for r in rows}
        self.assertEqual(by_month["2026-02"]["parsed_value"], None)
        self.assertFalse(by_month["2026-02"]["is_available"])
        self.assertEqual(by_month["2026-01"]["parsed_value"], 100)
        self.assertTrue(by_month["2026-01"]["is_available"])
        self.assertFalse(warnings)

    def test_current_month_actual_is_flagged_partial(self):
        rows, _ = sync.parse_payload(
            {"monthly": [["Stitched Actual 2026"] + ["10"] * 12]},
            as_of=datetime(2026, 8, 15, tzinfo=timezone.utc),
        )
        by_month = {r["period_key"]: r for r in rows}
        self.assertTrue(by_month["2026-08"]["is_partial_period"])
        self.assertFalse(by_month["2026-07"]["is_partial_period"])
        self.assertFalse(by_month["2025-08"]["is_partial_period"] if "2025-08" in by_month else False)

    def test_wooven_normalized_to_woven_lineage_preserved(self):
        rows, _ = sync.parse_payload(
            {"monthly": [["Wooven Actual 2026"] + ["5"] * 12]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(row["metric_group"], "fabric_mix")
            self.assertEqual(row["dimension"], "woven")
            self.assertEqual(row["normalized_label"], "Woven")
            # Raw sheet wording is retained, not discarded.
            self.assertEqual(row["source_label"], "Wooven Actual 2026")

    def test_unrecognized_row_warns_and_is_skipped_not_guessed(self):
        rows, warnings = sync.parse_payload(
            {"summary": [["Some new totally unknown metric", "123"]]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        self.assertEqual(rows, [])
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["code"], "unrecognized_sheet_row")

    def test_three_conflicting_annual_totals_all_surfaced_distinctly(self):
        rows, _ = sync.parse_payload(
            {"summary": [
                ["Expected Output 2026", "402413"],
                ["Monthly Production Plan Total 2026", "387960"],
                ["Quarterly Plan Total 2026", "374780"],
            ]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        by_dim = {r["dimension"]: r["parsed_value"] for r in rows}
        self.assertEqual(by_dim["expected_output"], 402413)
        self.assertEqual(by_dim["monthly_plan_rollup"], 387960)
        self.assertEqual(by_dim["quarterly_plan_total"], 374780)
        # Never averaged, never picked-as-winner: three distinct values persist.
        self.assertEqual(len({by_dim["expected_output"], by_dim["monthly_plan_rollup"],
                               by_dim["quarterly_plan_total"]}), 3)


class DefectMetricsTests(unittest.TestCase):
    def test_defect_labeled_row_is_captured_as_quality_defects_not_dropped(self):
        rows, warnings = sync.parse_payload(
            {"process": [["Defects 2026"] + ["12", "9", "", "4"] + [""] * 8]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        defect_rows = [r for r in rows if r["metric_group"] == "quality_defects"]
        self.assertTrue(defect_rows)
        by_month = {r["period_key"]: r for r in defect_rows}
        self.assertEqual(by_month["2026-01"]["dimension"], "defect_units")
        self.assertEqual(by_month["2026-01"]["parsed_value"], 12)
        self.assertTrue(by_month["2026-01"]["is_available"])
        # A blank cell in a recognized defect row is unavailable, never zero.
        self.assertIsNone(by_month["2026-03"]["parsed_value"])
        self.assertFalse(by_month["2026-03"]["is_available"])
        # A row we can actually name is never reported as unrecognized.
        self.assertFalse(any(w["code"] == "unrecognized_sheet_row" for w in warnings))

    def test_reject_and_rework_rows_map_to_distinct_dimensions(self):
        rows, _ = sync.parse_payload(
            {"process": [
                ["Rejects 2026"] + ["3"] * 12,
                ["Rework 2026"] + ["2"] * 12,
            ]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        dims = {r["dimension"] for r in rows if r["metric_group"] == "quality_defects"}
        self.assertEqual(dims, {"rejected_units", "reworked_units"})


class ProcessProductivityTests(unittest.TestCase):
    def test_broken_average_formula_is_warned_not_plotted(self):
        rows, warnings = sync.parse_payload(
            {"process": [
                ["Average Output per Person 2026"] + ["999"] * 12,
                ["Stitch Output 2026"] + ["100"] * 12,
                ["Stitch Operators 2026"] + ["10"] * 12,
            ]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        dims = {r["dimension"] for r in rows}
        self.assertNotIn("average_output_per_person", dims)
        self.assertIn("stitched_output_per_operator_day", dims)
        codes = {w["code"] for w in warnings}
        self.assertIn("broken_average_output_formula", codes)

    def test_output_per_operator_day_computed_independently(self):
        rows, _ = sync.parse_payload(
            {"process": [
                ["Stitch Output 2026"] + ["1000"] + [""] * 11,
                ["Stitch Operators 2026"] + ["10"] + [""] * 11,
            ]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        computed = next(r for r in rows if r["dimension"] == "stitched_output_per_operator_day"
                         and r["period_key"] == "2026-01")
        working_days = sync._working_days_in_month("2026-01")
        self.assertAlmostEqual(computed["parsed_value"], round(1000 / 10 / working_days, 2))
        self.assertTrue(computed["is_available"])

    def test_missing_headcount_leaves_computed_metric_unavailable_not_zero(self):
        rows, _ = sync.parse_payload(
            {"process": [["Stitch Output 2026"] + ["1000"] + [""] * 11]},
            as_of=datetime(2026, 8, 26, tzinfo=timezone.utc),
        )
        computed = next(r for r in rows if r["dimension"] == "stitched_output_per_operator_day"
                         and r["period_key"] == "2026-01")
        self.assertFalse(computed["is_available"])
        self.assertIsNone(computed["parsed_value"])


class ValidateTests(unittest.TestCase):
    def test_available_without_numeric_value_is_quarantined(self):
        rows = sync.validate([{"is_available": True, "parsed_value": None}])
        self.assertEqual(rows[0]["validation_status"], "quarantined")

    def test_negative_value_is_quarantined(self):
        rows = sync.validate([{"is_available": True, "parsed_value": -5}])
        self.assertEqual(rows[0]["validation_status"], "quarantined")

    def test_normal_row_passes(self):
        rows = sync.validate([{"is_available": True, "parsed_value": 42}])
        self.assertEqual(rows[0]["validation_status"], "ok")

    def test_unavailable_row_with_no_value_is_not_quarantined(self):
        rows = sync.validate([{"is_available": False, "parsed_value": None}])
        self.assertEqual(rows[0]["validation_status"], "ok")


class BaselineSeedTests(unittest.TestCase):
    def test_seed_rows_carry_the_confirmed_conflicting_totals(self):
        rows, warnings = sync.baseline_seed_rows()
        annual = {r["dimension"]: r["parsed_value"] for r in rows if r["metric_group"] == "annual_totals"}
        self.assertEqual(annual["expected_output"], 402413)
        self.assertEqual(annual["monthly_plan_rollup"], 387960)
        self.assertEqual(annual["quarterly_plan_total"], 374780)
        codes = {w["code"] for w in warnings}
        self.assertIn("conflicting_annual_totals", codes)
        self.assertIn("broken_average_output_formula", codes)

    def test_seed_sep_to_dec_actuals_are_unavailable_not_zero(self):
        rows, _ = sync.baseline_seed_rows()
        sep_actual = next(r for r in rows if r["metric_group"] == "stitched_output"
                           and r["dimension"] == "actual" and r["period_key"] == "2026-09")
        self.assertFalse(sep_actual["is_available"])
        self.assertIsNone(sep_actual["parsed_value"])

    def test_seed_august_knit_woven_are_unavailable(self):
        rows, _ = sync.baseline_seed_rows()
        for dim in ("knit", "woven"):
            row = next(r for r in rows if r["metric_group"] == "fabric_mix"
                       and r["dimension"] == dim and r["period_key"] == "2026-08")
            self.assertFalse(row["is_available"])

    def test_seed_woven_dimension_normalizes_wooven_label(self):
        rows, _ = sync.baseline_seed_rows()
        woven_rows = [r for r in rows if r["metric_group"] == "fabric_mix" and r["dimension"] == "woven"]
        self.assertTrue(woven_rows)
        for row in woven_rows:
            self.assertEqual(row["source_label"], "Wooven")
            self.assertEqual(row["normalized_label"], "Woven")

    def test_all_seed_rows_pass_validation(self):
        rows, _ = sync.baseline_seed_rows()
        self.assertTrue(all(r["validation_status"] == "ok" for r in rows))

    def test_seed_defect_metrics_are_unavailable_never_zero_or_omitted(self):
        rows, _ = sync.baseline_seed_rows()
        defect_rows = [r for r in rows if r["metric_group"] == "quality_defects"]
        # The metric group itself must exist in the seed (not simply absent),
        # covering every governed dimension for every baseline month.
        self.assertTrue(defect_rows)
        dims_seen = {r["dimension"] for r in defect_rows}
        self.assertEqual(dims_seen, set(sync.DEFECT_METRIC_DIMENSIONS))
        for row in defect_rows:
            self.assertFalse(row["is_available"])
            self.assertIsNone(row["parsed_value"])
            self.assertNotEqual(row["parsed_value"], 0)
        self.assertTrue(all(r["validation_status"] == "ok" for r in defect_rows))


# --------------------------------------------------------------------------- #
# 2. Disposable-PostgreSQL integration tests                                  #
# --------------------------------------------------------------------------- #
TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")


@unittest.skipUnless(TEST_DB_URL, "TEST_DATABASE_URL not set")
class TrackerSheetPromotionPgTests(unittest.TestCase):
    """Exercises the real stage/promote SQL against a throwaway database,
    never the application's configured DATABASE_URL."""

    @classmethod
    def setUpClass(cls):
        import psycopg2
        cls.conn = psycopg2.connect(TEST_DB_URL)
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            for table in ("production_tracker_sheet_warnings", "production_tracker_sheet_metrics",
                          "production_tracker_sheet_staging_metrics", "production_tracker_sheet_sync_runs",
                          "production_tracker_sheet_sources"):
                cur.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "production_tracker_schema.sql"), encoding="utf-8") as fh:
                schema = fh.read()
            marker = "-- Production Tracker Sheet Feed (governed Google Sheets ingestion)"
            cur.execute(schema[schema.index(marker):])
            cur.execute("""
                INSERT INTO production_tracker_sheet_sources (source_key, spreadsheet_id, tab_map)
                VALUES ('test-source', 'test-sheet-id', '{"summary":"Summary"}'::jsonb)
                RETURNING id
            """)
            cls.source_id = cur.fetchone()[0]
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.rollback()
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            for table in ("production_tracker_sheet_warnings", "production_tracker_sheet_metrics",
                          "production_tracker_sheet_staging_metrics", "production_tracker_sheet_sync_runs",
                          "production_tracker_sheet_sources"):
                cur.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        cls.conn.close()

    def _new_run(self, cur, trigger_kind="manual", run_key=None):
        cur.execute("""
            INSERT INTO production_tracker_sheet_sync_runs (source_id, run_key, trigger_kind)
            VALUES (%s,%s,%s) RETURNING id
        """, (self.source_id, run_key or f"run-{datetime.now().timestamp()}", trigger_kind))
        return cur.fetchone()[0]

    def test_promotion_upserts_idempotently_by_grain_not_by_run(self):
        row = {"metric_group": "annual_totals", "dimension": "test_dim", "period_type": "year",
               "period_key": "2026", "parsed_value": 100, "is_available": True,
               "is_partial_period": False, "source_label": "Test", "normalized_label": None,
               "validation_status": "ok"}
        with self.conn.cursor() as cur:
            run1 = self._new_run(cur, run_key="idempotency-run-1")
            promoted = sync.promote(cur, run1, [row])
            self.assertEqual(promoted, 1)
            cur.execute("""SELECT value, version_token, source_run_id FROM production_tracker_sheet_metrics
                            WHERE metric_group='annual_totals' AND dimension='test_dim'""")
            first = cur.fetchone()
            self.assertEqual(first[0], 100)
            self.assertEqual(first[1], 1)

            run2 = self._new_run(cur, run_key="idempotency-run-2")
            row2 = dict(row, parsed_value=150)
            sync.promote(cur, run2, [row2])
            cur.execute("""SELECT value, version_token, source_run_id, COUNT(*) OVER ()
                            FROM production_tracker_sheet_metrics
                            WHERE metric_group='annual_totals' AND dimension='test_dim'""")
            second = cur.fetchone()
            self.assertEqual(second[0], 150)  # updated in place
            self.assertEqual(second[1], 2)    # version bumped, never reset
            self.assertEqual(second[2], run2)  # now attributed to the latest run
            self.assertEqual(second[3], 1)     # still exactly one row for this grain
        self.conn.rollback()

    def test_quarantined_rows_are_staged_but_never_promoted(self):
        rows = [
            {"metric_group": "annual_totals", "dimension": "good_dim", "period_type": "year",
             "period_key": "2026", "parsed_value": 10, "is_available": True,
             "is_partial_period": False, "validation_status": "ok"},
            {"metric_group": "annual_totals", "dimension": "bad_dim", "period_type": "year",
             "period_key": "2026", "parsed_value": -1, "is_available": True,
             "is_partial_period": False, "validation_status": "quarantined",
             "validation_reason": "negative value is implausible"},
        ]
        with self.conn.cursor() as cur:
            run_id = self._new_run(cur, run_key="quarantine-run")
            sync.stage_rows(cur, run_id, rows)
            promoted = sync.promote(cur, run_id, rows)
            self.assertEqual(promoted, 1)
            cur.execute("""SELECT COUNT(*) FROM production_tracker_sheet_metrics WHERE dimension='bad_dim'""")
            self.assertEqual(cur.fetchone()[0], 0)
            cur.execute("""SELECT COUNT(*) FROM production_tracker_sheet_staging_metrics
                            WHERE run_id=%s AND dimension='bad_dim' AND validation_status='quarantined'""",
                        (run_id,))
            self.assertEqual(cur.fetchone()[0], 1)
        self.conn.rollback()

    def test_unavailable_defect_rows_promote_and_read_back_as_unavailable_not_zero(self):
        rows = [
            {"metric_group": "quality_defects", "dimension": dim, "period_type": "month",
             "period_key": "2026-01", "parsed_value": None, "is_available": False,
             "is_partial_period": False, "source_label": "Not present in Production Tracker 2026",
             "normalized_label": None, "validation_status": "ok"}
            for dim in sync.DEFECT_METRIC_DIMENSIONS
        ]
        with self.conn.cursor() as cur:
            run_id = self._new_run(cur, run_key="defect-seed-run")
            promoted = sync.promote(cur, run_id, rows)
            self.assertEqual(promoted, len(rows))
            cur.execute("""SELECT dimension, value, is_available FROM production_tracker_sheet_metrics
                            WHERE metric_group='quality_defects' ORDER BY dimension""")
            fetched = cur.fetchall()
            self.assertEqual(len(fetched), len(sync.DEFECT_METRIC_DIMENSIONS))
            for _dim, value, is_available in fetched:
                self.assertIsNone(value)
                self.assertFalse(is_available)
        self.conn.rollback()

    def test_failed_run_never_overwrites_previously_promoted_metrics(self):
        good_row = {"metric_group": "annual_totals", "dimension": "lkg_dim", "period_type": "year",
                    "period_key": "2026", "parsed_value": 555, "is_available": True,
                    "is_partial_period": False, "validation_status": "ok"}
        with self.conn.cursor() as cur:
            run1 = self._new_run(cur, run_key="lkg-run-1")
            sync.promote(cur, run1, [good_row])
            sync._finish_run(self.conn, run1, "ok", row_count=1, warning_count=0, promoted=True)

            # A second run that fails before calling promote() at all — simulating
            # a connection-permission failure — must leave the published value untouched.
            run2 = self._new_run(cur, run_key="lkg-run-2")
            sync._finish_run(self.conn, run2, "connection_pending",
                              error_message="Sheet not shared with connector", promoted=False)

            cur.execute("""SELECT value FROM production_tracker_sheet_metrics WHERE dimension='lkg_dim'""")
            self.assertEqual(cur.fetchone()[0], 555)
            cur.execute("""SELECT status, promoted FROM production_tracker_sheet_sync_runs WHERE id=%s""", (run2,))
            status, promoted_flag = cur.fetchone()
            self.assertEqual(status, "connection_pending")
            self.assertFalse(promoted_flag)
        self.conn.rollback()


class _FakeRequest:
    def __init__(self, role, user_id="u1", name="Test User", body_headers=None):
        class _State:
            pass
        self.state = _State()
        self.state.user = {"user_id": user_id, "name": name, "role": role}
        self.headers = body_headers or {}


@unittest.skipUnless(TEST_DB_URL, "TEST_DATABASE_URL not set")
class TrackerSheetRouteGatingPgTests(unittest.TestCase):
    """Calls the real production_workspace route handlers with `_API`
    monkeypatched onto a throwaway database, so permission gates, audit
    trails and the connection_state derivation are exercised as written."""

    @classmethod
    def setUpClass(cls):
        import psycopg2
        import psycopg2.extras
        import production_workspace as pw
        cls.pw = pw
        cls.conn = psycopg2.connect(TEST_DB_URL)
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            for table in ("production_workspace_audit_events", "production_tracker_sheet_warnings",
                          "production_tracker_sheet_metrics", "production_tracker_sheet_staging_metrics",
                          "production_tracker_sheet_sync_runs", "production_tracker_sheet_sources"):
                cur.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "production_tracker_schema.sql"), encoding="utf-8") as fh:
                full_schema = fh.read()
            marker = "-- Production Tracker Sheet Feed (governed Google Sheets ingestion)"
            cur.execute(full_schema[full_schema.index(marker):])
            # Minimal standalone audit table (normally part of the larger workspace schema).
            cur.execute("""
                CREATE TABLE production_workspace_audit_events (
                    id BIGSERIAL PRIMARY KEY, entity_type TEXT, entity_id TEXT, action TEXT,
                    actor_user_id TEXT, actor_name TEXT, reason TEXT,
                    before_json JSONB, after_json JSONB, request_id TEXT,
                    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """)
            cur.execute("""
                INSERT INTO production_tracker_sheet_sources (source_key, spreadsheet_id, tab_map)
                VALUES (%s, 'test-sheet-id', '{"summary":"Summary"}'::jsonb)
            """, (pw._TRACKER_SHEET_SOURCE_KEY,))
        cls.conn.autocommit = False
        cls._orig_api = pw._API
        pw._API = cls._FakeApi(cls.conn)
        # The full _ensure_schema() applies the entire Production Workspace
        # Foundation schema (FKs to production_orders/production_stages,
        # which this focused test does not create). This suite only needs
        # the 5 tracker-sheet tables already created above, so mark schema
        # readiness satisfied rather than pulling in the unrelated foundation.
        cls._orig_schema_ready = pw._SCHEMA_READY
        pw._SCHEMA_READY = True

    @classmethod
    def tearDownClass(cls):
        cls.pw._API = cls._orig_api
        cls.pw._SCHEMA_READY = cls._orig_schema_ready
        cls.conn.rollback()
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            for table in ("production_workspace_audit_events", "production_tracker_sheet_warnings",
                          "production_tracker_sheet_metrics", "production_tracker_sheet_staging_metrics",
                          "production_tracker_sheet_sync_runs", "production_tracker_sheet_sources"):
                cur.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        cls.conn.close()

    class _FakeApi:
        def __init__(self, conn):
            self.conn = conn

        def _users_exec(self, query, params=None, fetch=False):
            import psycopg2.extras
            with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(query, params)
                if fetch:
                    result = cur.fetchall()
                    self.conn.commit()
                    return result
                self.conn.commit()
                return None

        def _users_tx(self):
            import psycopg2.extras
            conn = self.conn

            @contextmanager
            def _ctx():
                cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                try:
                    yield cur
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    cur.close()
            return _ctx()

    def test_view_role_can_read_status_but_not_write(self):
        pw = self.pw
        viewer = _FakeRequest(role="quality")
        status = pw._tracker_sheet_get(viewer)
        self.assertTrue(status["configured"])
        self.assertFalse(status["can_edit"])
        self.assertEqual(status["connection_state"], "never_synced")

        denied = pw._tracker_sheet_update(viewer, {"enabled": False, "reason": "trying anyway"})
        self.assertEqual(denied.status_code, 403)

    def test_admin_update_requires_a_reason_and_is_audited(self):
        pw = self.pw
        admin = _FakeRequest(role="admin")
        rejected = pw._tracker_sheet_update(admin, {"enabled": False})
        self.assertEqual(rejected.status_code, 400)

        result = pw._tracker_sheet_update(admin, {"enabled": False, "reason": "pausing for maintenance"})
        self.assertFalse(result["enabled"])
        with self.conn.cursor() as cur:
            cur.execute("""SELECT COUNT(*) FROM production_workspace_audit_events
                            WHERE entity_type='tracker_sheet_source' AND action='update'""")
            self.assertGreaterEqual(cur.fetchone()[0], 1)
        # restore for subsequent tests
        pw._tracker_sheet_update(admin, {"enabled": True, "reason": "resuming"})

    def test_sync_now_requires_a_reason_and_is_audited(self):
        pw = self.pw
        admin = _FakeRequest(role="admin")

        rejected = pw._tracker_sheet_sync_now(admin, {})
        self.assertEqual(rejected.status_code, 400)
        with self.conn.cursor() as cur:
            cur.execute("""SELECT COUNT(*) FROM production_workspace_audit_events
                            WHERE entity_type='tracker_sheet_source' AND action='sync_now'""")
            before = cur.fetchone()[0]

        result = pw._tracker_sheet_sync_now(admin, {"reason": "confirming live sync behavior"})
        self.assertTrue(result["ok"])
        with self.conn.cursor() as cur:
            cur.execute("""SELECT COUNT(*) FROM production_workspace_audit_events
                            WHERE entity_type='tracker_sheet_source' AND action='sync_now'""")
            after = cur.fetchone()[0]
        self.assertEqual(after, before + 1)

        viewer = _FakeRequest(role="quality")
        denied = pw._tracker_sheet_sync_now(viewer, {"reason": "trying anyway"})
        self.assertEqual(denied.status_code, 403)

    def test_production_role_can_edit_non_admin_role_cannot(self):
        pw = self.pw
        production_user = _FakeRequest(role="production")
        result = pw._tracker_sheet_update(production_user, {"tab_map": {"summary": "Summary v2"},
                                                              "reason": "recalibrating tab name"})
        self.assertEqual(result["tab_map"]["summary"], "Summary v2")

        smt_user = _FakeRequest(role="smt")
        denied = pw._tracker_sheet_update(smt_user, {"tab_map": {"summary": "x"}, "reason": "nope"})
        self.assertEqual(denied.status_code, 403)

    def test_connection_state_reflects_latest_run_status(self):
        pw = self.pw
        with self.conn.cursor() as cur:
            cur.execute("SELECT id FROM production_tracker_sheet_sources WHERE source_key=%s",
                        (pw._TRACKER_SHEET_SOURCE_KEY,))
            source_id = cur.fetchone()[0]
            cur.execute("""
                INSERT INTO production_tracker_sheet_sync_runs
                    (source_id, run_key, trigger_kind, status, finished_at, error_message)
                VALUES (%s, 'gating-run-pending', 'manual', 'connection_pending', now(),
                        'Sheet not shared with the connector')
                RETURNING id
            """, (source_id,))
            run_id = cur.fetchone()[0]
        self.conn.commit()
        try:
            status = pw._tracker_sheet_get(_FakeRequest(role="admin"))
            self.assertEqual(status["connection_state"], "connection_pending")
            self.assertEqual(status["latest_run"]["status"], "connection_pending")
        finally:
            # Keep this test isolated from sibling tests in the class that also
            # assert on connection_state / latest_run.
            with self.conn.cursor() as cur:
                cur.execute("DELETE FROM production_tracker_sheet_sync_runs WHERE id=%s", (run_id,))
            self.conn.commit()

    def test_metrics_endpoint_rejects_unknown_metric_group(self):
        pw = self.pw
        result = pw._tracker_sheet_metrics(_FakeRequest(role="admin"), metric_group="not_a_real_group")
        self.assertEqual(result.status_code, 400)

    def test_metrics_endpoint_serves_quality_defects_as_unavailable_never_zero(self):
        pw = self.pw
        with self.conn.cursor() as cur:
            run_id = self._new_run_for_metrics(cur)
            for dim in ["defect_units", "rejected_units", "reworked_units"]:
                cur.execute("""
                    INSERT INTO production_tracker_sheet_metrics
                        (metric_group, dimension, period_type, period_key, value,
                         is_available, is_partial_period, source_run_id, version_token)
                    VALUES ('quality_defects', %s, 'month', '2026-01', NULL, FALSE, FALSE, %s, 1)
                    ON CONFLICT (metric_group, dimension, period_type, period_key) DO NOTHING
                """, (dim, run_id))
        self.conn.commit()
        try:
            result = pw._tracker_sheet_metrics(_FakeRequest(role="quality"), metric_group="quality_defects")
            self.assertIn("metrics", result)
            self.assertEqual(len(result["metrics"]), 3)
            for row in result["metrics"]:
                self.assertFalse(row["is_available"])
                self.assertIsNone(row["value"])
        finally:
            with self.conn.cursor() as cur:
                cur.execute("DELETE FROM production_tracker_sheet_metrics WHERE metric_group='quality_defects'")
                cur.execute("DELETE FROM production_tracker_sheet_sync_runs WHERE id=%s", (run_id,))
            self.conn.commit()

    def _new_run_for_metrics(self, cur):
        cur.execute("""
            INSERT INTO production_tracker_sheet_sync_runs (source_id, run_key, trigger_kind)
            VALUES ((SELECT id FROM production_tracker_sheet_sources WHERE source_key=%s),
                    %s, 'manual') RETURNING id
        """, (self.pw._TRACKER_SHEET_SOURCE_KEY, f"metrics-test-run-{datetime.now().timestamp()}"))
        return cur.fetchone()[0]


if __name__ == "__main__":
    unittest.main()
