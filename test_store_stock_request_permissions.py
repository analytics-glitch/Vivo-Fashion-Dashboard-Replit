"""Isolated permission checks for the Store Stock Requests server gate."""
import unittest
from unittest.mock import patch

import api_pg
from fastapi import HTTPException


class _State:
    def __init__(self, user):
        self.user = user


class _Request:
    def __init__(self, user):
        self.state = _State(user)


class StoreStockRequestPermissionTests(unittest.TestCase):
    def _request(self, role, pages=None, home="Vivo Test Store"):
        user = {"role": role, "pos_location_name": home}
        if pages is not None:
            user["allowed_pages"] = pages
        return _Request(user)

    def test_session_user_keeps_home_store(self):
        user = api_pg._user_dict({
            "user_id": "test-store-manager",
            "email": "test-store-manager@example.invalid",
            "name": "Test Store Manager",
            "role": "store_manager",
            "status": "active",
            "pos_location_name": "Vivo Test Store",
            "extra_pages": [],
        })
        self.assertEqual(user["pos_location_name"], "Vivo Test Store")

    def test_session_user_derives_store_when_profile_is_blank(self):
        with patch.object(api_pg, "_derive_pos_from_email",
                          return_value="Vivo Derived Store") as derive:
            user = api_pg._user_dict({
                "user_id": "derived-store-manager",
                "email": "vivo.derived@example.invalid",
                "name": "Derived Store Manager",
                "role": "store_manager",
                "status": "active",
                "pos_location_name": None,
                "extra_pages": [],
            })
        self.assertEqual(user["pos_location_name"], "Vivo Derived Store")
        derive.assert_called_once_with("vivo.derived@example.invalid")
        _, role, home = api_pg._ssr_user(
            _Request(user), "request")
        self.assertEqual((role, home), ("store_manager", "Vivo Derived Store"))

    def test_session_user_leaves_unresolvable_store_blank(self):
        with patch.object(api_pg, "_derive_pos_from_email", return_value=None):
            user = api_pg._user_dict({
                "user_id": "unresolved-store-manager",
                "email": "someone@example.invalid",
                "name": "Unresolved Store Manager",
                "role": "store_manager",
                "status": "active",
                "pos_location_name": None,
                "extra_pages": [],
            })
        self.assertIsNone(user["pos_location_name"])

    def test_missing_page_grant_fails_closed(self):
        with self.assertRaises(HTTPException) as raised:
            api_pg._ssr_user(self._request("warehouse", ["inventory"]), "request")
        self.assertEqual(raised.exception.status_code, 403)

    def test_personal_extra_page_grant_is_applied_to_session_gate(self):
        with patch.object(api_pg, "_effective_pages_for_role",
                          return_value=["overview"]):
            user = api_pg._user_dict({
                "user_id": "personally-granted-user",
                "email": "personally-granted@example.invalid",
                "name": "Personally Granted",
                "role": "marketing",
                "status": "active",
                "pos_location_name": None,
                "extra_pages": ["store-stock-requests"],
            })
        self.assertIn("store-stock-requests", user["allowed_pages"])
        self.assertEqual(
            api_pg._ssr_user(_Request(user), "read")[1], "marketing")

        raw_session_user = {
            "role": "marketing",
            "pos_location_name": None,
            "extra_pages": ["store-stock-requests"],
        }
        with patch.object(api_pg, "_effective_pages_for_role",
                          return_value=["overview"]):
            self.assertEqual(
                api_pg._ssr_user(_Request(raw_session_user), "read")[1],
                "marketing")

    def test_store_manager_requires_home_store_and_can_request(self):
        with self.assertRaises(HTTPException) as raised:
            api_pg._ssr_user(self._request("store_manager",
                                            ["store-stock-requests"], ""), "request")
        self.assertEqual(raised.exception.status_code, 403)
        _, role, home = api_pg._ssr_user(
            self._request("store_manager", ["store-stock-requests"]), "request")
        self.assertEqual((role, home), ("store_manager", "Vivo Test Store"))

    def test_role_action_gates(self):
        readonly = self._request("retail", ["store-stock-requests"])
        with self.assertRaises(HTTPException):
            api_pg._ssr_user(readonly, "request")
        with self.assertRaises(HTTPException):
            api_pg._ssr_user(self._request("store_manager", ["store-stock-requests"]),
                             "manage")
        self.assertEqual(api_pg._ssr_user(
            self._request("warehouse", ["store-stock-requests"]), "manage")[1],
            "warehouse")


class _StatusCursor:
    """Tiny cursor fake for the pure header-status aggregation contract."""
    def __init__(self, aggregate):
        self.aggregate = aggregate
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.aggregate


class StoreStockRequestCapacityAndStatusTests(unittest.TestCase):
    def test_capacity_nets_all_store_reservations_not_just_mine(self):
        # 8 warehouse units, 3 already promised to another store, 2 IBT units:
        # a new basket can only obtain 3.  This is the value mutation validates.
        self.assertEqual(api_pg._ssr_available_capacity(8, 3, 2), 3)
        self.assertEqual(api_pg._ssr_available_capacity(2, 3, 0), 0)

    def test_same_store_open_line_is_an_increment_against_shared_capacity(self):
        # The existing line's 2 is already in the all-store reservation total;
        # a repeat submission asks only for its added 3 units, leaving 2 free.
        available_before_increment = api_pg._ssr_available_capacity(10, 4, 1)
        self.assertGreaterEqual(available_before_increment, 3)
        self.assertEqual(available_before_increment - 3, 2)

    def test_fulfilled_capacity_uses_actual_units_during_snapshot_lag(self):
        expr = api_pg._ssr_capacity_units_sql("line")
        self.assertIn("status='FULFILLED'", expr)
        self.assertIn("actual_units", expr)
        self.assertNotIn("SUM(line.quantity)", expr)
        self.assertGreater(api_pg.STORE_STOCK_REQUEST_FULFILLED_HOLD_HOURS, 0)

    def test_header_status_recompute_is_not_single_line_last_write_wins(self):
        cursor = _StatusCursor({"n": 2, "open_n": 1, "picking_n": 0,
                                "fulfilled_n": 1, "cancelled_n": 0, "expired_n": 0})
        self.assertEqual(api_pg._ssr_recompute_header_status(cursor, 44), "OPEN")
        self.assertEqual(cursor.calls[-1][1], ("OPEN", 44))

        cursor = _StatusCursor({"n": 2, "open_n": 0, "picking_n": 0,
                                "fulfilled_n": 1, "cancelled_n": 1, "expired_n": 0})
        self.assertEqual(api_pg._ssr_recompute_header_status(cursor, 44), "MIXED")
        self.assertEqual(cursor.calls[-1][1], ("MIXED", 44))


if __name__ == "__main__":
    unittest.main()