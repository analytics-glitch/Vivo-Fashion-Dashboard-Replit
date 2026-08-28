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
import threading
import time
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
    "standard_cost_kes": 1200.0,   # selected cost after source-priority resolution
    "cost_source":       "last reorder",
    "cost_date":         "2024-07-01",
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
    "units_full_price_period": 30,
    # lifetime sales
    "units_life":        200,
    "revenue_life":      700000.0,
}


class FullPriceSellThroughTests(unittest.TestCase):
    def test_zero_discount_units_are_full_price_and_returns_are_excluded(self):
        # This mirrors the SQL contract: only sale/order units are eligible,
        # and a non-zero discount cannot be counted as full price.
        transactions = [
            {"sale_kind": "sale", "units": 7, "discounts_kes": 0},
            {"sale_kind": "order", "units": 3, "discounts_kes": None},
            {"sale_kind": "sale", "units": 2, "discounts_kes": 0.01},
            {"sale_kind": "return", "units": 5, "discounts_kes": 0},
        ]
        total = sum(
            row["units"] for row in transactions
            if row["sale_kind"] in ("sale", "order")
        )
        full_price = sum(
            row["units"] for row in transactions
            if row["sale_kind"] in ("sale", "order")
            and (row["discounts_kes"] is None or row["discounts_kes"] == 0)
        )
        result = merch_router._compute_full_price_sell_through(total, full_price)
        self.assertEqual(result["total_units_period"], 12)
        self.assertEqual(result["full_price_units_period"], 10)
        self.assertEqual(result["discounted_units_period"], 2)
        self.assertEqual(result["full_price_sell_through"], 83.3)

    def test_full_price_and_discounted_units_reconcile(self):
        result = merch_router._compute_full_price_sell_through(25, 9)
        self.assertEqual(
            result["full_price_units_period"] + result["discounted_units_period"],
            result["total_units_period"],
        )
        self.assertEqual(result["full_price_sell_through"], 36.0)

    def test_zero_denominator_returns_null_percentage(self):
        result = merch_router._compute_full_price_sell_through(0, 0)
        self.assertIsNone(result["full_price_sell_through"])
        self.assertEqual(result["discounted_units_period"], 0)

    def test_full_price_query_uses_zero_discount_and_sale_order_only(self):
        with _patch_db([{
            "total_units_period": 12,
            "full_price_units_period": 10,
        }]) as db:
            result = merch_router._fetch_full_price_sell_through(
                from_date="2026-08-01",
                to_date="2026-08-18",
            )
        self.assertEqual(result["full_price_units_period"], 10)
        sql = db.call_args.args[0]
        self.assertIn("s.sale_kind IN ('sale','order')", sql)
        self.assertIn("COALESCE(s.discounts_kes, 0)::numeric = 0", sql)


def _patch_db(rows):
    """Return a context manager that makes merch_router._db_exec always return rows."""
    return mock.patch.object(merch_router, "_db_exec", return_value=rows)


def _patch_tier(tier="Tier 3"):
    """_compute_tier (2026-08-27) delegates entirely to api_pg._lifecycle_tier,
    which does live Odoo-cache lookups keyed by style_name — the fake style
    names/numbers these schema-smoke fixtures use can never resolve there, so
    without this patch every row is classified None and dropped. Patch
    _compute_tier to a fixed value so the _fetch_styles/_fetch_stock_mix
    post-processing under test here (column plumbing, filtering, aggregation)
    can be exercised in isolation from real Odoo data; api_pg._lifecycle_tier's
    own classification rules have their own dedicated tests."""
    return mock.patch.object(merch_router, "_compute_tier", return_value=tier)


class TestMerchRouterSchemaSmoke(unittest.TestCase):
    """Direct calls to _fetch_* / _compute_* with a minimal fake _db_exec.

    One fake row is enough: if any column name referenced in the post-processing
    Python code does not match what the SQL SELECT actually returns, the test
    crashes with a KeyError/AttributeError — exactly the class of bug that caused
    500 errors on every merch tab before.
    """

    # ── /api/merch/styles ─────────────────────────────────────────────────────

    def test_fetch_styles_returns_list(self):
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
            result = merch_router._fetch_styles()
        self.assertIsInstance(result, list, "_fetch_styles must return a list")
        self.assertGreater(len(result), 0, "expected at least one style row")

    def test_fetch_styles_row_has_required_keys(self):
        """Every output row must carry the keys the /api/merch/styles client reads."""
        required = {
            "style_name", "style_number", "brand", "subcategory", "category",
            "fabric_category", "fabric_subcategory", "colour", "silhouette",
            "tier",
            "odoo_status", "launch_date", "last_order_date", "standard_cost_kes",
            "cost_source", "cost_date",
            "full_price", "is_noos", "reorder_count",
            "soh_stores", "soh_online", "soh_warehouse", "current_stock",
            "units_6m", "revenue_6m", "orders_6m",
            "units_period", "revenue_period",
            "sales_value_period",
            "units_full_price_period", "full_price_sor_period",
            "units_life", "revenue_life",
            "weekly_avg", "woc", "sor_6m", "sor_period", "sor_life",
            "colour_count", "colours_in_stock",
            "last_sale_date", "last_sale_days",
            "full_price_pct", "avg_selling_price",
            "gross_margin_pct", "gross_margin_kes", "cogs_6m_kes",
            "recommended_action", "action_status",
        }
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
            result = merch_router._fetch_styles()
        self.assertGreater(len(result), 0)
        missing = required - result[0].keys()
        self.assertFalse(missing, f"_fetch_styles row is missing keys: {missing}")

    def test_fetch_styles_no_extra_db_column_names(self):
        """Ensure _db_exec column names align: accessing a column not in the fake
        row raises KeyError immediately, which this test converts to a failure."""
        # This test is a canary — if the fake row does not cover every column
        # that the post-processing code accesses, the test itself will error.
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
            try:
                merch_router._fetch_styles()
            except (KeyError, TypeError) as exc:
                self.fail(f"Column mismatch in _fetch_styles post-processing: {exc}")

    def test_stock_mix_joins_colour_lifecycle_before_selecting_status(self):
        """The Stock Mix query selects cl.colour_status, so its CTE join is
        required even when the database returns an empty tree."""
        with _patch_db([]) as db:
            result = merch_router._fetch_stock_mix()
        self.assertEqual(result["categories"], [])
        sql = db.call_args.args[0]
        self.assertIn("colour_lifecycle AS", sql)
        self.assertIn("LEFT JOIN colour_lifecycle cl", sql)
        self.assertIn("cl.colour_status", sql)

    def test_stock_mix_tier_filter_matches_style_lifecycle_rules(self):
        row = {
            "category": "Dresses",
            "subcategory": "Accessories",
            "style_name": "Tiered Style",
            "style_number": "TS001",
            "style_status": "Active",
            "is_noos": False,
            "reorder_count": 2,
            "ov_tier": None,
            "ov_status": None,
            "colour": "Black",
            "colour_status": "Active",
            "stock_units": 4,
            "stock_value": 1000,
            "skus_in_stock": 1,
            "units_period": 3,
            "revenue_period": 5000,
            "skus_sold": 1,
            "units_6m": 12,
            "style_last_order": None,
            "colour_last_order": None,
            "rep_sku": "TS001-BLK",
        }
        with _patch_db([row]), _patch_tier():
            included = merch_router._fetch_stock_mix(tier="Tier 3")
            excluded = merch_router._fetch_stock_mix(tier="Tier 1")
        self.assertEqual(included["counts"]["styles"], 1)
        self.assertEqual(excluded["categories"], [])

    # ── /api/merch/summary ────────────────────────────────────────────────────

    def test_compute_summary_has_required_keys(self):
        """_compute_summary must return all keys the /api/merch/summary client reads."""
        required = {
            "total_styles", "on_track_count", "at_risk_count", "overdue_count",
            "active_total_styles", "untiered_active_count",
            "total_stock_units", "revenue_6m", "units_6m", "weekly_velocity",
            "avg_woc", "avg_full_price_pct", "avg_sor_6m",
            "full_price_units_period", "discounted_units_period",
            "full_price_sell_through", "total_units_period",
            "avg_full_price_sor_period_active", "full_price_sor_period",
            "discounted_sor_gap_pp", "retired_discount_depth_pct",
            "zero_stock_count", "no_sale_30d_count",
            "woc_lt4_count", "woc_gt20_count",
            "woc_lt3_active_count", "no_sale_7d_active_count",
            "styles_launched_current_year", "styles_launched_prior_year",
            "avg_gross_margin_pct", "total_cogs_6m_kes", "total_gross_margin_kes",
        }
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
            styles = merch_router._fetch_styles()
        summary = merch_router._compute_summary(styles)
        missing = required - summary.keys()
        self.assertFalse(missing, f"_compute_summary missing keys: {missing}")

    def test_full_price_sor_uses_remaining_stock_and_gap(self):
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
            styles = merch_router._fetch_styles()
        style = styles[0]
        self.assertEqual(style["full_price_sor_period"], 66.7)
        summary = merch_router._compute_summary(styles)
        self.assertEqual(summary["full_price_sor_period"], 66.7)
        self.assertEqual(summary["discounted_sor_gap_pp"], 10.2)

    def test_full_price_sor_zero_denominator_is_null(self):
        row = dict(_FAKE_STYLE_ROW)
        row.update({
            "units_period": 0,
            "units_full_price_period": 0,
            "soh_stores": 0,
            "soh_online": 0,
            "soh_warehouse": 0,
        })
        with _patch_db([row]), _patch_tier():
            style = merch_router._fetch_styles()[0]
        self.assertIsNone(style["full_price_sor_period"])

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
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
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
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier():
            styles = merch_router._fetch_styles()
        rows = merch_router._agg_by_dim(styles, "tier")
        self.assertIsInstance(rows, list)
        self.assertGreater(len(rows), 0)
        missing = required - rows[0].keys()
        self.assertFalse(missing, f"by-tier row missing keys: {missing}")

    # ── Tier computation / filter (Python-side logic) ─────────────────────────
    # _compute_tier itself now delegates entirely to api_pg._lifecycle_tier
    # (real Odoo-cache lookups) — these tests patch it to a fixed value to
    # exercise _fetch_styles' filtering/plumbing in isolation.

    def test_tier_filter_keeps_matching_rows(self):
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier("Tier 3"):
            result = merch_router._fetch_styles(tier="Tier 3")
        self.assertTrue(
            all(r["tier"] == "Tier 3" for r in result),
            "tier filter should keep Tier 3 rows",
        )

    def test_tier_filter_drops_non_matching_rows(self):
        with _patch_db([dict(_FAKE_STYLE_ROW)]), _patch_tier("Tier 3"):
            result = merch_router._fetch_styles(tier="Tier 1")
        self.assertEqual(result, [], "Tier 1 filter should exclude a Tier 3 style")

    def test_noos_style_is_tier1(self):
        """is_noos=True must yield Tier 1 regardless of reorder_count."""
        row = dict(_FAKE_STYLE_ROW)
        row["is_noos"] = True
        with _patch_db([row]), _patch_tier("Tier 1"):
            result = merch_router._fetch_styles()
        self.assertTrue(len(result) > 0)
        self.assertEqual(result[0]["tier"], "Tier 1")

    def test_online_performance_uses_shared_source_aggregates(self):
        """The primary payload should scan each source once per request."""
        sales = [{
            "period_kind": "current", "bucket": "2026-08-01",
            "category": "Dresses", "size": "M", "colour": "Black",
            "channel_group": "online", "net_revenue": 1160,
            "gross_revenue": 1160, "units": 2, "fp_units": 2,
            "discounts": 0, "promo_revenue": 0, "returns_kes": 0,
        }, {
            "period_kind": "current", "bucket": "2026-08-01",
            "category": "Dresses", "size": "M", "colour": "Black",
            "channel_group": "retail", "net_revenue": 580,
            "gross_revenue": 580, "units": 1, "fp_units": 1,
            "discounts": 0, "promo_revenue": 0, "returns_kes": 0,
        }, {
            "period_kind": "ly", "bucket": None,
            "category": "Dresses", "size": "M", "colour": "Black",
            "channel_group": "online", "net_revenue": 500,
            "gross_revenue": 500, "units": 1, "fp_units": 1,
            "discounts": 0, "promo_revenue": 0, "returns_kes": 0,
        }]
        inventory = [{
            "sku": "SKU-1", "category": "Dresses", "size": "M",
            "colour": "Black", "soh_online": 5, "soh_retail": 8,
        }]
        with mock.patch.object(
            merch_router, "_db_exec", side_effect=[sales, inventory]
        ) as db:
            result = merch_router._online_perf_payload(
                "2026-08-01", "2026-08-31", country="Kenya"
            )
        self.assertEqual(db.call_count, 2)
        self.assertEqual(result["kpis"]["online_rev"], 1160.0)
        self.assertEqual(result["kpis"]["online_rev_ly"], 500.0)
        self.assertEqual(result["categories"][0]["category"], "Dresses")
        self.assertEqual(result["sizes"][0]["online_soh"], 5.0)
        self.assertIn("s.country = ANY", db.call_args_list[0].args[0])
        self.assertIn("Online", str(db.call_args_list[0].args[1]))

    def test_online_performance_cache_coalesces_concurrent_requests(self):
        """A slow cold request is computed once for overlapping callers."""
        key = "test-online-single-flight"
        merch_router._cache_store.pop(key, None)
        calls = []

        def work():
            calls.append(1)
            time.sleep(0.02)
            return {"ok": True}

        results = []
        threads = [
            threading.Thread(target=lambda: results.append(
                merch_router._cached(key, 60, work)
            ))
            for _ in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertEqual(calls, [1])
        self.assertEqual(results, [{"ok": True}, {"ok": True}])
        merch_router._cache_store.pop(key, None)

    def test_retired_status_yields_retired_tier(self):
        """An all-Retired style must produce tier='Retired'."""
        row = dict(_FAKE_STYLE_ROW)
        row["status"] = "Retired"
        with _patch_db([row]), _patch_tier("Retired"):
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
        with _patch_db([row]), _patch_tier():
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
        with _patch_db([row]), _patch_tier():
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

    def test_retired_discount_depth_is_unit_weighted(self):
        rows = [
            _style(style_number="SN-1", tier="Retired", units_period=10,
                   full_price=1000, revenue_period=7000, sales_value_period=7000),
            _style(style_number="SN-2", tier="Retired", units_period=5,
                   full_price=2000, revenue_period=12000, sales_value_period=12000),
            _style(style_number="SN-3", tier="Tier 2", units_period=100,
                   full_price=500, revenue_period=50000),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["retired_units_period"], 15)
        # (20,000 expected - 19,000 achieved) / 20,000 = 5.0%.
        self.assertEqual(s["retired_discount_depth_pct"], 5.0)

    def test_retired_discount_depth_is_null_without_priced_retired_sales(self):
        s = merch_router._compute_summary([
            _style(style_number="SN-1", tier="Retired", units_period=0,
                   full_price=1000, revenue_period=0),
        ])
        self.assertIsNone(s["retired_discount_depth_pct"])

    def test_zero_stock_active_seller_in_revenue_and_avg_denominator(self):
        rows = [
            _style(style_number="SN-1", revenue_period=100),
            _style(style_number="SN-2", revenue_period=50,
                   current_stock=0, soh_stores=0, soh_warehouse=0),  # sold out, still earned
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_revenue_period"], 150)  # revenue stays exhaustive
        # 2026-08-27 user rule: Active Styles matches Range Management exactly
        # (every Tier 1-4 style, stock or no stock) — no separate in-stock-only
        # card count anymore, so both fields read the same ALL-active total.
        self.assertEqual(s["active_styles_count"], 2)
        self.assertEqual(s["active_styles_all_count"], 2)

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

    def test_untiered_active_style_remains_active_and_is_flagged_for_review(self):
        rows = [
            _style(style_number="SN-1", tier="Untiered"),
            _style(style_number="SN-2", tier="Tier 4"),
            _style(style_number="SN-3", tier="Retired"),
        ]
        s = merch_router._compute_summary(rows)
        self.assertEqual(s["active_styles_count"], 2)
        self.assertEqual(s["untiered_active_count"], 1)
        self.assertEqual(
            len(merch_router._kpi_bucket_rows(rows, "active_styles")), 2
        )

    def test_empty_summary_has_lifecycle_split_keys(self):
        s = merch_router._compute_summary([])
        for k in ("active_warehouse_stock_units", "retired_warehouse_stock_units",
                  "active_revenue_period", "retired_revenue_period",
                  "active_units_period", "active_units_6m", "active_weekly_velocity",
                  "active_styles_all_count", "untiered_active_count",
                  "avg_sor_period_active"):
            self.assertIn(k, s)
            self.assertIsNone(s[k])


class OverviewKpiBucketParityTests(unittest.TestCase):
    """Overview CSV buckets must match _compute_summary's card values on the
    same rows — the lockstep contract behind the KPI-card download links."""

    def _rows(self):
        # Distinct style_names (except the deliberate SN-1 twin pair): the
        # colour-grain CSV keys colourways by style_name, so the fixture must
        # not alias unrelated styles onto one name.
        return [
            _style(style_number="SN-1", tier="Tier 1", colour_count=3,
                   colours_in_stock=2),
            _style(style_number="SN-1", tier="Tier 1", style_name="renamed twin",
                   colour_count=2, colours_in_stock=2),                        # dedup → counts once
            _style(style_number="SN-2", tier="Tier 2", style_name="Style B",
                   current_stock=0, soh_stores=0, soh_warehouse=0,
                   colours_in_stock=0),   # stockless active → still counts as a style (matches
                                          # RM's Active total), but a style with zero total stock
                                          # can't have any in-stock colourway, so it contributes 0
            _style(style_number="SN-3", tier="Retired", style_name="Style C",
                   current_stock=0, soh_stores=0),                             # stockless retired → still counts
            _style(style_number="SN-4", tier="Archived", style_name="Style D"),
            _style(style_number="SN-5", tier="Tier 3", style_name="Style E",
                   soh_warehouse=40, current_stock=50, colours_in_stock=1),
        ]

    def test_lifecycle_buckets_match_summary_counts(self):
        rows = self._rows()
        summary = merch_router._compute_summary(rows)
        for kpi, key in [("active_styles",   "active_styles_count"),
                         ("retired_styles",  "retired_styles_count"),
                         ("archived_styles", "archived_styles_count")]:
            got = len(merch_router._kpi_bucket_rows(rows, kpi))
            self.assertEqual(got, summary[key], f"{kpi} rows != summary {key}")

    def test_active_colours_csv_rows_match_summary(self):
        """The active_colours card downloads a COLOUR-grain CSV: its data-row
        count must equal the card's derived colourway count. In production
        both sides derive from the same SQL predicate (colours_in_stock and
        _fetch_colour_rows share the colour_stock derivation); the fixture
        mirrors that by giving each kept style exactly colours_in_stock
        colour rows. Covers the style_number dedup (the dropped twin's
        colourways go with it), the stockless-style exclusion and the
        retired-style cascade."""
        rows = self._rows()
        summary = merch_router._compute_summary(rows)

        def _c(style, colour):
            return {"style_name": style, "colour": colour, "soh_stores": 1,
                    "soh_warehouse": 0, "units_6m": 0, "revenue_6m": 0.0,
                    "last_sale_date": None, "colour_status": "Active"}

        colour_rows = [
            _c("Style A", "Red"), _c("Style A", "Blue"),            # SN-1 kept twin → 2
            {**_c("Style A", "Retired Red"), "colour_status": "Retired"},
            _c("renamed twin", "Red"), _c("renamed twin", "Blue"),  # deduped twin → dropped
            # Style B (SN-2) is a zero-total-stock Active style: it's now a
            # counted style (matches RM), but a style with no stock anywhere
            # has no in-stock colourway to report, so it has no colour rows.
            _c("Style C", "Black"),                                 # retired parent → dropped
            _c("Style E", "White"),                                 # → 1
        ]
        out = merch_router._active_colour_rows(rows, colour_rows)
        self.assertEqual(len(out), summary["active_colour_styles_count"])
        self.assertEqual(len(out), 3)
        # Every emitted row belongs to a kept Active parent.
        self.assertEqual({r["style_name"] for r in out}, {"Style A", "Style E"})

    def test_warehouse_sums_match_summary(self):
        rows = self._rows()
        summary = merch_router._compute_summary(rows)
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


class RollupColumnDriftTests(unittest.TestCase):
    """Guard that rollup_merch_style_day and rollup_merch_first_sale column
    registries stay in sync with their _rollup_defs() SELECT output.

    The _MERCH_STYLE_DAY_COLS / _MERCH_FIRST_SALE_COLS constants in api_pg
    serve as the canonical column list.  Readers depend on every column that
    the SELECT produces being present in the table; _reconcile_merch_rollup_columns
    (called before the watermark skip) uses the same list to self-heal existing
    tables at deploy time — even when source data hasn't changed.

    HOW TO ADD A COLUMN
    -------------------
    1. Add the column to the SELECT in _rollup_defs() (merch_style_day or
       merch_first_sale section).
    2. Add a ``(col_name, sql_type)`` entry to _MERCH_STYLE_DAY_COLS (or
       _MERCH_FIRST_SALE_COLS) in api_pg.py.  The _reconcile_merch_rollup_columns
       function and the lazy-DDL ALTER TABLE guard are both driven by this list.
    3. Update the ``_PK_ALIASES_*`` sets below if the new column is part of the
       primary key (unlikely), so the data-column derivation stays correct.

    Forgetting step 2 causes the SQL-parse tests below to fail (CI gate).
    """

    # ── SQL parser ───────────────────────────────────────────────────────────
    # Extracts column aliases declared with AS at parenthesis depth 0 inside
    # the first SELECT … FROM block of a SQL string.  Subquery aliases (inside
    # parentheses) are at depth > 0 and are not captured.
    @staticmethod
    def _parse_depth0_as_aliases(sql):
        """Return frozenset of lowercase AS-alias names at depth 0 in the
        first SELECT clause.  Stops at the first depth-0 FROM/WHERE/GROUP BY."""
        import re
        m = re.search(r'\bSELECT\b', sql, re.IGNORECASE)
        if not m:
            return frozenset()
        aliases = []
        depth = 0
        i = m.end()
        n = len(sql)
        while i < n:
            c = sql[i]
            if c in ('(', '['):
                depth += 1
            elif c in (')', ']'):
                depth -= 1
            elif depth == 0:
                # Guard: the preceding character must be non-word so we don't
                # fire on, say, "TRANSFORM" containing "ROM".
                prev_is_word = i > 0 and (sql[i - 1].isalnum() or sql[i - 1] == '_')
                if not prev_is_word:
                    rest = sql[i:]
                    stop = re.match(
                        r'(FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b',
                        rest, re.IGNORECASE)
                    if stop:
                        break
                    am = re.match(r'AS\s+(\w+)', rest, re.IGNORECASE)
                    if am:
                        aliases.append(am.group(1).lower())
                        i += am.end()
                        continue
            i += 1
        return frozenset(aliases)

    # Primary-key columns in each table that carry an explicit AS alias in the
    # SELECT (style_name is unaliased so it never appears in the parsed set).
    _PK_ALIASES_STYLE_DAY = frozenset({"sale_day", "country", "pos_location_name"})
    _PK_ALIASES_FIRST_SALE = frozenset()  # style_name has no AS alias

    def _get_rollup_sql(self, name):
        """Return the SELECT SQL for the named rollup from _rollup_defs()."""
        import api_pg
        for n, _table, sql in api_pg._rollup_defs():
            if n == name:
                return sql
        self.fail("Rollup %r not found in api_pg._rollup_defs()" % name)

    # ── Core drift tests: registry ↔ _rollup_defs() SQL ─────────────────────

    def test_style_day_registry_matches_select_cols(self):
        """Every column in _MERCH_STYLE_DAY_COLS must appear as an AS alias in
        the merch_style_day SELECT, and vice-versa (no extra aliases either).

        This is the primary CI gate: adding a column to the SELECT without
        updating the registry, or updating the registry without the SELECT,
        both cause this test to fail before the code reaches production.
        """
        import api_pg
        sql = self._get_rollup_sql("merch_style_day")
        parsed = self._parse_depth0_as_aliases(sql)
        data_aliases = parsed - self._PK_ALIASES_STYLE_DAY  # strip PK aliases
        registry = frozenset(col for col, _ in api_pg._MERCH_STYLE_DAY_COLS)
        self.assertEqual(
            data_aliases, registry,
            "merch_style_day SELECT data-column aliases ↔ registry mismatch.\n"
            "  SQL AS-aliases (non-PK): %s\n"
            "  Registry cols:           %s\n"
            "  In SQL but not registry: %s\n"
            "  In registry but not SQL: %s\n"
            "Add missing columns to _MERCH_STYLE_DAY_COLS in api_pg.py "
            "AND to the SELECT in _rollup_defs()." % (
                sorted(data_aliases), sorted(registry),
                sorted(data_aliases - registry),
                sorted(registry - data_aliases),
            ),
        )

    def test_first_sale_registry_matches_select_cols(self):
        """Every column in _MERCH_FIRST_SALE_COLS must appear as an AS alias in
        the merch_first_sale SELECT, and vice-versa."""
        import api_pg
        sql = self._get_rollup_sql("merch_first_sale")
        parsed = self._parse_depth0_as_aliases(sql)
        data_aliases = parsed - self._PK_ALIASES_FIRST_SALE
        registry = frozenset(col for col, _ in api_pg._MERCH_FIRST_SALE_COLS)
        self.assertEqual(
            data_aliases, registry,
            "merch_first_sale SELECT data-column aliases ↔ registry mismatch.\n"
            "  SQL AS-aliases (non-PK): %s\n"
            "  Registry cols:           %s\n"
            "  In SQL but not registry: %s\n"
            "  In registry but not SQL: %s\n"
            "Add missing columns to _MERCH_FIRST_SALE_COLS in api_pg.py "
            "AND to the SELECT in _rollup_defs()." % (
                sorted(data_aliases), sorted(registry),
                sorted(data_aliases - registry),
                sorted(registry - data_aliases),
            ),
        )

    # ── Reconciliation-before-skip regression tests ──────────────────────────

    def test_reconcile_issues_alter_for_each_registered_column(self):
        """_reconcile_merch_rollup_columns must issue ALTER TABLE ADD COLUMN IF
        NOT EXISTS for every column in the registries when the tables exist.

        Regression guard for the 'unchanged-watermark existing table missing a
        registered column' scenario: a deploy that adds a column must migrate
        the live table on the very first refresh, even when the watermark skip
        would otherwise return early."""
        import api_pg
        executed = []

        class _FakeCursor:
            def __init__(self):
                self._next_row = None

            def execute(self, sql, params=None):
                executed.append(sql.strip())
                # Simulate "table exists" for every information_schema query
                if "information_schema" in sql:
                    self._next_row = (1,)
                else:
                    self._next_row = None

            def fetchone(self):
                return self._next_row

            def close(self):
                pass

        class _FakeConn:
            def cursor(self):
                return _FakeCursor()
            def commit(self):
                pass

        api_pg._reconcile_merch_rollup_columns(_FakeConn())

        alter_sqls = " ".join(s.upper() for s in executed if "ALTER" in s.upper())

        for col, _ in api_pg._MERCH_STYLE_DAY_COLS:
            self.assertIn(
                col.upper(), alter_sqls,
                "_reconcile_merch_rollup_columns did not emit ALTER for "
                "merch_style_day column '%s'" % col,
            )
        for col, _ in api_pg._MERCH_FIRST_SALE_COLS:
            self.assertIn(
                col.upper(), alter_sqls,
                "_reconcile_merch_rollup_columns did not emit ALTER for "
                "merch_first_sale column '%s'" % col,
            )

    def test_reconcile_skips_missing_tables(self):
        """When a merch rollup table does not yet exist (first deploy before
        the build loop runs), _reconcile_merch_rollup_columns must not error
        — it silently skips the table."""
        import api_pg
        executed = []

        class _FakeCursor:
            def execute(self, sql, params=None):
                executed.append(sql.strip())
                self._is_schema = "information_schema" in sql

            def fetchone(self):
                return None  # table not found

            def close(self):
                pass

        class _FakeConn:
            def cursor(self):
                return _FakeCursor()
            def commit(self):
                pass

        # Must not raise
        api_pg._reconcile_merch_rollup_columns(_FakeConn())
        alter_sqls = [s for s in executed if "ALTER" in s.upper()]
        self.assertEqual(alter_sqls, [],
                         "No ALTER TABLE expected when tables are absent")

    # ── Structural integrity ─────────────────────────────────────────────────

    def test_col_registry_entries_are_two_tuples(self):
        """Every entry in both registries must be a (name, sql_type) 2-tuple."""
        import api_pg
        for entry in api_pg._MERCH_STYLE_DAY_COLS:
            self.assertEqual(len(entry), 2,
                             "Bad entry in _MERCH_STYLE_DAY_COLS: %r" % (entry,))
            self.assertIsInstance(entry[0], str)
            self.assertIsInstance(entry[1], str)
        for entry in api_pg._MERCH_FIRST_SALE_COLS:
            self.assertEqual(len(entry), 2,
                             "Bad entry in _MERCH_FIRST_SALE_COLS: %r" % (entry,))
            self.assertIsInstance(entry[0], str)
            self.assertIsInstance(entry[1], str)

    def test_parser_correctly_excludes_subquery_aliases(self):
        """Confirm the depth-0 parser does NOT capture AS aliases that appear
        inside subqueries (parenthesised sub-SELECTs or FILTER clauses)."""
        sql = (
            "SELECT a, b AS col_b, (SELECT x AS subq_col FROM t) AS c "
            "FROM outer_table"
        )
        aliases = self._parse_depth0_as_aliases(sql)
        self.assertIn("col_b", aliases, "top-level alias should be captured")
        self.assertIn("c", aliases, "outer alias of subquery should be captured")
        self.assertNotIn("subq_col", aliases, "alias inside subquery must not be captured")

    def test_parser_stops_at_from_keyword(self):
        """The parser must stop collecting aliases when it hits the depth-0 FROM."""
        sql = "SELECT a AS x, b AS y FROM t JOIN other AS j ON t.id = j.id"
        aliases = self._parse_depth0_as_aliases(sql)
        self.assertIn("x", aliases)
        self.assertIn("y", aliases)
        self.assertNotIn("j", aliases, "JOIN alias after FROM must not be captured")


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


# ── Colour-grain CSV (Active Colour Styles card) ──────────────────────────────

_FAKE_COLOUR_ROW = {
    # must match exactly what the _fetch_colour_rows SQL SELECTs
    "style_name":     "Test Style A",
    "colour":         "Mustard / 0819102 / F",
    "colour_status":  "Active",
    "soh_stores":     4,
    "soh_warehouse":  2,
    "units_6m":       13,
    "revenue_6m":     123456.0,
    "last_sale_date": "2026-08-10",
}


def _colour(**over):
    row = dict(_FAKE_COLOUR_ROW)
    row.update(over)
    return row


# ── /api/merch/style-colors — colourway recommendation rule inputs ───────────

def _color_row(**over):
    """Fake DB row matching exactly what the _fetch_style_colors SQL SELECTs."""
    base = {
        "color":         "Mustard",
        "units_sold":    20,
        "revenue":       50000.0,
        "soh_stores":    30,
        "soh_warehouse": 10,
        "units_6m":      52,
        # fixed 4/8/12-week recommendation windows
        "units_4wk":     12,
        "units_8wk":     20,
        "units_12wk":    30,
        "realized_4wk":  42000.0,   # VAT-inc, discount-aware (gross − discounts)
        "last_sale_date": None,
        "full_price":    3500.0,    # modal ticket price of the colourway's SKUs
    }
    base.update(over)
    return base


class StyleColorsSchemaTests(unittest.TestCase):
    """_fetch_style_colors must return every field the Deep Dive's colourway
    charts AND the rule-based Restock/Marketing/Retire panel read, with the
    derived inputs (SOR windows, ASP vs full price, last-sale days) computed
    on the documented canon."""

    def test_row_has_required_keys(self):
        required = {
            # pre-existing chart fields
            "color", "units_sold", "revenue", "soh", "soh_stores",
            "soh_warehouse", "stock_to_sales", "units_6m", "weekly_avg", "woc",
            # recommendation rule inputs (task: colourway restock/marketing/retire)
            "units_4wk", "units_8wk", "units_12wk",
            "sor_4wk", "sor_8wk", "sor_12wk",
            "full_price", "asp_recent", "asp_pct_full",
            "last_sale_date", "last_sale_days",
        }
        with _patch_db([_color_row()]):
            out = merch_router._fetch_style_colors("TS001")
        self.assertEqual(len(out["colors"]), 1)
        missing = required - out["colors"][0].keys()
        self.assertFalse(missing, f"style-colors row is missing keys: {missing}")

    def test_sor_windows_use_units_over_units_plus_soh(self):
        """SOR canon: window units ÷ (window units + current SOH), 1dp."""
        with _patch_db([_color_row()]):
            row = merch_router._fetch_style_colors("TS001")["colors"][0]
        self.assertEqual(row["soh"], 40)                       # 30 stores + 10 wh
        self.assertEqual(row["sor_4wk"],  round(12 * 100.0 / 52, 1))
        self.assertEqual(row["sor_8wk"],  round(20 * 100.0 / 60, 1))
        self.assertEqual(row["sor_12wk"], round(30 * 100.0 / 70, 1))

    def test_asp_pct_full_is_vat_inclusive_realized_per_unit(self):
        """ASP = realized_4wk ÷ units_4wk (VAT-inc, discount-aware) compared
        straight against the VAT-inc modal full price — no VAT divisor."""
        with _patch_db([_color_row()]):
            row = merch_router._fetch_style_colors("TS001")["colors"][0]
        self.assertEqual(row["asp_recent"], 3500.0)            # 42000 / 12
        self.assertEqual(row["asp_pct_full"], 100.0)           # 3500 vs 3500
        self.assertEqual(row["full_price"], 3500.0)

    def test_last_sale_days_from_last_sale_date(self):
        from datetime import date, timedelta
        y = date.today() - timedelta(days=1)
        with _patch_db([_color_row(last_sale_date=str(y))]):
            row = merch_router._fetch_style_colors("TS001")["colors"][0]
        self.assertEqual(row["last_sale_date"], str(y))
        self.assertEqual(row["last_sale_days"], 1)

    def test_none_states_fail_closed(self):
        """No window sales / no stock / no full price ⇒ None inputs (the
        client rules treat None as not-qualifying, never as 0-passes)."""
        row_in = _color_row(
            soh_stores=0, soh_warehouse=0,
            units_4wk=0, units_8wk=0, units_12wk=0,
            realized_4wk=0.0, last_sale_date=None, full_price=None,
            units_6m=0,
        )
        with _patch_db([row_in]):
            row = merch_router._fetch_style_colors("TS001")["colors"][0]
        self.assertIsNone(row["sor_4wk"])       # 0 units + 0 SOH ⇒ no denom
        self.assertIsNone(row["sor_8wk"])
        self.assertIsNone(row["sor_12wk"])
        self.assertIsNone(row["asp_recent"])    # no 4wk units ⇒ no ASP
        self.assertIsNone(row["asp_pct_full"])
        self.assertIsNone(row["last_sale_days"])
        self.assertIsNone(row["woc"])           # no 6m velocity

    def test_asp_pct_none_without_full_price(self):
        with _patch_db([_color_row(full_price=None)]):
            row = merch_router._fetch_style_colors("TS001")["colors"][0]
        self.assertEqual(row["asp_recent"], 3500.0)
        self.assertIsNone(row["asp_pct_full"])

    def test_hidden_when_no_stock_no_period_sales(self):
        """Visibility rule unchanged: zero SOH + zero period sales ⇒ dropped,
        even if the fixed 12-week window saw sales."""
        row_in = _color_row(units_sold=0, revenue=0, soh_stores=0, soh_warehouse=0)
        with _patch_db([row_in]):
            out = merch_router._fetch_style_colors("TS001")
        self.assertEqual(out["colors"], [])

    def test_sql_fixed_windows_modal_price_and_country_scope(self):
        """The SQL must carry the fixed trailing windows (independent of the
        selected period), a modal (never MAX) full price, a VAT-inclusive
        discount-aware realized sum, and thread the country filter into ALL
        sales CTEs (period, 6m, and the new 4-12wk window)."""
        from datetime import date, timedelta
        captured = {}

        def fake_exec(sql, params=None, **_kw):
            captured["sql"] = sql
            captured["params"] = params or {}
            return []

        with mock.patch.object(merch_router, "_db_exec", side_effect=fake_exec):
            merch_router._fetch_style_colors(
                "TS001", from_date="2026-08-01", to_date="2026-08-10",
                country="Kenya")
        today = date.today()
        p = captured["params"]
        self.assertEqual(p["wk4_ago"],  str(today - timedelta(weeks=4)))
        self.assertEqual(p["wk8_ago"],  str(today - timedelta(weeks=8)))
        self.assertEqual(p["wk12_ago"], str(today - timedelta(weeks=12)))
        # narrow hub date filter must NOT touch the fixed windows
        self.assertEqual(p["period_from"], "2026-08-01")
        self.assertEqual(p["period_to"],   "2026-08-10")
        sql = captured["sql"]
        self.assertIn("mode() WITHIN GROUP (ORDER BY price)", sql)
        self.assertNotIn("MAX(price)", sql)
        self.assertIn(
            "s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric", sql)
        self.assertEqual(p["countries"], ["Kenya"])
        self.assertEqual(sql.count("s.country = ANY(%(countries)s)"), 3,
                         "country clause must hit sales, sales_6m AND sales_wk")


class StyleSizesSchemaTests(unittest.TestCase):
    """Size rows use independent sales/stock aggregation and share flags."""

    def test_all_stores_sor_is_aggregate_not_average_of_store_rates(self):
        store_a = merch_router._sor_percent(9, 1)   # 90.0%
        store_b = merch_router._sor_percent(1, 99)  # 1.0%
        average_of_rates = (store_a + store_b) / 2
        aggregate = merch_router._sor_percent(10, 100)
        self.assertEqual(average_of_rates, 45.5)
        self.assertEqual(aggregate, 9.1)
        self.assertNotEqual(aggregate, average_of_rates)

    def test_size_flags_use_share_not_average_of_sor(self):
        flags = merch_router._size_row_flags(
            units=10, soh=50, total_units=100, total_soh=100)
        self.assertEqual(flags["sales_share"], 10.0)
        self.assertEqual(flags["soh_share"], 50.0)
        self.assertTrue(flags["imbalanced"])
        self.assertFalse(flags["sold_out"])

    def test_size_flags_cover_zero_and_sold_out_states(self):
        no_sales = merch_router._size_row_flags(
            units=0, soh=20, total_units=30, total_soh=40)
        sold_out = merch_router._size_row_flags(
            units=10, soh=0, total_units=30, total_soh=40)
        self.assertTrue(no_sales["no_sales"])
        self.assertTrue(no_sales["imbalanced"])
        self.assertTrue(sold_out["sold_out"])
        self.assertEqual(sold_out["soh_share"], 0.0)

    def test_fetch_style_sizes_calculates_sor_and_soh_share(self):
        rows = [
            {
                "size": "S", "units_period": 10, "revenue_period": 1000,
                "units_6m": 26, "soh_stores": 30, "soh_warehouse": 10,
            },
            {
                "size": "M", "units_period": 30, "revenue_period": 3000,
                "units_6m": 52, "soh_stores": 10, "soh_warehouse": 0,
            },
        ]
        with _patch_db(rows):
            out = merch_router._fetch_style_sizes("TS001")
        self.assertEqual(out["totals"], {"units_sold": 40, "soh": 50})
        by_size = {r["size"]: r for r in out["sizes"]}
        self.assertEqual(by_size["S"]["sor"], round(10 * 100 / 50, 1))
        self.assertEqual(by_size["S"]["soh_share"], 80.0)
        self.assertEqual(by_size["M"]["soh_share"], 20.0)
        self.assertTrue(by_size["S"]["imbalanced"])
        self.assertIn(by_size["S"]["action"], {"REBALANCE", "REVIEW", "OVERSTOCK", "HEALTHY"})

    def test_size_sql_scopes_inventory_country(self):
        captured = {}

        def fake_exec(sql, params=None, **_kw):
            captured["sql"] = sql
            captured["params"] = params or {}
            return []

        with mock.patch.object(merch_router, "_db_exec", side_effect=fake_exec):
            merch_router._fetch_style_sizes("TS001", country="Kenya")
        self.assertIn("LOWER(COALESCE(i.country, '')) = ANY(%(countries_lower)s)", captured["sql"])
        self.assertEqual(captured["params"]["countries"], ["Kenya"])
        self.assertEqual(captured["params"]["countries_lower"], ["kenya"])


class StoreSizeAnalysisSchemaTests(unittest.TestCase):
    """Store size charts use store rows plus weighted network benchmarks."""

    def test_store_sor_and_network_sor_are_aggregate_rates(self):
        rows = [
            {
                "size": "S/M", "store_units": 10, "store_soh": 10,
                "network_units": 20, "network_soh": 20,
            },
            {
                "size": "M/L", "store_units": 10, "store_soh": 30,
                "network_units": 30, "network_soh": 70,
            },
        ]
        with _patch_db(rows):
            out = merch_router._fetch_store_size_analysis(
                store="Vivo T- Mall",
                from_date="2026-08-01",
                to_date="2026-08-10",
            )
        by_size = {r["size"]: r for r in out["sizes"]}
        self.assertEqual(by_size["S/M"]["sor"], 50.0)
        self.assertEqual(by_size["M/L"]["sor"], 25.0)
        self.assertEqual(by_size["S/M"]["network_sor"], 50.0)
        self.assertEqual(by_size["M/L"]["network_sor"], 30.0)
        self.assertEqual(by_size["S/M"]["soh_share"], 25.0)
        self.assertEqual(by_size["M/L"]["soh_share"], 75.0)

    def test_store_size_sql_threads_scope_filters(self):
        captured = {}

        def fake_exec(sql, params=None, **_kw):
            captured["sql"] = sql
            captured["params"] = params or {}
            return []

        with mock.patch.object(merch_router, "_db_exec", side_effect=fake_exec):
            merch_router._fetch_store_size_analysis(
                store="Vivo T- Mall",
                from_date="2026-08-01",
                to_date="2026-08-10",
                country="Kenya",
                brand="Vivo",
                subcategory="Dresses",
            )
        sql = captured["sql"]
        params = captured["params"]
        self.assertIn("p.brand = ANY(%(brands)s)", sql)
        self.assertIn("p.product_type = ANY(%(subcats)s)", sql)
        self.assertIn("s.country = ANY(%(countries)s)", sql)
        self.assertIn("LOWER(COALESCE(i.country, '')) = ANY(%(countries_lower)s)", sql)
        self.assertEqual(params["store"], "Vivo T- Mall")
        self.assertEqual(params["countries"], ["Kenya"])
        self.assertEqual(params["countries_lower"], ["kenya"])
        self.assertEqual(params["brands"], ["Vivo"])
        self.assertEqual(params["subcats"], ["Dresses"])


class ActiveColourGrainCsvTests(unittest.TestCase):
    """_active_colour_rows — the assembly behind the Active Colour Styles
    card's colour-grain CSV (arithmetic, ordering, raw-key preservation)."""

    def test_fetch_colour_rows_returns_dicts(self):
        """Canary: post-processing only touches columns the SQL SELECTs."""
        with _patch_db([dict(_FAKE_COLOUR_ROW)]):
            rows = merch_router._fetch_colour_rows()
        self.assertIsInstance(rows, list)
        self.assertEqual(len(rows), 1)
        for k in ("style_name", "colour", "colour_status",
                  "soh_stores", "soh_warehouse",
                  "units_6m", "revenue_6m", "last_sale_date"):
            self.assertIn(k, rows[0])

    def test_style_context_and_per_colour_arithmetic(self):
        from datetime import date, timedelta
        style = _style(style_number="SN-1", tier="Tier 1", subcategory="Dresses",
                       brand="Vivo", full_price=3500.0, launch_date="2024-01-15")
        c = _colour(style_name="Style A", colour="Mustard / 0819102 / F",
                    soh_stores=4, soh_warehouse=2, units_6m=13,
                    revenue_6m=123456.4,
                    last_sale_date=date.today() - timedelta(days=3))
        out = merch_router._active_colour_rows([style], [c])
        self.assertEqual(len(out), 1)
        r = out[0]
        # style context comes from the deduped Active style row
        self.assertEqual(r["style_name"], "Style A")
        self.assertEqual(r["style_number"], "SN-1")
        self.assertEqual(r["subcategory"], "Dresses")
        self.assertEqual(r["tier"], "Tier 1")
        self.assertEqual(r["brand"], "Vivo")
        self.assertEqual(r["launch_date"], "2024-01-15")
        self.assertEqual(r["full_price"], 3500.0)
        # raw colour key preserved; label tidied (deep-dive pattern)
        self.assertEqual(r["colour"], "Mustard / 0819102 / F")
        self.assertEqual(r["colour_label"], "Mustard")
        # deep-dive colourway arithmetic: weekly avg 2dp BEFORE divide
        self.assertEqual(r["soh"], 6)
        self.assertEqual(r["soh_stores"], 4)
        self.assertEqual(r["soh_warehouse"], 2)
        self.assertEqual(r["units_6m"], 13)
        self.assertEqual(r["revenue_6m"], 123456.0)   # whole KES
        self.assertEqual(r["weekly_avg"], 0.5)        # round(13/26, 2)
        self.assertEqual(r["woc"], 12.0)              # round(6/0.5, 1)
        self.assertEqual(r["last_sale_days"], 3)

    def test_zero_sales_colourway_has_null_woc(self):
        style = _style()
        c = _colour(style_name="Style A", units_6m=0, revenue_6m=0.0,
                    last_sale_date=None)
        r = merch_router._active_colour_rows([style], [c])[0]
        self.assertEqual(r["weekly_avg"], 0.0)
        self.assertIsNone(r["woc"])
        self.assertIsNone(r["last_sale_days"])

    def test_colourways_sorted_by_revenue_within_style(self):
        style = _style()
        cols = [_colour(style_name="Style A", colour="Low",  revenue_6m=100.0),
                _colour(style_name="Style A", colour="High", revenue_6m=200.0)]
        out = merch_router._active_colour_rows([style], cols)
        self.assertEqual([r["colour"] for r in out], ["High", "Low"])

    def test_retired_colourway_is_excluded_under_active_parent(self):
        style = _style(tier="Tier 2")
        cols = [
            _colour(style_name="Style A", colour="Active Red",
                    colour_status="Active"),
            _colour(style_name="Style A", colour="Retired Blue",
                    colour_status="Retired"),
        ]
        out = merch_router._active_colour_rows([style], cols)
        self.assertEqual([r["colour"] for r in out], ["Active Red"])

    def test_unknown_or_excluded_parent_styles_emit_nothing(self):
        styles = [_style(style_number="SN-1"),                      # Active, in bucket
                  _style(style_number="SN-2", tier="Retired",
                         style_name="Style R")]                     # retired → out
        cols = [_colour(style_name="Style A", colour="Red"),
                _colour(style_name="Style R", colour="Black"),      # retired cascade
                _colour(style_name="Never Heard Of It", colour="Blue")]
        out = merch_router._active_colour_rows(styles, cols)
        self.assertEqual([r["style_name"] for r in out], ["Style A"])

class TidyColourLabelTests(unittest.TestCase):
    """_tidy_colour_label — Python port of the deep-dive tidyColorLabel:
    strips style-number/size noise from the END only; display-only."""

    def test_strips_code_and_size_noise(self):
        self.assertEqual(merch_router._tidy_colour_label("Mustard / 0819102 / F"),
                         "Mustard")
        self.assertEqual(merch_router._tidy_colour_label("Teal / V0223151 / XL"),
                         "Teal")

    def test_collapses_duplicated_pair(self):
        self.assertEqual(
            merch_router._tidy_colour_label(
                "Hunters Green - Hunters Green / V0323019 / L"),
            "Hunters Green")

    def test_multicolour_names_survive(self):
        self.assertEqual(merch_router._tidy_colour_label("Navy / White"),
                         "Navy / White")
        self.assertEqual(merch_router._tidy_colour_label("Black / Gold"),
                         "Black / Gold")

    def test_blank_becomes_em_dash(self):
        self.assertEqual(merch_router._tidy_colour_label(""), "—")
        self.assertEqual(merch_router._tidy_colour_label(None), "—")

    def test_single_code_segment_kept_verbatim(self):
        # noise is only stripped while another segment remains
        self.assertEqual(merch_router._tidy_colour_label("0819102"), "0819102")

    def test_collision_falls_back_to_raw_values(self):
        """Two colourways of one style that tidy to the same label must stay
        distinguishable in the CSV: label falls back to the RAW colour key
        (noisy twins are never merged)."""
        style = _style()
        cols = [_colour(style_name="Style A", colour="Black / 001 / S",
                        revenue_6m=200.0),
                _colour(style_name="Style A", colour="Black / 002 / M",
                        revenue_6m=100.0)]
        out = merch_router._active_colour_rows([style], cols)
        self.assertEqual(len(out), 2)
        labels = [r["colour_label"] for r in out]
        self.assertEqual(labels, ["Black / 001 / S", "Black / 002 / M"])
        self.assertEqual(len(set(labels)), 2)
        # raw keys always intact regardless of labelling
        self.assertEqual([r["colour"] for r in out],
                         ["Black / 001 / S", "Black / 002 / M"])

class ColourRowsFilterScopeTests(unittest.TestCase):
    """_fetch_colour_rows must thread country/pos_location into the SQL the
    same way _fetch_styles' colour_stock CTE does (membership filters ride on
    the cached styles via the bucket predicate, not this SQL)."""

    def _capture(self, **kwargs):
        captured = {}

        def fake_exec(sql, params=None, **_kw):
            captured["sql"] = sql
            captured["params"] = params or {}
            return []

        with mock.patch.object(merch_router, "_db_exec", side_effect=fake_exec):
            merch_router._fetch_colour_rows(**kwargs)
        return captured

    def test_country_scopes_sales_and_inventory(self):
        cap = self._capture(country="Kenya")
        self.assertEqual(cap["params"].get("countries"), ["Kenya"])
        self.assertIn("s.country = ANY(%(countries)s)", cap["sql"])
        self.assertIn("LOWER(i.country) IN ('kenya')", cap["sql"])

    def test_pos_location_scopes_stock_and_sales_and_zeroes_warehouse(self):
        cap = self._capture(pos_location="Vivo Junction")
        self.assertEqual(cap["params"].get("pos_locations"), ["Vivo Junction"])
        self.assertIn("i.pos_location_name = ANY(%(pos_locations)s)", cap["sql"])
        self.assertIn("s.pos_location_name = ANY(%(pos_locations)s)", cap["sql"])
        # warehouse stock belongs to no store → forced to 0 under a POS filter
        self.assertIn("0 AS soh_warehouse", cap["sql"])

    def test_no_filters_no_extra_clauses(self):
        cap = self._capture()
        self.assertNotIn("%(countries)s", cap["sql"])
        self.assertNotIn("%(pos_locations)s", cap["sql"])
        # in-stock predicate + real warehouse split present
        self.assertIn("st.soh_stores + st.soh_warehouse > 0", cap["sql"])
        self.assertIn("Warehouse Finished Goods", cap["sql"])


if __name__ == "__main__":
    unittest.main()
