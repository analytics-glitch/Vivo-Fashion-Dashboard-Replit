"""Regression coverage for snapshot-safe Warehouse -> Store IBT picks."""

import pathlib
import unittest
from unittest import mock

import api_pg


ROOT = pathlib.Path(__file__).resolve().parent
FLAT_TABLE = ROOT / "artifacts/vivo-bi/src/components/IBTFlatTable.jsx"
WAREHOUSE_TABLE = ROOT / "artifacts/vivo-bi/src/components/WarehouseToStoreIBT.jsx"
IBT_PAGE = ROOT / "artifacts/vivo-bi/src/pages/IBT.jsx"


class WarehouseIbtBackendTests(unittest.TestCase):
    def test_live_solver_warehouse_pool_excludes_production_pipeline(self):
        captured_queries = []
        with mock.patch.object(api_pg, "_inventory_version",
                               return_value="current-snapshot"), \
             mock.patch.object(api_pg, "run_query",
                               side_effect=lambda query: captured_queries.append(query) or []):
            self.assertEqual(api_pg._ibt_warehouse_avail(None), {})

        query = captured_queries[0]
        self.assertIn(
            "pos_location_name = 'Warehouse Finished Goods'",
            query,
        )
        self.assertNotIn("WAREHOUSE_LOCATIONS", query)
        self.assertNotIn("Finished Goods Production", query)
        self.assertIn("all_inventory_snapshot:current-snapshot", query)

    def test_sku_breakdown_cache_query_and_payload_follow_inventory_snapshot(self):
        captured_queries = []
        rows = [
            {
                "sku": "SKU-IN-STOCK",
                "barcode": "60070110",
                "from_available": 3,
                "to_available": 0,
                "suggested_qty": 2,
            }
        ]

        with mock.patch.object(api_pg, "_warehouse_bins_refresh"), \
             mock.patch.object(api_pg, "run_query",
                               side_effect=lambda query: captured_queries.append(query) or rows), \
             mock.patch.object(api_pg, "_inventory_version",
                               side_effect=["snapshot-one", "snapshot-two"]):
            first = api_pg.ibt_sku_breakdown(
                "Test Style", "Warehouse Finished Goods", "Test Store", 2)
            second = api_pg.ibt_sku_breakdown(
                "Test Style", "Warehouse Finished Goods", "Test Store", 2)

        self.assertEqual(first["inventory_version"], "snapshot-one")
        self.assertEqual(second["inventory_version"], "snapshot-two")
        self.assertIn("all_inventory_snapshot:snapshot-one", captured_queries[0])
        self.assertIn("all_inventory_snapshot:snapshot-two", captured_queries[1])
        self.assertNotEqual(captured_queries[0], captured_queries[1])
        self.assertIn(
            "pos_location_name = 'Warehouse Finished Goods'",
            captured_queries[0],
        )
        self.assertNotIn(
            "pos_location_name = 'Finished Goods Production'",
            captured_queries[0],
        )


class WarehouseIbtFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.flat_source = FLAT_TABLE.read_text(encoding="utf-8")
        cls.warehouse_source = WAREHOUSE_TABLE.read_text(encoding="utf-8")
        cls.ibt_page_source = IBT_PAGE.read_text(encoding="utf-8")

    def test_warehouse_cache_key_carries_inventory_snapshot(self):
        self.assertIn(
            '`${base}||inventory:${suggestion.inventory_version || "uncached"}`',
            self.flat_source,
        )
        self.assertIn(
            "{ inventory_version: s.inventory_version }",
            self.flat_source,
        )

    def test_warehouse_rows_require_live_stock_and_positive_suggestion(self):
        self.assertIn(
            "(x.from_available ?? 0) > 0 && (x.suggested_qty ?? 0) > 0",
            self.flat_source,
        )
        self.assertIn("if (_isWh(flow)) continue;", self.flat_source)

    def test_store_to_store_key_and_row_identity_are_unchanged(self):
        self.assertIn(": base;", self.flat_source)
        self.assertIn(
            "`${s.style_name}||${fromStore}||${s.to_store}||${sk.sku}`",
            self.flat_source,
        )

    def test_warehouse_parent_fetch_bypasses_generic_bi_cache(self):
        self.assertIn("forceFresh: true", self.warehouse_source)
        self.assertIn("forceFresh: true", self.ibt_page_source)


if __name__ == "__main__":
    unittest.main()