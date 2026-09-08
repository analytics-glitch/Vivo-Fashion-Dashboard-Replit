import unittest
from unittest.mock import patch

import merch_router


class TestStoreStockDiagnosis(unittest.TestCase):
    def test_capital_targets_and_missing_zero_stock_size(self):
        rows = [
            {"style_name": "A", "primary_colour": "Black", "size": "S",
             "category": "Clothing", "subcategory": "Dress", "print_plain": "Plain",
             "price": 1999, "lifecycle": "Active", "stock_units": 8, "units_sold": 4},
            {"style_name": "A", "primary_colour": "Black", "size": "M",
             "category": "Clothing", "subcategory": "Dress", "print_plain": "Plain",
             "price": 2000, "lifecycle": "Active", "stock_units": 0, "units_sold": 0},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Capital Centre", 975, rows)
        self.assertEqual(out["colour_styles"]["target"], 122)
        self.assertEqual(out["styles"]["target"], 61)
        self.assertEqual(out["size_completeness"]["rows"][0]["missing_sizes"], ["M"])
        self.assertEqual(
            merch_router._stock_diag_price_band(1999), "KES 1,000–1,999")
        self.assertEqual(
            merch_router._stock_diag_price_band(2000), "KES 2,000–2,999")

    def test_no_sales_and_lifecycle(self):
        rows = [
            {"style_name": "Old", "primary_colour": "Red", "size": "L",
             "category": "Clothing", "subcategory": "Top", "print_plain": "Plain",
             "price": 5000, "lifecycle": "Retired", "stock_units": 20, "units_sold": 0},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Meru", 100, rows)
        segment = out["stock_to_sales"]["category"][0]
        self.assertTrue(segment["no_sales"])
        self.assertIsNone(segment["weeks_of_cover"])
        self.assertEqual(out["lifecycle"][1]["units"], 20)
        self.assertEqual(out["inventory"]["variance_units"], -80)

    def test_active_sku_keeps_whole_style_active(self):
        rows = [
            {"style_name": "Mixed", "primary_colour": "Blue", "size": "S",
             "lifecycle": "Retired", "stock_units": 3, "units_sold": 0},
            {"style_name": "Mixed", "primary_colour": "Blue", "size": "M",
             "lifecycle": "Active", "stock_units": 0, "units_sold": 0},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Meru", 10, rows)
        self.assertEqual(out["lifecycle"][0]["units"], 3)
        self.assertEqual(out["lifecycle"][1]["units"], 0)

    def test_every_stock_to_sales_dimension_carries_woc(self):
        rows = [
            {"style_name": "A", "primary_colour": "Black", "size": "S",
             "category": "Clothing", "subcategory": "Dress", "print_plain": "Plain",
             "price": 2500, "lifecycle": "Active", "stock_units": 10, "units_sold": 5},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Meru", 100, rows)
        expected = {
            "category", "subcategory", "size", "primary_colour",
            "print_plain", "price_band",
        }
        self.assertEqual(set(out["stock_to_sales"]), expected)
        for dimension in expected:
            row = out["stock_to_sales"][dimension][0]
            self.assertEqual(row["weeks_of_cover"], 8.6, dimension)
            self.assertFalse(row["no_sales"], dimension)

    def test_negative_stock_is_zero_everywhere_and_stock_only_mix_counts(self):
        rows = [
            {"style_name": "A", "primary_colour": "Black", "size": "S",
             "category": "A", "subcategory": "Dress", "print_plain": "Plain",
             "price": 2500, "lifecycle": "Active", "stock_units": 10, "units_sold": 0},
            {"style_name": "B", "primary_colour": "Blue", "size": "M",
             "category": "B", "subcategory": "Top", "print_plain": "Plain",
             "price": 2500, "lifecycle": "Active", "stock_units": -4, "units_sold": 5},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Meru", 100, rows)
        self.assertEqual(out["inventory"]["actual"], 10)
        self.assertEqual(
            sum(r["inventory_units"] for r in out["stock_to_sales"]["category"]), 10)
        self.assertTrue(any(x["key"] == "mix_imbalance" for x in out["evidence"]))

    def test_unknown_size_metadata_is_not_declared_complete(self):
        rows = [
            {"style_name": "A", "primary_colour": "Black", "size": "",
             "lifecycle": "Active", "stock_units": 5, "units_sold": 1},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Meru", 10, rows)
        sizes = out["size_completeness"]
        self.assertEqual(sizes["unassessable_colour_styles"], 1)
        self.assertEqual(sizes["complete_colour_styles"], 0)

    def test_unknown_or_archived_style_is_not_relabelled_retired(self):
        rows = [
            {"style_name": "Unknown", "primary_colour": "Black", "size": "S",
             "lifecycle": "Excluded", "stock_units": 5, "units_sold": 1},
        ]
        out = merch_router._build_store_stock_diagnosis("Vivo Meru", 10, rows)
        self.assertEqual(out["inventory"]["actual"], 0)
        self.assertEqual(sum(r["units"] for r in out["lifecycle"]), 0)

    @patch("merch_router._db_exec")
    def test_all_stores_uses_active_store_scope_and_summed_target(self, db_exec):
        db_exec.side_effect = [
            [{"store_count": 2, "configured_count": 2, "optimal_stock": 300}],
            [],
        ]
        out = merch_router._fetch_store_stock_diagnosis("All Stores")
        self.assertEqual(out["store"], "All Stores")
        self.assertEqual(out["inventory"]["target"], 300)
        sql = db_exec.call_args_list[1].args[0]
        self.assertIn("i.pos_location_name NOT ILIKE '%%warehouse%%'", sql)
        self.assertIn("WHERE TRUE", sql)
        self.assertIn("mode() WITHIN GROUP (ORDER BY rop.primary_color)", sql)
        self.assertNotIn("ORDER BY p.color_print", sql)

    @patch("merch_router._db_exec")
    def test_all_stores_hides_partial_network_target(self, db_exec):
        db_exec.side_effect = [
            [{"store_count": 2, "configured_count": 1, "optimal_stock": 100}],
            [],
        ]
        out = merch_router._fetch_store_stock_diagnosis("All Stores")
        self.assertIsNone(out["inventory"]["target"])


if __name__ == "__main__":
    unittest.main()