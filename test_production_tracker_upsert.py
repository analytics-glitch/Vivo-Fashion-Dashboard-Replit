"""Regression coverage for the production tracker order upsert.

The order row has 18 application-supplied values plus the server-owned
``updated_at`` expression.  A shorter execute_values template fails before
the transaction reaches Postgres, preventing new buying orders from reaching
the BI date filter.
"""

import unittest
from unittest.mock import patch

from sync_production_tracker import upsert_orders


class ProductionTrackerUpsertTests(unittest.TestCase):
    def test_order_values_template_accepts_all_order_values(self):
        order = {
            "order_ref": "BO-TEST",
            "odoo_id": 1,
            "style_number": "ST-001",
            "style_name": "Test Style",
            "product_name": "Test Product",
            "product_sku": "SKU-001",
            "order_qty": 10,
            "date_ordered": "2026-08-24",
            "cost_price_kes": None,
            "cost_source": None,
            "expected_delivery_date": "2026-09-01",
            "buyer": "Buyer",
            "production_type": "New",
            "lifecycle_type": "New",
            "bo_state": "draft",
            "notes_html": None,
        }

        with patch("sync_production_tracker.execute_values") as execute_values:
            upsert_orders(object(), [order])

        args, kwargs = execute_values.call_args
        rows = args[2]
        template = kwargs["template"]
        self.assertEqual(len(rows[0]), 18)
        self.assertEqual(template.count("%s"), len(rows[0]))
        self.assertTrue(template.endswith(",now())"))


if __name__ == "__main__":
    unittest.main()