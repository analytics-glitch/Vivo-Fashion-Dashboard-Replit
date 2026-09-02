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
        return None


def _row(style, colour, stock, *, tier_pipeline=0, colour_pipeline=0):
    return {
        "category": "Dresses" if "Dress" in style else "Bottoms",
        "subcategory": "Midi & Capri Dresses" if "Dress" in style else "Full Length Pants",
        "style_name": style,
        "style_number": "D100" if "Dress" in style else "T200",
        "style_status": "Active",
        "colour": colour,
        "colour_status": "Active",
        "stock_units": stock,
        "stock_value": stock * 1000,
        "units_period": 10,
        "revenue_period": 10000,
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
        self.assertEqual(125, first["totals"]["pipeline_units"])
        self.assertEqual(first["totals"], second["totals"])
        self.assertEqual(first["categories"], second["categories"])

        sql = db_exec.call_args_list[0].args[0]
        self.assertIn("inventory_source AS", sql)
        self.assertIn("Warehouse Finished Goods", sql)
        self.assertIn("p.style_status = 'Active'", sql)

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


if __name__ == "__main__":
    unittest.main()