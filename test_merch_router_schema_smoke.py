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
    "status":            "Active",
    "launch_date":       "2024-01-15",
    "standard_cost_kes": 1200.0,   # aliased from MAX(p.cost) in the prod CTE
    "last_order_date":   None,     # NULL::date placeholder in the prod CTE
    "full_price":        3500.0,
    "is_noos":           False,
    "reorder_count":     2,
    # stock
    "soh_stores":        10,
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
            "style_name", "style_number", "brand", "subcategory", "tier",
            "odoo_status", "launch_date", "last_order_date", "standard_cost_kes",
            "full_price", "is_noos", "reorder_count",
            "soh_stores", "soh_warehouse", "current_stock",
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
            "subcategory", "style_count", "units_6m", "revenue_6m",
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


if __name__ == "__main__":
    unittest.main()
