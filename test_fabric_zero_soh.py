"""Regression checks for zero-SOH Fabric visibility.

These checks intentionally inspect the real endpoint query sources instead of
connecting to the shared database.  They protect the important boundary:
zero is a valid inventory value, while trims, negative adjustment rows, and
non-dashboard locations are not part of the Fabric stock universe.
"""
import ast
import pathlib
import unittest


SOURCE = pathlib.Path(__file__).with_name("fabric_router.py").read_text()
TREE = ast.parse(SOURCE)


def function_source(name):
    for node in TREE.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.get_source_segment(SOURCE, node)
    raise AssertionError(f"missing function {name}")


class ZeroSohFabricUniverseTests(unittest.TestCase):
    def test_stock_surfaces_accept_zero_without_accepting_negative_rows(self):
        # These endpoints previously used quantity > 0 as their driving
        # universe.  A zero inventory row must survive each surface.
        for name in ("summary", "by_category", "register", "ageing",
                     "category_stock_consumption", "fabric_mix",
                     "dead_stock", "attribute_split", "color_mix"):
            src = function_source(name)
            self.assertTrue("quantity >= 0" in src or "COALESCE(i.quantity, 0) >= %s" in src,
                            name)

    def test_register_is_product_master_and_tracked_location_anchored(self):
        src = function_source("register")
        self.assertIn("FROM raw_fabric_products p", src)
        self.assertIn("CROSS JOIN (VALUES ('RMAT/Stock'), ('Dead/Stock Fabric'))", src)
        self.assertIn("COALESCE(i.quantity, 0) >= %s", src)
        self.assertIn("COALESCE(i.quantity,0)", src)
        self.assertIn("COALESCE(i.available,0)", src)
        self.assertIn("COALESCE(i.total_value,0)", src)
        self.assertIn("WHERE location_name IN ('RMAT/Stock', 'Dead/Stock Fabric')", src)

    def test_product_search_uses_master_anchor_and_numeric_zero(self):
        src = function_source("product_search")
        self.assertIn("FROM raw_fabric_products p", src)
        self.assertIn("p.category = 'Fabric'", src)
        self.assertIn("COALESCE(inv.available_kg,0)", src)
        self.assertIn("WHERE location_name IN ('RMAT/Stock', 'Dead/Stock Fabric')", src)
        self.assertNotIn("i.quantity > 0", src)

    def test_filter_and_trend_location_lists_cannot_leak_warehouses(self):
        filters_src = function_source("filters")
        trend_src = function_source("trend_options")
        for src in (filters_src, trend_src):
            self.assertIn("RMAT/Stock", src)
            self.assertIn("Dead/Stock Fabric", src)
        self.assertIn("VALUES ('RMAT/Stock'), ('Dead/Stock Fabric')", filters_src)
        self.assertIn("location_name IN ('RMAT/Stock', 'Dead/Stock Fabric')", trend_src)

    def test_search_matches_all_three_product_identifiers(self):
        src = function_source("product_search")
        self.assertIn("p.name ILIKE %s", src)
        self.assertIn("p.default_code ILIKE %s", src)
        self.assertIn("p.barcode ILIKE %s", src)


if __name__ == "__main__":
    unittest.main()