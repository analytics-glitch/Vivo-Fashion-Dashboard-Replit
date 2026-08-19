"""Regression tests for the Product Costing list status/type filters.

The list response calculates its sign-off status from the sign-off aggregate,
then applies optional comma-separated ``status`` and ``stage`` selections.
These tests use the real route function with a small in-memory query fixture so
they pin the API contract without depending on a running database.
"""
import copy
import unittest
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr


class _Conn:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _row(sheet_id, *, signed=0, approved=False, stage="main_production"):
    return {
        "id": sheet_id,
        "style_name": f"Style {sheet_id}",
        "style_number": f"ST-{sheet_id}",
        "selling_price": 1000,
        "dps_ref": None,
        "color": None,
        "updated_by_name": "Costing team",
        "updated_at": None,
        "embroidery_data": None,
        "stage": stage,
        "accessories_pct": None,
        "accessories_pct_meta": None,
        "lines_total": 500,
        "line_count": 2,
        "n_signed": signed,
        "approved": approved,
    }


class CostingSheetFilterTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            _row(1, signed=3, approved=True, stage="main_production"),
            _row(2, signed=1, stage="pre_production"),
            _row(3, signed=0, stage="pre_production"),
            _row(4, signed=0, stage=None),  # legacy NULL stage is main production
        ]
        self.patches = [
            mock.patch.object(fr, "_get_conn", return_value=_Conn()),
            mock.patch.object(fr, "_ensure_costing_tables", lambda conn: None),
            mock.patch.object(fr, "q",
                              lambda conn, sql, params=(): copy.deepcopy(self.rows)),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def ids(self, **filters):
        return [sheet["id"] for sheet in fr.costing_sheets_list(**filters)["sheets"]]

    def test_default_request_keeps_the_full_ordered_list(self):
        self.assertEqual(self.ids(), [1, 2, 3, 4])

    def test_status_filter_accepts_multiple_values(self):
        self.assertEqual(self.ids(status="approved,draft"), [1, 3, 4])

    def test_stage_filter_treats_legacy_null_as_main_production(self):
        self.assertEqual(self.ids(stage="pre_production"), [2, 3])
        self.assertEqual(self.ids(stage="main_production"), [1, 4])

    def test_status_and_stage_filters_combine_with_and_logic(self):
        self.assertEqual(
            self.ids(status="partial,draft", stage="pre_production"), [2, 3])
        self.assertEqual(self.ids(status="approved", stage="pre_production"), [])

    def test_invalid_filter_value_is_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            fr.costing_sheets_list(status="approved,unknown")
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()