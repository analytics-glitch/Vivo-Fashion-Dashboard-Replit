"""Unit tests for the Tier-2 learned-range firing rule in baselines.check_row.

Locks in the busy-day false-alert fixes:
  * a finding REQUIRES a p1-p99 band breach (band is mandatory),
  * band edges carry a 5% materiality margin (a marginal graze never fires),
  * a severe breach (band + extreme z / >=2 families) DOES fire,
  * PoP- or z-only agreement without a band breach never fires,
  * a thin day (< RATIO_MIN_TXN transactions) emits ONE informational
    low_volume note instead of a range anomaly per ratio metric, and
    governance auto-resolves it.

All fixtures are synthetic in-memory index entries -- no database is touched.
"""
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from validation_agent import baselines, config, governance


ENTITY = ("store", "Village Market", "", )
TARGET = date(2026, 6, 24)  # a Wednesday, not on the promo calendar


def _mk_index(metric: str, values: list[float], target: date = TARGET) -> dict:
    """Build an index whose same-weekday bucket holds ``values`` (weekly steps
    back from ``target``), each tagged with the target's own dow/promo flags so
    the seasonal bucket matches."""
    dow = target.weekday()
    promo = baselines.is_promo(target)
    series = []
    for i, v in enumerate(reversed(values), start=1):
        d = target - timedelta(days=7 * i)
        series.append((d, float(v), dow, promo))
    series.sort(key=lambda t: t[0])
    key = (ENTITY[0], ENTITY[1], ENTITY[2], metric)
    return {key: series}


def _row(**metrics) -> dict:
    m = {"entity_type": ENTITY[0], "entity": ENTITY[1], "subcategory": ENTITY[2],
         "period_date": TARGET, "transactions": metrics.get("transactions", 100)}
    m.update(metrics)
    return m


# 12 same-weekday history points (>= MIN_HISTORY_POINTS) spanning 100k..150k.
HISTORY = [100_000, 105_000, 110_000, 115_000, 120_000, 125_000,
           130_000, 135_000, 140_000, 145_000, 148_000, 150_000]


class LearnedRangeFiringRule(unittest.TestCase):

    def setUp(self):
        self.assertGreaterEqual(len(HISTORY), config.MIN_HISTORY_POINTS)
        self.index = _mk_index("total_sales", HISTORY)
        st = baselines._stats(HISTORY)
        self.p99 = st["p99"]
        self.p1 = st["p1"]

    def _fails(self, value, index=None, txn=100):
        return baselines.check_row(
            _row(total_sales=value, transactions=txn), index or self.index)

    def test_in_band_value_does_not_fire(self):
        self.assertEqual(self._fails(120_000), [])

    def test_marginal_band_graze_within_margin_does_not_fire(self):
        # Just above p99 but inside the BAND_MARGIN (5%) pad: a record-but-real
        # trading day must stay quiet.
        graze = self.p99 * (1 + config.BAND_MARGIN * 0.5)
        self.assertGreater(graze, self.p99)
        self.assertEqual(self._fails(graze), [])

    def test_severe_breach_fires(self):
        # Far outside the padded band: band breach + extreme z (>= 2 families).
        fails = self._fails(400_000)
        self.assertEqual(len(fails), 1)
        f = fails[0]
        self.assertEqual(f["check_code"], "learned_range")
        self.assertEqual(f["metric"], "total_sales")
        self.assertNotIn("informational", f)
        self.assertIn("outside p1-p99", f["broken_identity"])
        # total_sales is a money metric -> materiality carried for governance.
        self.assertGreater(f["materiality_kes"], 0)

    def test_low_side_severe_breach_fires(self):
        fails = self._fails(1_000)
        self.assertEqual(len(fails), 1)
        self.assertEqual(fails[0]["check_code"], "learned_range")

    def test_z_only_never_fires_without_band_breach(self):
        # Force z_hit/severe on an in-band value by dropping the z thresholds:
        # the mandatory-band rule must still keep it quiet.
        val = 135_000  # inside p1..p99
        self.assertLess(val, self.p99)
        self.assertGreater(val, self.p1)
        with patch.object(config, "Z_THRESHOLD", 0.01), \
             patch.object(config, "Z_SEVERE", 0.02):
            self.assertEqual(self._fails(val), [])

    def test_pop_plus_z_never_fires_without_band_breach(self):
        # Most recent same-weekday base is small -> PoP way over POP_CAP, and z
        # forced to hit too; still inside the learned band -> no finding.
        hist = HISTORY[:-1] + [40_000]  # last bucket value = 40k
        index = _mk_index("total_sales", hist)
        st = baselines._stats(hist)
        val = 130_000  # inside band, PoP vs 40k = +225%
        self.assertLess(val, st["p99"])
        self.assertGreater((val - 40_000) / 40_000, config.POP_CAP)
        with patch.object(config, "Z_THRESHOLD", 0.01):
            self.assertEqual(self._fails(val, index=index), [])

    def test_thin_day_emits_single_low_volume_informational(self):
        # Two ratio metrics wildly out of band on a 2-transaction day -> ONE
        # informational low_volume note, no learned_range findings.
        self.assertLess(2, config.RATIO_MIN_TXN)
        abv_hist = [3_000 + 50 * i for i in range(12)]
        asp_hist = [1_500 + 25 * i for i in range(12)]
        index = {}
        index.update(_mk_index("abv", abv_hist))
        index.update(_mk_index("asp", asp_hist))
        row = _row(abv=50_000, asp=25_000, transactions=2)
        fails = baselines.check_row(row, index)
        self.assertEqual(len(fails), 1)
        f = fails[0]
        self.assertEqual(f["check_code"], "low_volume")
        self.assertTrue(f.get("informational"))
        self.assertEqual(f["materiality_kes"], 0.0)

    def test_return_rate_uses_higher_min_txn_floor(self):
        # return_rate needs more volume than the other ratio metrics: a single
        # refund receipt against a handful of orders is a mathematically real
        # but meaningless spike (Vivo Meru 2026-07-09: 2 refunds / 7 orders ->
        # 0.34). A day with transactions between RATIO_MIN_TXN and
        # RETURN_RATE_MIN_TXN must gate return_rate as low_volume while abv
        # (generic floor) is still evaluated normally.
        self.assertLess(config.RATIO_MIN_TXN, config.RETURN_RATE_MIN_TXN)
        txn = config.RATIO_MIN_TXN + 2  # above generic floor, below return_rate's
        self.assertLess(txn, config.RETURN_RATE_MIN_TXN)

        rr_hist = [0.01 + 0.001 * i for i in range(12)]
        abv_hist = [3_000 + 50 * i for i in range(12)]
        index = {}
        index.update(_mk_index("return_rate", rr_hist))
        index.update(_mk_index("abv", abv_hist))

        # return_rate wildly out of band, abv comfortably in band -> ONE
        # informational low_volume note (for return_rate), nothing for abv.
        row = _row(return_rate=0.34, abv=3_300, transactions=txn)
        fails = baselines.check_row(row, index)
        self.assertEqual([f["check_code"] for f in fails], ["low_volume"])
        self.assertTrue(fails[0].get("informational"))

        # Same day but abv also wildly out of band -> abv still evaluates
        # (learned_range fires) because it is above the generic floor.
        row2 = _row(return_rate=0.34, abv=50_000, transactions=txn)
        with patch.object(config, "Z_THRESHOLD", 0.01):
            fails2 = baselines.check_row(row2, index)
        codes2 = sorted(f["check_code"] for f in fails2)
        self.assertIn("learned_range", codes2)
        self.assertIn("low_volume", codes2)
        lr = [f for f in fails2 if f["check_code"] == "learned_range"]
        self.assertEqual([f["metric"] for f in lr], ["abv"])

        # At/above RETURN_RATE_MIN_TXN the same spike evaluates normally.
        row3 = _row(return_rate=0.34, transactions=config.RETURN_RATE_MIN_TXN)
        with patch.object(config, "Z_THRESHOLD", 0.01):
            fails3 = baselines.check_row(row3, {k: v for k, v in index.items()
                                                if k[3] == "return_rate"})
        self.assertEqual([f["check_code"] for f in fails3], ["learned_range"])
        self.assertEqual(fails3[0]["metric"], "return_rate")

    def test_thin_day_gate_does_not_touch_volume_metrics(self):
        # total_sales is not a ratio metric: a genuine severe breach still fires
        # even on a thin day.
        fails = self._fails(400_000, txn=2)
        self.assertEqual([f["check_code"] for f in fails], ["learned_range"])

    def test_informational_finding_auto_resolves_in_governance(self):
        exc = {"check_code": "low_volume", "informational": True,
               "materiality_kes": 0.0}
        decision = governance.decide(exc)
        self.assertEqual(decision["action"], "auto_resolve")
        self.assertEqual(decision["severity"], "amber")


if __name__ == "__main__":
    unittest.main()
