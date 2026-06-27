"""Guard tests: replenishment projection calibration only nudges the FORECAST,
never the canonical realised numbers leadership trusts.

The replenishment engine carries the SAME learned realised/projected
"calibration" factor design as the IBT engine (guarded by
``test_ibt_calibration.py``). ``_replen_proj_calibration`` /
``_replen_record_calibration`` temper the replenishment projection, and the
reconciliation endpoint ``/api/analytics/replenishment-sor-reconciliation``
computes the canonical realised Sell-Off-Rate via the nested ``_sor`` helper
(``units_sold*100/(units_sold+store_stock)``, warehouse excluded, in-transit
quarantined). The danger is a future edit accidentally letting the calibration
factor distort a REALISED figure -- silently corrupting the trusted numbers.

These tests pin two invariants:

1. The reconciliation's realised SOR and projected uplift outputs are IDENTICAL
   no matter what the calibration factor is -- calibration is recorded AFTER the
   realised/projected figures are computed and only stored, so realised must be
   invariant.
2. The calibration factor stays clamped to [0.25, 2.0] on both write
   (``_replen_record_calibration`` with extreme/garbage samples) and read
   (``_replen_proj_calibration`` with a corrupt out-of-range stored value).

All DB-touching helpers are mocked, so no API/DB is required.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest validation_agent.test_replen_calibration
"""
import datetime
import unittest
from unittest import mock

import api_pg


# ── Deterministic reconciliation fixture ─────────────────────────────────────
# One store-SKU snapshot from a run old enough to reconcile. Numbers are chosen
# so realised SOR, projected SOR and both uplifts are clean, non-zero values
# (a vacuous all-zero fixture would not actually test invariance).
_RUN = {
    "run_id": "run-x",
    "business_date": datetime.date(2026, 6, 1),
    "store_scope": "Kenya",
    "ruleset_version": "v1",
}
_SNAPSHOT_ROWS = [{
    "pos_location": "Store A",
    "sku": "SKU-1",
    "units_sold": 10,
    "shelf_qty_at_calc": 10,
    "v_at_calc": 5,
    "suggested_qty": 20,
}]
# Recomputed-NOW figures returned by run_query (all_sales units / all_inventory soh).
_UNITS_NOW = 18.0
_STOCK_NOW_GROSS = 6.0


def _run_reconciliation_with_calibration(calib):
    """Drive ``analytics_replenishment_sor_reconciliation`` with every DB helper
    mocked and the recorded calibration pinned to ``calib``."""

    def fake_users_exec(query, params=None, fetch=False):
        if "ruleset_version" in query:          # run-selection SELECT
            return [dict(_RUN)]
        if "units_sold" in query:               # snapshot-rows SELECT
            return [dict(r) for r in _SNAPSHOT_ROWS]
        return [] if fetch else None

    def fake_run_query(query, *a, **k):
        if "all_sales" in query:
            return [{"u": _UNITS_NOW}]
        if "all_inventory" in query:
            return [{"soh": _STOCK_NOW_GROSS}]
        return [{}]

    with mock.patch.multiple(
        api_pg,
        _ensure_replen_tables=mock.DEFAULT,
        _users_exec=mock.DEFAULT,
        run_query=mock.DEFAULT,
        _replen_in_transit_rows=mock.DEFAULT,
        _replen_record_calibration=mock.DEFAULT,
        _replen_proj_calibration=mock.DEFAULT,
    ) as m:
        m["_ensure_replen_tables"].return_value = None
        m["_users_exec"].side_effect = fake_users_exec
        m["run_query"].side_effect = fake_run_query
        m["_replen_in_transit_rows"].return_value = []
        # The factor under test: this is recorded AFTER realised/projected are
        # computed, so it must NOT leak into any realised output.
        m["_replen_record_calibration"].return_value = calib
        m["_replen_proj_calibration"].return_value = calib
        return api_pg.analytics_replenishment_sor_reconciliation(weeks=4)


# Realised / projected outputs that a calibration change must NEVER move.
_INVARIANT_FIELDS = (
    "sor_at_calc",
    "realised_sor",
    "projected_sor",
    "realised_uplift_pts",
    "projected_uplift_pts",
    "units_at_calc",
    "units_now",
    "shelf_at_calc",
    "store_stock_now",
    "projected_incremental_units",
    "realised_incremental_units",
)


class ReconciliationCalibrationInvarianceTests(unittest.TestCase):
    """The realised SOR / projected uplift outputs are invariant to the factor."""

    def setUp(self):
        # Sanity: the fixture must produce non-zero realised + projected figures,
        # else the invariance assertions below would be vacuous.
        self.base = _run_reconciliation_with_calibration(1.0)
        self.assertTrue(self.base.get("available"))
        self.assertGreater(self.base["realised_sor"], 0)
        self.assertGreater(self.base["projected_sor"], 0)
        self.assertNotEqual(self.base["realised_uplift_pts"], 0)
        self.assertNotEqual(self.base["projected_uplift_pts"], 0)

    def test_realised_outputs_invariant_to_calibration(self):
        lo = _run_reconciliation_with_calibration(0.25)
        hi = _run_reconciliation_with_calibration(2.0)
        for key in _INVARIANT_FIELDS:
            self.assertEqual(
                lo[key], hi[key],
                f"realised/projected field {key} moved with calibration")
            self.assertEqual(
                lo[key], self.base[key],
                f"realised/projected field {key} drifted off the neutral run")

    def test_calibration_only_changes_the_calibration_field(self):
        # The ONLY field that may differ between runs is the stored factor itself
        # (calibration / calibration_sample is fine). Everything else is realised.
        lo = _run_reconciliation_with_calibration(0.25)
        hi = _run_reconciliation_with_calibration(2.0)
        self.assertEqual(lo["calibration"], 0.25)
        self.assertEqual(hi["calibration"], 2.0)
        # The realised calibration_sample (realised_inc / proj_inc) is computed
        # from realised figures, so it too is invariant to the stored factor.
        self.assertEqual(lo["calibration_sample"], hi["calibration_sample"])


class CalibrationClampTests(unittest.TestCase):
    """The factor is clamped to [0.25, 2.0] on both write and read paths."""

    def _exec_nostore(self):
        """A ``_users_exec`` stand-in: SELECT returns no prior window, INSERT is
        a no-op. So ``_replen_record_calibration`` runs purely on the sample."""
        def fake(query, params=None, fetch=False):
            if fetch:
                return []
            return None
        return fake

    def test_record_clamps_extreme_high_samples(self):
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=self._exec_nostore()):
            for sample in (2.5, 50.0, 1e9):
                med = api_pg._replen_record_calibration(sample, run_id="r1")
                self.assertLessEqual(med, api_pg._REPLEN_CALIB_MAX)
                self.assertGreaterEqual(med, api_pg._REPLEN_CALIB_MIN)
                self.assertEqual(med, api_pg._REPLEN_CALIB_MAX)

    def test_record_clamps_extreme_low_samples(self):
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=self._exec_nostore()):
            for sample in (0.2, 0.0, -100.0):
                med = api_pg._replen_record_calibration(sample, run_id="r1")
                self.assertLessEqual(med, api_pg._REPLEN_CALIB_MAX)
                self.assertGreaterEqual(med, api_pg._REPLEN_CALIB_MIN)
                self.assertEqual(med, api_pg._REPLEN_CALIB_MIN)

    def test_record_bad_sample_returns_clamped_neutral(self):
        # A non-numeric sample must fall back to the active factor, still clamped.
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=self._exec_nostore()):
            med = api_pg._replen_record_calibration("not-a-number", run_id="r1")
            self.assertLessEqual(med, api_pg._REPLEN_CALIB_MAX)
            self.assertGreaterEqual(med, api_pg._REPLEN_CALIB_MIN)

    def test_read_clamps_corrupt_stored_value(self):
        # A corrupt/out-of-range persisted value must be clamped on read so a bad
        # write can never leak an unbounded factor into the projection.
        import json

        def reader(stored):
            def fake(query, params=None, fetch=False):
                if fetch:
                    return [{"value": json.dumps({"value": stored})}]
                return None
            return fake

        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=reader(999.0)):
            self.assertEqual(api_pg._replen_proj_calibration(),
                             api_pg._REPLEN_CALIB_MAX)
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=reader(0.0001)):
            self.assertEqual(api_pg._replen_proj_calibration(),
                             api_pg._REPLEN_CALIB_MIN)
        # An in-range value is returned as-is.
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=reader(1.3)):
            self.assertAlmostEqual(api_pg._replen_proj_calibration(), 1.3,
                                   places=4)


if __name__ == "__main__":
    unittest.main()
