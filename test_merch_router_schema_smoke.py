"""Schema smoke tests for the Merchandising Hub router (/api/merch/*).

These tests call the _fetch_* / _compute_* / _agg_by_dim functions in
merch_router.py directly — bypassing HTTP routing and auth — with a patched
_db_exec that returns a minimal fake row.  They catch column-name mismatches
(e.g. referencing a column the SQL CTE never produces, like the
``standard_cost_kes`` / ``last_order_date`` bugs found after task #1225) before
the code is merged: a wrong column name causes a KeyError or AttributeError in
the post-processing loop, which this test surfaces as a failure rather than a
buyer-facing blank page.

Endpoints exercised (all four "portfolio" variants share the same
_fetch_styles code path, so one fake-DB fixture covers them all):
  • /api/merch/styles          → {styles: [...], count: N}
  • /api/merch/summary         → {total_styles, on_track_count, …}
  • /api/merch/by-subcategory  → {rows: [{subcategory, style_count, …}]}
  • /api/merch/by-tier         → {rows: [{tier, style_count, …}]}

Run with::

    python -m unittest test_merch_router_schema_smoke
"""
import unittest
from unittest import mock

import merch_router


# ── Minimal fake DB row — must match exactly what _fetch_styles SQL SELECTs ──

_FAKE_STYLE_ROW = {
    # product-master dimensions (from the prod CTE)
    "style_name":        "Test Style A",
    "style_number":      "TS001",
    "brand":             "Vivo",
    "subcategory":       "Dresses",
    "category":          "Dresses",
    "status":            "Active",
    "launch_date":       "2024-01-15",
    "standard_cost_kes": 1200.0,   # aliased from MAX(p.cost) in the prod CTE
    "last_order_date":   None,     # NULL::date placeholder in the prod CTE
    "full_price":        3500.0,
    "is_noos":           False,
    "reorder_count":     2,
    # stock
    "soh_stores":        10,
    "soh_online":        2,   # subset of soh_stores (Online - Shop Zetu)
    "soh_warehouse":     5,
    # 6-month sales
    "units_6m":          50,
    "revenue_6m":        175000.0,
    "orders_6m":         30,
    "units_full_price":  40,
    "last_sale_date":    "2024-08-01",
    # period sales (from_date / to_date window)
    "units_period":      50,
    "revenue_period":    175000.0,
    # lifetime sales
    "units_life":        200,
    "revenue_life":      700000.0,
}


def _patch_db(rows):
    """Return a context manager that makes merch_router._db_exec always return rows."""
    return mock.patch.object(merch_router, "_db_exec", return_value=rows)


class TestMerchRouterSchemaSmoke(unittest.TestCase):
    """Direct calls to _fetch_* / _compute_* with a minimal fake _db_exec.

    One fake row is enough: if any column name referenced in the post-processing
    Python code does not match what the SQL SELECT actually returns, the test
    crashes with a KeyError/AttributeError — exactly the class of bug that caused
    500 errors on every merch tab before.
    """

    # ── /api/merch/styles ─────────────────────────────────────────────────────

    def test_fetch_styles_returns_list(self):
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            result = merch_router._fetch_styles()
        self.assertIsInstance(result, list, "_fetch_styles must return a list")
        self.assertGreater(len(result), 0, "expected at least one style row")

    def test_fetch_styles_row_has_required_keys(self):
        """Every output row must carry the keys the /api/merch/styles client reads."""
        required = {
            "style_name", "style_number", "brand", "subcategory", "category",
            "tier",
            "odoo_status", "launch_date", "last_order_date", "standard_cost_kes",
            "full_price", "is_noos", "reorder_count",
            "soh_stores", "soh_online", "soh_warehouse", "current_stock",
            "units_6m", "revenue_6m", "orders_6m",
            "units_period", "revenue_period",
            "units_life", "revenue_life",
            "weekly_avg", "woc", "sor_6m",
            "last_sale_date", "last_sale_days",
            "full_price_pct", "avg_selling_price",
            "gross_margin_pct", "gross_margin_kes", "cogs_6m_kes",
            "recommended_action", "action_status",
        }
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            result = merch_router._fetch_styles()
        self.assertGreater(len(result), 0)
        missing = required - result[0].keys()
        self.assertFalse(missing, f"_fetch_styles row is missing keys: {missing}")

    def test_fetch_styles_no_extra_db_column_names(self):
        """Ensure _db_exec column names align: accessing a column not in the fake
        row raises KeyError immediately, which this test converts to a failure."""
        # This test is a canary — if the fake row does not cover every column
        # that the post-processing code accesses, the test itself will error.
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            try:
                merch_router._fetch_styles()
            except (KeyError, TypeError) as exc:
                self.fail(f"Column mismatch in _fetch_styles post-processing: {exc}")

    # ── /api/merch/summary ────────────────────────────────────────────────────

    def test_compute_summary_has_required_keys(self):
        """_compute_summary must return all keys the /api/merch/summary client reads."""
        required = {
            "total_styles", "on_track_count", "at_risk_count", "overdue_count",
            "active_total_styles",
            "total_stock_units", "revenue_6m", "units_6m", "weekly_velocity",
            "avg_woc", "avg_full_price_pct", "avg_sor_6m",
            "zero_stock_count", "no_sale_30d_count",
            "woc_lt4_count", "woc_gt20_count",
            "woc_lt3_active_count", "no_sale_7d_active_count",
            "styles_launched_current_year", "styles_launched_prior_year",
            "avg_gross_margin_pct", "total_cogs_6m_kes", "total_gross_margin_kes",
        }
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            styles = merch_router._fetch_styles()
        summary = merch_router._compute_summary(styles)
        missing = required - summary.keys()
        self.assertFalse(missing, f"_compute_summary missing keys: {missing}")

    def test_compute_summary_empty_does_not_crash(self):
        """_compute_summary([]) must return a dict with None values, not raise."""
        summary = merch_router._compute_summary([])
        self.assertIsInstance(summary, dict)
        self.assertIn("total_styles", summary)

    # ── /api/merch/by-subcategory ─────────────────────────────────────────────

    def test_agg_by_subcategory_has_required_keys(self):
        required = {
            "subcategory", "category", "style_count", "units_6m", "revenue_6m",
            "current_stock", "avg_woc", "avg_sor_6m", "avg_full_price_pct",
            "avg_gross_margin_pct", "total_cogs_6m_kes", "total_gross_margin_kes",
        }
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            styles = merch_router._fetch_styles()
        rows = merch_router._agg_by_dim(styles, "subcategory")
        self.assertIsInstance(rows, list)
        self.assertGreater(len(rows), 0)
        missing = required - rows[0].keys()
        self.assertFalse(missing, f"by-subcategory row missing keys: {missing}")

    # ── /api/merch/by-tier ────────────────────────────────────────────────────

    def test_agg_by_tier_has_required_keys(self):
        required = {
            "tier", "style_count", "units_6m", "revenue_6m",
            "current_stock", "avg_woc", "avg_sor_6m", "avg_full_price_pct",
            "avg_gross_margin_pct",
        }
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            styles = merch_router._fetch_styles()
        rows = merch_router._agg_by_dim(styles, "tier")
        self.assertIsInstance(rows, list)
        self.assertGreater(len(rows), 0)
        missing = required - rows[0].keys()
        self.assertFalse(missing, f"by-tier row missing keys: {missing}")

    # ── Tier computation / filter (Python-side logic) ─────────────────────────

    def test_tier_filter_keeps_matching_rows(self):
        """With reorder_count=2, the style is Tier 3; tier='Tier 3' must keep it."""
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            result = merch_router._fetch_styles(tier="Tier 3")
        self.assertTrue(
            all(r["tier"] == "Tier 3" for r in result),
            "tier filter should keep Tier 3 rows",
        )

    def test_tier_filter_drops_non_matching_rows(self):
        """With reorder_count=2 → Tier 3, requesting tier='Tier 1' should return []."""
        with _patch_db([dict(_FAKE_STYLE_ROW)]):
            result = merch_router._fetch_styles(tier="Tier 1")
        self.assertEqual(result, [], "Tier 1 filter should exclude a Tier 3 style")

    def test_noos_style_is_tier1(self):
        """is_noos=True must yield Tier 1 regardless of reorder_count."""
        row = dict(_FAKE_STYLE_ROW)
        row["is_noos"] = True
        with _patch_db([row]):
            result = merch_router._fetch_styles()
        self.assertTrue(len(result) > 0)
        self.assertEqual(result[0]["tier"], "Tier 1")

    def test_retired_status_yields_retired_tier(self):
        """An all-Retired style must produce tier='Retired'."""
        row = dict(_FAKE_STYLE_ROW)
        row["status"] = "Retired"
        with _patch_db([row]):
            result = merch_router._fetch_styles()
        self.assertTrue(len(result) > 0)
        self.assertEqual(result[0]["tier"], "Retired")

    # ── Recommended action (Python decision tree) ─────────────────────────────

    def test_zero_stock_sold_recently_is_reorder_now(self):
        """No stock + sold ≤30 days ago → 'Reorder Now'."""
        from datetime import date, timedelta
        row = dict(_FAKE_STYLE_ROW)
        row["soh_stores"]    = 0
        row["soh_warehouse"] = 0
        row["units_6m"]      = 10
        row["last_sale_date"] = str(date.today() - timedelta(days=5))
        with _patch_db([row]):
            result = merch_router._fetch_styles()
        self.assertTrue(len(result) > 0)
        self.assertEqual(result[0]["recommended_action"], "Reorder Now")

    def test_no_stock_no_recent_sales_is_discontinue(self):
        """No stock + no sale in ≥90 days → 'Discontinue'."""
        from datetime import date, timedelta
        row = dict(_FAKE_STYLE_ROW)
        row["soh_stores"]    = 0
        row["soh_warehouse"] = 0
        row["units_6m"]      = 0
        row["last_sale_date"] = str(date.today() - timedelta(days=120))
        with _patch_db([row]):
            result = merch_router._fetch_styles()
        self.assertTrue(len(result) > 0)
        self.assertEqual(result[0]["recommended_action"], "Discontinue")


def _style(**over):
    """Minimal style dict for driving _compute_summary directly."""
    base = {
        "action_status": "on_track", "current_stock": 10, "soh_stores": 10,
        "soh_warehouse": 0, "revenue_6m": 1000, "units_6m": 26,
        "revenue_period": 0, "units_period": 0, "tier": "Tier 2",
        "style_number": "SN-1", "style_name": "Style A", "colour_count": 1,
        "last_sale_days": 2, "woc": 10.0, "full_price_pct": None,
        "sor_6m": None, "gross_margin_pct": None, "cogs_6m_kes": None,
        "gross_margin_kes": None, "launch_date": None,
    }
    base.update(over)
    return base


class ScopedKpiSemanticsTests(unittest.TestCase):
    """Lifecycle-scoped risk KPIs (Aug 2026): active/retired scoping, in-stock
    gates, and style_number dedup must hold — not just key presence."""

    def test_woc_gt20_active_only_and_deduped(self):
        rows = [
            _style(style_number="SN-1", style_name="A", woc=25.0),
            _style(style_number="SN-1", style_name="A (renamed)", woc=30.0),  # same number → 1
            _style(style_number="SN-2", tier="Retired", woc=40.0),            # retired → out
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["woc_gt20_count"], 1)

    def test_woc_lt3_excludes_stockless_and_retired(self):
        rows = [
            _style(style_number="SN-1", woc=1.5),                                        # counts
            _style(style_number="SN-2", woc=0.0, current_stock=0, soh_stores=0),         # stockout ≠ low cover
            _style(style_number="SN-3", tier="Retired", woc=1.0),                        # retired → out
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["woc_lt3_active_count"], 1)

    def test_no_sale_7d_active_in_stock_only(self):
        rows = [
            _style(style_number="SN-1", last_sale_days=8),                               # counts
            _style(style_number="SN-2", last_sale_days=8, current_stock=0, soh_stores=0),
            _style(style_number="SN-3", last_sale_days=8, tier="Retired"),
            _style(style_number="SN-4", last_sale_days=None),                            # never sold in window
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["no_sale_7d_active_count"], 1)

    def test_no_sale_30d_retired_in_stock_only_and_deduped(self):
        rows = [
            _style(style_number="SN-1", tier="Retired", last_sale_days=45),
            _style(style_number="SN-1", tier="Retired", last_sale_days=60,
                   style_name="dup name"),                                               # same number → 1
            _style(style_number="SN-2", tier="Retired", last_sale_days=45,
                   current_stock=0, soh_stores=0),                                       # stockless → out
            _style(style_number="SN-3", last_sale_days=45),                              # active → out
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["no_sale_30d_count"], 1)

    def test_legacy_all_style_counters_unchanged(self):
        rows = [
            _style(style_number="SN-1", woc=3.5),                                        # woc_lt4 (all styles)
            _style(style_number="SN-2", tier="Retired", woc=2.0),                        # woc_lt4 too
            _style(style_number="SN-3", current_stock=0, soh_stores=0, woc=None),        # zero stock
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["woc_lt4_count"], 2)
        self.assertEqual(s["zero_stock_count"], 1)

class LifecycleSplitKpiTests(unittest.TestCase):
    """Aug 2026 lifecycle-split card fields: revenue/units bucket by tier at row
    grain (exhaustive vs the all-styles totals), Avg/Style denominators use the
    matching deduped ALL-style universes, velocity is Active-scoped, and
    warehouse-SOH splits accumulate only inside the deduped card branches."""

    def test_revenue_and_units_bucket_by_tier_exhaustively(self):
        rows = [
            _style(style_number="SN-1", revenue_period=100, units_period=10),
            _style(style_number="SN-2", tier="Retired", revenue_period=50, units_period=5),
            _style(style_number="SN-3", tier="Archived", revenue_period=25, units_period=2),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_revenue_period"], 100)
        self.assertEqual(s["retired_revenue_period"], 50)
        self.assertEqual(s["active_units_period"], 10)
        # Active + Retired never exceeds the all-styles total (Archived = remainder)
        self.assertLessEqual(
            s["active_revenue_period"] + s["retired_revenue_period"], s["revenue_period"]
        )

    def test_zero_stock_active_seller_in_revenue_and_avg_denominator(self):
        rows = [
            _style(style_number="SN-1", revenue_period=100),
            _style(style_number="SN-2", revenue_period=50,
                   current_stock=0, soh_stores=0, soh_warehouse=0),  # sold out, still earned
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_revenue_period"], 150)  # revenue stays exhaustive
        self.assertEqual(s["active_styles_count"], 1)      # card count = in-stock only
        self.assertEqual(s["active_styles_all_count"], 2)  # avg denominator = ALL active

    def test_active_styles_all_count_deduped_by_style_number(self):
        rows = [
            _style(style_number="SN-1", style_name="A"),
            _style(style_number="SN-1", style_name="A (renamed)",
                   current_stock=0, soh_stores=0),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_styles_all_count"], 1)

    def test_active_velocity_excludes_non_active_tiers(self):
        rows = [
            _style(style_number="SN-1", units_6m=26),
            _style(style_number="SN-2", tier="Retired", units_6m=260),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_units_6m"], 26)
        self.assertEqual(s["active_weekly_velocity"], 1.0)
        self.assertEqual(s["weekly_velocity"], 11.0)  # legacy all-styles velocity intact

    def test_warehouse_splits_follow_dedup_branches_and_bounds(self):
        rows = [
            _style(style_number="SN-1", soh_warehouse=5, soh_stores=5, current_stock=10),
            _style(style_number="SN-1", style_name="A (renamed)",
                   soh_warehouse=7, soh_stores=0, current_stock=7),  # dup number → skipped
            _style(style_number="SN-2", tier="Retired",
                   soh_warehouse=3, soh_stores=1, current_stock=4),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_warehouse_stock_units"], 5)
        self.assertEqual(s["active_stock_units"], 10)
        self.assertEqual(s["retired_warehouse_stock_units"], 3)
        self.assertLessEqual(s["retired_warehouse_stock_units"], s["retired_stock_units"])

    def test_avg_sor_period_over_active_rows_only(self):
        rows = [
            _style(style_number="SN-1", sor_period=50.0),
            _style(style_number="SN-2", sor_period=70.0),
            _style(style_number="SN-3", tier="Retired", sor_period=10.0),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["avg_sor_period_active"], 60.0)

    def test_active_colour_styles_derive_from_in_stock_colourways(self):
        rows = [
            # 5 colourways ever made, only 2 with SOH → only those 2 count
            _style(style_number="SN-1", colour_count=5, colours_in_stock=2),
            # Retired at STYLE level → ALL colourways excluded, stocked or not
            _style(style_number="SN-2", tier="Retired",
                   colour_count=4, colours_in_stock=3),
            # Active style with zero stock → contributes no colourways
            _style(style_number="SN-3", colour_count=3, colours_in_stock=0,
                   current_stock=0, soh_stores=0, soh_warehouse=0),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_colour_styles_count"], 2)

    def test_empty_summary_has_lifecycle_split_keys(self):
        s = merch_router._compute_summary([])
        for k in ("active_warehouse_stock_units", "retired_warehouse_stock_units",
                  "active_revenue_period", "retired_revenue_period",
                  "active_units_period", "active_units_6m", "active_weekly_velocity",
                  "active_styles_all_count", "avg_sor_period_active"):
            self.assertIn(k, s)
            self.assertIsNone(s[k])


class OverviewKpiBucketParityTests(unittest.TestCase):
    """Overview CSV buckets must match _compute_summary's card values on the
    same rows — the lockstep contract behind the KPI-card download links."""

    def _rows(self):
        return [
            _style(style_number="SN-1", tier="Tier 1", colour_count=3,
                   colours_in_stock=2),
            _style(style_number="SN-1", tier="Tier 1", style_name="renamed twin",
                   colour_count=2, colours_in_stock=2),                        # dedup → counts once
            _style(style_number="SN-2", tier="Tier 2", current_stock=0,
                   soh_stores=0, colours_in_stock=5),                          # stockless active → excluded
            _style(style_number="SN-3", tier="Retired", current_stock=0,
                   soh_stores=0),                                              # stockless retired → still counts
            _style(style_number="SN-4", tier="Archived"),
            _style(style_number="SN-5", tier="Tier 3", soh_warehouse=40,
                   current_stock=50, colours_in_stock=1),
        ]

    def test_lifecycle_buckets_match_summary_counts(self):
        rows = self._rows()
        summary = merch_router._compute_summary(rows)
        for kpi, key in [("active_styles",   "active_styles_count"),
                         ("retired_styles",  "retired_styles_count"),
                         ("archived_styles", "archived_styles_count")]:
            got = len(merch_router._kpi_bucket_rows(rows, kpi))
            self.assertEqual(got, summary[key], f"{kpi} rows != summary {key}")

    def test_colour_and_warehouse_sums_match_summary(self):
        rows = self._rows()
        summary = merch_router._compute_summary(rows)
        # Card counts DERIVED colour styles (colours_in_stock — colourways
        # with SOH > 0), so the bucket's file must sum the same field.
        colours = sum((r.get("colours_in_stock") or 0)
                      for r in merch_router._kpi_bucket_rows(rows, "active_colours"))
        self.assertEqual(colours, summary["active_colour_styles_count"])
        wh = sum((r.get("soh_warehouse") or 0)
                 for r in merch_router._kpi_bucket_rows(rows, "warehouse_units"))
        self.assertEqual(wh, summary["warehouse_stock_units"])

    def test_on_track_bucket_matches_summary(self):
        rows = self._rows()
        summary = merch_router._compute_summary(rows)
        self.assertEqual(len(merch_router._kpi_bucket_rows(rows, "on_track")),
                         summary["on_track_count"])

    def test_status_counts_active_styles_only(self):
        """on_track/at_risk/overdue count ACTIVE styles only (Aug 2026):
        Retired and Archived rows must not move the health counters, and the
        three counters must partition the active universe exactly."""
        rows = [
            _style(style_number="SN-1", action_status="on_track"),
            _style(style_number="SN-2", action_status="at_risk"),
            _style(style_number="SN-3", action_status="overdue"),
            _style(style_number="SN-4", tier="Retired",  action_status="overdue"),
            _style(style_number="SN-5", tier="Archived", action_status="overdue"),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["on_track_count"], 1)
        self.assertEqual(s["at_risk_count"], 1)
        self.assertEqual(s["overdue_count"], 1)
        self.assertEqual(s["active_total_styles"], 3)
        self.assertEqual(s["on_track_count"] + s["at_risk_count"] + s["overdue_count"],
                         s["active_total_styles"])
        # The on_track CSV bucket applies the same gate (count-lockstep with
        # the Style Health card).
        self.assertEqual(len(merch_router._kpi_bucket_rows(rows, "on_track")), 1)

    def test_prev_window_custom_range(self):
        self.assertEqual(merch_router._prev_window("2026-08-01", "2026-08-10"),
                         ("2026-07-22", "2026-07-31"))

    def test_prev_window_single_day(self):
        self.assertEqual(merch_router._prev_window("2026-08-12", "2026-08-12"),
                         ("2026-08-11", "2026-08-11"))

    def test_prev_window_default_six_months(self):
        from datetime import date, timedelta
        today = date.today()
        pf, pt = merch_router._prev_window(None, None)
        self.assertEqual(pt, str(today - timedelta(days=merch_router._SIX_MONTHS_DAYS + 1)))
        self.assertEqual(pf, str(today - timedelta(days=2 * merch_router._SIX_MONTHS_DAYS + 1)))

    def test_merge_trend_annotates_rows(self):
        cur = [{"brand": "A", "revenue_period": 200.0},
               {"brand": "B", "revenue_period": 50.0},
               {"brand": "C", "revenue_period": -30.0}]
        prev = [{"brand": "A", "revenue_period": 100.0},
                {"brand": "B", "revenue_period": 0.0},
                {"brand": "D", "revenue_period": 40.0}]
        by = {r["brand"]: r for r in merch_router._merge_trend(cur, prev, "brand")}
        self.assertEqual(by["A"]["revenue_prev"], 100.0)
        self.assertEqual(by["A"]["trend_pct"], 100.0)
        self.assertIsNone(by["B"]["trend_pct"])   # zero prev base
        self.assertIsNone(by["C"]["trend_pct"])   # brand absent from prev window

    def test_merge_trend_negative_current_vs_positive_prev(self):
        out = merch_router._merge_trend(
            [{"brand": "E", "revenue_period": -50.0}],
            [{"brand": "E", "revenue_period": 100.0}], "brand")
        self.assertEqual(out[0]["trend_pct"], -150.0)

    def test_negative_contributions_stay_in_sum_buckets(self):
        """Net-return revenue, negative units and negative warehouse
        availability count in the card totals, so the != 0 bucket preds must
        keep those rows in the files or the sums can't reconcile."""
        rows = self._rows() + [
            _style(style_number="SN-6", tier="Tier 1", revenue_period=-500,
                   units_period=-3, soh_warehouse=-5),
            _style(style_number="SN-7", tier="Tier 2", revenue_period=1200,
                   units_period=8, soh_warehouse=12),
        ]
        summary = merch_router._compute_summary(rows)
        rev = sum(merch_router._row_period_value(r, "revenue")
                  for r in merch_router._kpi_bucket_rows(rows, "revenue_period"))
        self.assertEqual(round(rev, 0), summary["revenue_period"])
        units = sum(merch_router._row_period_value(r, "units")
                    for r in merch_router._kpi_bucket_rows(rows, "units_period"))
        self.assertEqual(units, summary["units_period"])
        wh = sum((r.get("soh_warehouse") or 0)
                 for r in merch_router._kpi_bucket_rows(rows, "warehouse_units"))
        self.assertEqual(wh, summary["warehouse_stock_units"])


if __name__ == "__main__":
    unittest.main()


class LaunchRampFilterScopeTests(unittest.TestCase):
    """Assert _fetch_launch_ramp threads brand/subcategory/pos_location into
    the SQL (params + clauses), including the stock denominator: SOR =
    sold / (sold + stock), so a store-scoped request must scope stock too."""

    def _capture(self, **kwargs):
        captured = {}

        def fake_exec(sql, params=None, **_kw):
            captured["sql"] = sql
            captured["params"] = params or {}
            return []

        with mock.patch.object(merch_router, "_db_exec", side_effect=fake_exec):
            merch_router._fetch_launch_ramp(**kwargs)
        return captured

    def test_brand_filter_in_style_universe(self):
        cap = self._capture(brand="Vivo,Zoya")
        self.assertEqual(cap["params"].get("brands"), ["Vivo", "Zoya"])
        self.assertIn("p.brand = ANY(%(brands)s)", cap["sql"])

    def test_subcategory_filter_in_style_universe(self):
        cap = self._capture(subcategory="Dresses")
        self.assertEqual(cap["params"].get("subcats"), ["Dresses"])
        self.assertIn("p.product_type = ANY(%(subcats)s)", cap["sql"])

    def test_pos_location_scopes_sales_and_stock(self):
        cap = self._capture(pos_location="Vivo Junction")
        self.assertEqual(cap["params"].get("pos_locations"), ["Vivo Junction"])
        # sales feed clause
        self.assertIn("s.pos_location_name = ANY(%(pos_locations)s)", cap["sql"])
        # stock denominator clause (stock_now CTE)
        self.assertIn("i.pos_location_name = ANY(%(pos_locations)s)", cap["sql"])

    def test_no_filters_no_extra_clauses(self):
        cap = self._capture()
        self.assertNotIn("%(brands)s", cap["sql"])
        self.assertNotIn("%(subcats)s", cap["sql"])
        self.assertNotIn("%(pos_locations)s", cap["sql"])
