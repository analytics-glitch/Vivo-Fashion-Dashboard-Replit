"""Guard tests: IBT projection calibration only nudges the FORECAST, never the
canonical realised numbers leadership trusts.

Phase 3 added a learned realised/projected "calibration" factor that tempers the
headline IBT projection (SOR uplift, inventory-days removed, avg net-CCC/unit).
The danger is a future edit accidentally applying that factor to a REALISED
figure -- the canonical Sell-Off-Rate ``units_sold*100/(units_sold+store_stock)``
(warehouse excluded) or the realised cash-conversion economics -- silently
distorting the trusted numbers.

These tests pin two invariants:

1. ``_ibt_global_solve`` returns the calibrated projection fields (e.g.
   ``sor_uplift_pp``) ALONGSIDE untouched ``*_raw`` values, the ``*_raw`` values
   and the realised ``value_kes`` / per-bundle economics are IDENTICAL no matter
   what the calibration factor is, and at a neutral factor (1.0) the calibrated
   field equals its raw twin.
2. The calibration factor stays clamped to [0.25, 2.0] even when fed extreme
   realised/projected samples or a corrupt out-of-range stored value.

All DB-touching helpers are mocked, so no API/DB is required.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest validation_agent.test_ibt_calibration
"""
import unittest
from unittest import mock

import api_pg


# ── Deterministic fixture edges ──────────────────────────────────────────────
# One donor -> one destination, several SKUs of the same style. The donor is a
# slow seller (low velocity -> high days-to-sell) and the destination is fast
# (high velocity -> low days-to-sell) so every move PAYS the net-CCC + value
# gates and gets assigned. Domestic, same-mall so transit is trivial.
_SKUS = ["SKU-1", "SKU-2", "SKU-3"]


def _edge(sku):
    return {
        "style_name": "STYLE-A",
        "from_store": "Store Slow",
        "to_store": "Store Fast",
        "from_country": "Kenya",
        "to_country": "Kenya",
        "sku": sku,
        "to_sku_avail": 0,        # dest budget = max(2-0,0) = 2
        "from_sku_avail": 5,      # donor ledger = max(5-1,0) = 4
        "to_qty_sold_28d": 30,
        "from_qty_sold_28d": 1,
        "asp": 5000.0,
        "score": 90,
        "brand": "Vivo",
        "subcategory": "Dresses",
        "color": "Red",
        "size": "M",
        "barcode": "BC-" + sku,
        "bin": "A1",
        "from_tier": 3,
        "to_tier": 1,
    }


def _velmap():
    m = {}
    for sku in _SKUS:
        m[("Store Slow", sku)] = {"vel": 0.02}  # ~350d -> capped slow donor
        m[("Store Fast", sku)] = {"vel": 7.0}   # 1d -> fast destination
    return m


def _solve_with_calibration(calib):
    """Run ``_ibt_global_solve`` with every DB-dependent helper mocked and the
    calibration factor pinned to ``calib``."""
    edges = [_edge(s) for s in _SKUS]
    with mock.patch.multiple(
        api_pg,
        _warehouse_bins_refresh=mock.DEFAULT,
        run_query=mock.DEFAULT,
        _ibt_edge_sql=mock.DEFAULT,
        _is_manually_retired=mock.DEFAULT,
        _ibt_store_sku_velocity=mock.DEFAULT,
        _ibt_leadtime_map=mock.DEFAULT,
        _ibt_warehouse_avail=mock.DEFAULT,
        _ibt_hub_country=mock.DEFAULT,
        _ibt_is_same_mall=mock.DEFAULT,
        _ibt_lead_days=mock.DEFAULT,
        _ibt_network_sor_base=mock.DEFAULT,
        _ibt_proj_calibration=mock.DEFAULT,
        _ibt_freshness=mock.DEFAULT,
    ) as m:
        m["_warehouse_bins_refresh"].return_value = None
        m["run_query"].return_value = edges
        m["_ibt_edge_sql"].return_value = ""
        m["_is_manually_retired"].return_value = False
        m["_ibt_store_sku_velocity"].return_value = _velmap()
        m["_ibt_leadtime_map"].return_value = {}
        m["_ibt_warehouse_avail"].return_value = {}   # no warehouse cover -> IBT fires
        m["_ibt_hub_country"].return_value = "Kenya"
        m["_ibt_is_same_mall"].return_value = True     # same-mall walk-over
        m["_ibt_lead_days"].return_value = 1.0
        m["_ibt_network_sor_base"].return_value = 1000.0
        m["_ibt_proj_calibration"].return_value = calib
        m["_ibt_freshness"].return_value = {"as_of_eat": "12:00:00"}
        return api_pg._ibt_global_solve(
            "2026-06-01", "2026-06-27", None, 0.2, 1.5,
            use_clustering=False, bundle_limit=300)


# Canonical realised numbers a calibration change must NEVER move.
_RAW_FIELDS = (
    "sor_uplift_pp_raw",
    "inventory_days_removed_raw",
    "avg_net_ccc_days_per_unit_raw",
)
# Calibrated projection fields paired with their raw twin.
_PROJECTION_PAIRS = (
    ("sor_uplift_pp", "sor_uplift_pp_raw"),
    ("inventory_days_removed", "inventory_days_removed_raw"),
    ("avg_net_ccc_days_per_unit", "avg_net_ccc_days_per_unit_raw"),
)


class GlobalSolveCalibrationTests(unittest.TestCase):
    """Calibration scales the headline projection only; realised stays put."""

    def setUp(self):
        # Sanity: the fixture must actually produce an assigned bundle, else the
        # projection fields would all be 0 and the test would be vacuous.
        self.base = _solve_with_calibration(1.0)
        self.assertGreater(self.base["summary"]["bundles"], 0,
                           "fixture produced no bundles")
        self.assertGreater(self.base["summary"]["units"], 0)
        self.assertGreater(self.base["summary"]["sor_uplift_pp_raw"], 0)
        self.assertGreater(self.base["summary"]["inventory_days_removed_raw"], 0)

    def test_neutral_factor_calibrated_equals_raw(self):
        # At calibration 1.0 the projection field must equal its raw twin.
        s = self.base["summary"]
        for cal_key, raw_key in _PROJECTION_PAIRS:
            self.assertAlmostEqual(s[cal_key], s[raw_key], places=2,
                                   msg=f"{cal_key} != {raw_key} at neutral 1.0")
        self.assertEqual(self.base["calibration"], 1.0)
        self.assertEqual(s["calibration"], 1.0)

    def test_raw_and_realised_invariant_to_calibration(self):
        # The canonical realised outputs must be byte-for-byte identical no
        # matter how aggressive the calibration factor is.
        lo = _solve_with_calibration(0.25)
        hi = _solve_with_calibration(2.0)

        for key in _RAW_FIELDS:
            self.assertEqual(lo["summary"][key], hi["summary"][key],
                             f"raw field {key} moved with calibration")
            self.assertEqual(lo["summary"][key], self.base["summary"][key])

        # value_kes is a realised economic figure -> never calibrated.
        self.assertEqual(lo["summary"]["value_kes"], hi["summary"]["value_kes"])
        self.assertEqual(self.base["summary"]["value_kes"],
                         hi["summary"]["value_kes"])

        # Per-bundle realised economics (value + net-CCC days) are untouched.
        for blo, bhi in zip(lo["bundles"], hi["bundles"]):
            self.assertEqual(blo["value_kes"], bhi["value_kes"])
            self.assertEqual(blo["net_ccc_days"], bhi["net_ccc_days"])
            self.assertEqual(blo["units"], bhi["units"])

    def test_calibrated_projection_scales_with_factor(self):
        # The calibrated projection fields must move proportionally with the
        # factor while the raw twin holds still.
        for calib in (0.25, 0.5, 2.0):
            res = _solve_with_calibration(calib)
            s = res["summary"]
            self.assertEqual(res["calibration"], calib)
            for cal_key, raw_key in _PROJECTION_PAIRS:
                expected = s[raw_key] * calib
                # round() tolerance on the calibrated field (pp/ccc rounded to
                # 2/0/1 dp respectively) -> a small absolute delta is fine.
                self.assertAlmostEqual(
                    s[cal_key], expected,
                    delta=max(1.0, abs(expected) * 0.01),
                    msg=f"{cal_key} did not scale by {calib}")
            # And the raw twin never moved off the neutral run.
            for raw_key in _RAW_FIELDS:
                self.assertEqual(s[raw_key], self.base["summary"][raw_key])


class CalibrationClampTests(unittest.TestCase):
    """The factor is clamped to [0.25, 2.0] on both write and read paths."""

    def _exec_nostore(self):
        """A ``_users_exec`` stand-in: SELECT returns no prior window, INSERT is
        a no-op. Used so ``_ibt_record_calibration`` runs purely on the sample."""
        def fake(query, params=None, fetch=False):
            if fetch:
                return []
            return None
        return fake

    def test_record_clamps_extreme_high_samples(self):
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=self._exec_nostore()):
            for sample in (2.5, 50.0, 1e9):
                med = api_pg._ibt_record_calibration(sample, run_id="r1")
                self.assertLessEqual(med, api_pg._IBT_CALIB_MAX)
                self.assertGreaterEqual(med, api_pg._IBT_CALIB_MIN)
                self.assertEqual(med, api_pg._IBT_CALIB_MAX)

    def test_record_clamps_extreme_low_samples(self):
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=self._exec_nostore()):
            for sample in (0.2, 0.0, -100.0):
                med = api_pg._ibt_record_calibration(sample, run_id="r1")
                self.assertLessEqual(med, api_pg._IBT_CALIB_MAX)
                self.assertGreaterEqual(med, api_pg._IBT_CALIB_MIN)
                self.assertEqual(med, api_pg._IBT_CALIB_MIN)

    def test_record_bad_sample_returns_clamped_neutral(self):
        # A non-numeric sample must fall back to the active factor, still clamped.
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=self._exec_nostore()):
            med = api_pg._ibt_record_calibration("not-a-number", run_id="r1")
            self.assertLessEqual(med, api_pg._IBT_CALIB_MAX)
            self.assertGreaterEqual(med, api_pg._IBT_CALIB_MIN)

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
            self.assertEqual(api_pg._ibt_proj_calibration(), api_pg._IBT_CALIB_MAX)
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=reader(0.0001)):
            self.assertEqual(api_pg._ibt_proj_calibration(), api_pg._IBT_CALIB_MIN)
        # An in-range value is returned as-is.
        with mock.patch.object(api_pg, "_users_exec",
                               side_effect=reader(1.3)):
            self.assertAlmostEqual(api_pg._ibt_proj_calibration(), 1.3, places=4)


if __name__ == "__main__":
    unittest.main()
