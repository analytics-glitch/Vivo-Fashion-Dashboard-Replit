"""Regression coverage for route-aware Stock Movement transfer attribution."""

import unittest

import extract_odoo_transfers as transfers


class TestStoreFlowTransferRoutes(unittest.TestCase):
    def test_normal_store_counts_only_whfin_to_named_transit(self):
        self.assertEqual(
            transfers._store_flow_route(
                "transit", "Vivo Kileleshwa",
                transfers.WHFIN_STOCK_ID, "WHFIN"),
            "warehouse_to_transit",
        )
        self.assertIsNone(
            transfers._store_flow_route(
                "transit", "Vivo Kileleshwa", 1060, "KILEL"),
        )
        self.assertEqual(
            transfers._store_flow_route(
                "store", "Vivo Kileleshwa",
                transfers.WHFIN_STOCK_ID, "WHFIN"),
            "non_reportable_direct",
        )

    def test_all_three_direct_exceptions_remain_reportable(self):
        for store_name in (
            "Vivo Acacia", "The Oasis Mall", "Vivo Kigali Heights",
        ):
            for source_code in ("WHFIN", "FGPRD"):
                with self.subTest(
                    store_name=store_name, source_code=source_code,
                ):
                    self.assertEqual(
                        transfers._store_flow_route(
                            "store", store_name,
                            transfers.WHFIN_STOCK_ID, source_code),
                        "warehouse_to_store_exception",
                    )

    def test_historical_backfill_includes_fgprd_exception_rows(self):
        class FakeCursor:
            def __init__(self):
                self.statements = []

            def execute(self, statement):
                self.statements.append(statement)

        class FakeConnection:
            def __init__(self):
                self.cursor_instance = FakeCursor()

            def cursor(self):
                return self.cursor_instance

            def commit(self):
                pass

        conn = FakeConnection()
        transfers.ensure_table(conn)
        exception_migration = next(
            statement for statement in conn.cursor_instance.statements
            if "SET store_flow_route = 'warehouse_to_store_exception'" in statement
        )
        self.assertIn("'FGPRD'", exception_migration)
        # Legacy FGPRD rows were typed "other"; migration must classify by the
        # established source/store route rather than old transfer_type.
        self.assertNotIn("transfer_type", exception_migration)

    def test_non_warehouse_routes_into_transit_are_rejected(self):
        for source_id, source_code in (
            (1727, "Shopping Bags"),
            (1060, "KILEL"),
            (1828, "Retir"),
        ):
            with self.subTest(source_code=source_code):
                self.assertIsNone(
                    transfers._store_flow_route(
                        "transit", "Vivo Kileleshwa",
                        source_id, source_code),
                )

    def test_transit_destinations_normalize_to_canonical_store_ids(self):
        self.assertEqual(
            transfers.TRANSIT_DEST_TO_STORE_DEST[1965],
            1060,
        )
        self.assertEqual(
            transfers.TRANSIT_DEST_TO_STORE_DEST[1982],
            1386,
        )
        self.assertNotIn(1984, transfers.TRANSIT_DEST_TO_STORE_DEST)
        self.assertNotIn(1991, transfers.TRANSIT_DEST_TO_STORE_DEST)

    def test_reportable_route_tags_exclude_duplicates_and_open_rows(self):
        rows = [
            # Completed WHFIN -> Transit: visible quantity.
            {"state": "done", "route": "warehouse_to_transit",
             "qty_done": 12, "qty_planned": 15},
            # Open WHFIN -> Transit: incoming only.
            {"state": "assigned", "route": "warehouse_to_transit",
             "qty_done": 0, "qty_planned": 9},
            # Later Transit -> Store leg and old direct route: never visible.
            {"state": "done", "route": None,
             "qty_done": 12, "qty_planned": 12},
            {"state": "done", "route": "non_reportable_direct",
             "qty_done": 12, "qty_planned": 12},
        ]
        reportable = {
            "warehouse_to_transit", "warehouse_to_store_exception",
        }
        completed = sum(
            r["qty_done"] for r in rows
            if r["state"] == "done" and r["route"] in reportable
        )
        incoming = sum(
            r["qty_planned"] for r in rows
            if r["state"] != "done" and r["route"] in reportable
        )
        drill_total = sum(
            r["qty_done"] for r in rows
            if r["state"] == "done" and r["route"] in reportable
        )
        self.assertEqual(completed, 12)
        self.assertEqual(incoming, 9)
        self.assertEqual(drill_total, completed)


if __name__ == "__main__":
    unittest.main()