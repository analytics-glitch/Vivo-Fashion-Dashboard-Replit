import unittest
from unittest.mock import patch

import merch_router


class _LifecycleStub:
    @staticmethod
    def _lifecycle_tier(style_name, *_args, **_kwargs):
        if style_name == "Always On Dress":
            return "Tier 1"
        if style_name == "Core Trouser":
            return "Tier 2"
        if style_name == "Retired Dress":
            return "Retired"
        return None


def _row(style, colour, stock, *, tier_pipeline=0, colour_pipeline=0,
         fabric_stock=None, other_fabric_stock=None, last_sale="2026-08-28",
         style_last_order="2026-08-01", colour_last_order="2026-08-01"):
    return {
        "category": "Dresses" if "Dress" in style else "Bottoms",
        "subcategory": "Midi & Capri Dresses" if "Dress" in style else "Full Length Pants",
        "style_name": style,
        "style_number": "D100" if "Dress" in style else "T200",
        "style_status": "Active",
        "colour": colour,
        "colour_status": "Active",
        "fabric_barcode": "FAB-001" if colour == "Black" else None,
        "fabric_stock_metres": (
            fabric_stock if fabric_stock is not None
            else (125.5 if colour == "Black" else None)
        ),
        "fabric_other_colour_stock_metres": other_fabric_stock,
        "soh_stores": stock,
        "soh_online": 0,
        "soh_warehouse": 0,
        "stock_units": stock,
        "stock_value": stock * 1000,
        "units_period": 10,
        "revenue_period": 10000,
        "achieved_sales_gross": 11600,
        "full_price_value": 14500,
        "last_sale_date": last_sale,
        "style_last_order": style_last_order,
        "colour_last_order": colour_last_order,
        "units_6m": 26,
        "pipeline_units": tier_pipeline,
        "pipeline_by_state": {
            "draft": tier_pipeline,
            "bom_pending": 0,
            "ready": 0,
            "partially_planned": 0,
            "fully_planned": 0,
        },
        "colour_pipeline_units": colour_pipeline,
        "colour_pipeline_by_state": {
            "draft": colour_pipeline,
            "bom_pending": 0,
            "ready": 0,
            "partially_planned": 0,
            "fully_planned": 0,
        },
        "is_noos": style == "Always On Dress",
        "skus_in_stock": 1,
        "skus_sold": 1,
    }


class MerchStockMixStabilityTest(unittest.TestCase):
    def setUp(self):
        self.original_api = merch_router.A
        merch_router.A = _LifecycleStub()

    def tearDown(self):
        merch_router.A = self.original_api

    @patch("merch_router._db_exec")
    def test_repeated_fixed_period_reads_have_identical_sellable_soh(self, db_exec):
        # Pipeline is repeated by SQL on each colour row at style grain. The
        # API must add it once per style, while sellable SOH remains the sum of
        # the separately pre-aggregated colour rows.
        stock_rows = [
            _row("Always On Dress", "Black", 12, tier_pipeline=100, colour_pipeline=60),
            _row("Always On Dress", "Blue", 8, tier_pipeline=100, colour_pipeline=40),
            _row("Core Trouser", "Black", 5, tier_pipeline=25, colour_pipeline=25),
        ]
        pipeline_rows = [
            {
                "grain": "style", "style_number": "D100",
                "style_name": "Always On Dress", "colour": None,
                "bo_state": "draft", "units": 100,
            },
            {
                "grain": "style", "style_number": "T200",
                "style_name": "Core Trouser", "colour": None,
                "bo_state": "draft", "units": 25,
            },
        ]
        db_exec.side_effect = lambda sql, *_args, **_kwargs: (
            pipeline_rows if "FROM production_orders po" in sql else stock_rows
        )

        first = merch_router._fetch_stock_mix(
            from_date="2026-08-01",
            to_date="2026-08-31",
            include_retired=False,
        )
        second = merch_router._fetch_stock_mix(
            from_date="2026-08-01",
            to_date="2026-08-31",
            include_retired=False,
        )

        self.assertEqual(25, first["totals"]["stock_units"])
        self.assertEqual(25, first["totals"]["soh_stores"])
        self.assertEqual(0, first["totals"]["soh_online"])
        self.assertEqual(0, first["totals"]["soh_warehouse"])
        self.assertEqual(125, first["totals"]["pipeline_units"])
        self.assertEqual(125, first["totals"]["wip_units"])
        self.assertEqual(
            first["totals"]["stock_units"],
            first["totals"]["soh_stores"]
            + first["totals"]["soh_online"]
            + first["totals"]["soh_warehouse"],
        )
        self.assertEqual(80.0, first["totals"]["full_price_pct"])
        first_style = first["categories"][0]["subcategories"][0]["styles"][0]
        self.assertEqual("Tier 1", first_style["tier"])
        self.assertEqual(first_style["pipeline_units"], first_style["wip_units"])
        self.assertTrue(all(c["tier"] == first_style["tier"] for c in first_style["colours"]))
        self.assertTrue(all(c["pipeline_units"] == c["wip_units"] for c in first_style["colours"]))
        self.assertNotIn("fabric_stock_metres", first_style)
        black = next(c for c in first_style["colours"] if c["name"] == "Black")
        blue = next(c for c in first_style["colours"] if c["name"] == "Blue")
        self.assertEqual("FAB-001", black["fabric_barcode"])
        self.assertEqual(125.5, black["fabric_stock_metres"])
        self.assertNotIn("fabric_other_colour_stock_metres", first_style)
        self.assertIsNone(blue["fabric_barcode"])
        self.assertIsNone(blue["fabric_stock_metres"])
        self.assertEqual(first["totals"], second["totals"])
        self.assertEqual(first["categories"], second["categories"])

        sql = db_exec.call_args_list[0].args[0]
        self.assertIn("inventory_source AS", sql)
        self.assertIn("Warehouse Finished Goods", sql)
        self.assertIn(
            "COALESCE(cl.colour_status, p.style_status, 'Unreviewed')",
            sql,
        )
        self.assertIn("NOT IN ('Retired', 'Archived')", sql)
        self.assertIn("'Unreviewed'", sql)
        self.assertIn("fabric_stock AS", sql)
        self.assertIn("fabric_stock_base AS", sql)
        self.assertIn("PARTITION BY fabric_quality_key", sql)
        self.assertIn("i.available / p.kg_per_mtr_eff", sql)
        self.assertIn("i.location_name = 'RMAT/Stock'", sql)
        self.assertIn(
            "s.sale_date BETWEEN %(period_from)s AND %(period_to)s",
            sql,
        )
        pipeline_sql = db_exec.call_args_list[1].args[0]
        self.assertIn("v_stage_balances", pipeline_sql)
        self.assertIn("stage <> 'warehouse'", pipeline_sql)
        self.assertIn("> %(wip_max_age_days)s AS stale", pipeline_sql)

    @patch("merch_router._db_exec")
    def test_tier_filters_change_stock_mix_totals(self, db_exec):
        stock_rows = [
            _row("Always On Dress", "Black", 12),
            _row("Core Trouser", "Black", 5),
        ]
        db_exec.side_effect = lambda sql, *_args, **_kwargs: (
            [] if "FROM production_orders po" in sql else stock_rows
        )

        tier_1 = merch_router._fetch_stock_mix(tier="Tier 1")
        tier_2 = merch_router._fetch_stock_mix(tier="Tier 2")

        self.assertEqual(12, tier_1["totals"]["stock_units"])
        self.assertEqual(5, tier_2["totals"]["stock_units"])
        self.assertNotEqual(tier_1["totals"], tier_2["totals"])

    @patch("merch_router._db_exec")
    def test_unknown_lifecycle_tier_is_included_as_needs_review(self, db_exec):
        stock_rows = [_row("Unknown Status Style", "Black", 9)]
        stock_rows[0]["style_status"] = "Unreviewed"
        stock_rows[0]["colour_status"] = "Unreviewed"
        db_exec.side_effect = lambda sql, *_args, **_kwargs: (
            [] if "FROM production_orders po" in sql else stock_rows
        )

        result = merch_router._fetch_stock_mix(include_retired=False)
        style = result["categories"][0]["subcategories"][0]["styles"][0]

        self.assertEqual(9, result["totals"]["stock_units"])
        self.assertEqual("Needs review", style["tier"])
        self.assertEqual("Unreviewed", style["status"])

    @patch("merch_router._db_exec")
    def test_retired_checkbox_uses_canonical_style_lifecycle(self, db_exec):
        active = _row("Always On Dress", "Black", 12)
        retired = _row("Retired Dress", "Blue", 7)
        # Raw status is deliberately blank/unreviewed: the shared lifecycle
        # classifier is authoritative for the KPI-compatible retired split.
        retired["style_status"] = "Unreviewed"
        retired["colour_status"] = "Unreviewed"
        rows = [active, retired]
        db_exec.side_effect = lambda sql, *_args, **_kwargs: (
            [] if "FROM production_orders po" in sql else rows
        )

        active_only = merch_router._fetch_stock_mix(include_retired=False)
        with_retired = merch_router._fetch_stock_mix(include_retired=True)

        self.assertEqual(12, active_only["totals"]["stock_units"])
        self.assertEqual(19, with_retired["totals"]["stock_units"])
        retired_style = next(
            style
            for category in with_retired["categories"]
            for subcategory in category["subcategories"]
            for style in subcategory["styles"]
            if style["name"] == "Retired Dress"
        )
        self.assertEqual("Retired", retired_style["status"])

    @patch("merch_router._db_exec")
    def test_colour_only_sibling_metres_and_awaiting_delivery_state(self, db_exec):
        stock_rows = [
            _row(
                "Always On Dress", "Black", 0,
                tier_pipeline=40, colour_pipeline=40,
                fabric_stock=0.0, other_fabric_stock=86.4,
                last_sale="2025-01-01",
                style_last_order="2026-08-15", colour_last_order="2026-08-15",
            ),
            _row(
                "Core Trouser", "Black", 5,
                fabric_stock=20.0, other_fabric_stock=0.0,
                last_sale="2025-01-01",
            ),
        ]
        pipeline_rows = [{
            "grain": "style", "style_number": "D100",
            "style_name": "Always On Dress", "colour": None,
            "bo_state": "draft", "units": 40,
        }, {
            "grain": "colour", "style_number": "D100",
            "style_name": "Always On Dress", "colour": "Black",
            "bo_state": "draft", "units": 40,
        }]
        db_exec.side_effect = lambda sql, *_args, **_kwargs: (
            pipeline_rows if "FROM production_orders po" in sql else stock_rows
        )

        result = merch_router._fetch_stock_mix(
            from_date="2026-08-01", to_date="2026-08-31"
        )
        styles = [
            style
            for category in result["categories"]
            for subcategory in category["subcategories"]
            for style in subcategory["styles"]
        ]
        awaiting = next(s for s in styles if s["name"] == "Always On Dress")
        stale = next(s for s in styles if s["name"] == "Core Trouser")
        colour = awaiting["colours"][0]

        self.assertTrue(awaiting["awaiting_delivery"])
        self.assertTrue(colour["awaiting_delivery"])
        self.assertGreaterEqual(awaiting["order_age_days"], 0)
        self.assertEqual(0.0, colour["fabric_stock_metres"])
        self.assertEqual(86.4, colour["fabric_other_colour_stock_metres"])
        self.assertNotIn("fabric_stock_metres", awaiting)
        self.assertNotIn("fabric_other_colour_stock_metres", awaiting)
        self.assertFalse(stale["awaiting_delivery"])
        self.assertGreaterEqual(stale["last_sale_days"], 90)


if __name__ == "__main__":
    unittest.main()