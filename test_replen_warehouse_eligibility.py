"""Regression tests for dispatch-ready replenishment warehouse eligibility."""

import unittest
from pathlib import Path
from unittest import mock

import api_pg


class ReplenWarehouseEligibilityTests(unittest.TestCase):
    def test_dispatch_source_excludes_finished_goods_production(self):
        self.assertEqual(api_pg.WH_DISPATCH_LOCATION, "'Warehouse Finished Goods'")
        source = Path("api_pg.py").read_text()
        self.assertNotIn(
            "WHERE i.pos_location_name = 'Finished Goods Production'\n"
            "              AND i.sku IN",
            source,
        )

    def test_live_state_queries_only_dispatch_ready_warehouse(self):
        queries = []
        with mock.patch.object(
                api_pg, "_ensure_replen_distribution_tables"), mock.patch.object(
                api_pg, "_inventory_version", return_value="snapshot-1"), mock.patch.object(
                api_pg, "_users_exec",
                side_effect=lambda query, *args, **kwargs: queries.append(query) or []):
            state = api_pg._replen_distribution_live_state()
        self.assertEqual(state["inventory_version"], "snapshot-1")
        self.assertIn(
            "pos_location_name = 'Warehouse Finished Goods'", queries[0])
        self.assertNotIn("Finished Goods Production", queries[0])

    def test_frozen_line_that_falls_to_zero_is_unavailable(self):
        lines = [{
            "line_id": 1,
            "created_at": "2026-09-01T08:00:00+03:00",
            "sku": "SKU-ZERO",
            "suggested_units": 2,
        }]
        allocated = api_pg._allocate_replen_distribution_availability(
            lines, {"SKU-ZERO": 0})
        self.assertEqual(allocated, {1: 0})

    def test_competing_store_lines_share_one_warehouse_pool(self):
        lines = [
            {
                "line_id": 10,
                "created_at": "2026-09-01T08:00:00+03:00",
                "sku": "SKU-LIMITED",
                "suggested_units": 2,
            },
            {
                "line_id": 11,
                "created_at": "2026-09-01T08:01:00+03:00",
                "sku": "SKU-LIMITED",
                "suggested_units": 2,
            },
        ]
        allocated = api_pg._allocate_replen_distribution_availability(
            lines, {"SKU-LIMITED": 3})
        self.assertEqual(allocated, {10: 2, 11: 1})
        self.assertEqual(sum(allocated.values()), 3)


if __name__ == "__main__":
    unittest.main()