"""Role-matrix authorization tests for GET /api/central-tracker.

The endpoint is gated in clerk_auth_gate to:
  ALLOWED: product_development, leadership, smt, admin
  DENIED:  all other authenticated roles

Tests verify:
  1. Every denied role receives HTTP 403 with the expected detail string.
  2. Every allowed role is NOT refused by the auth gate (reaches the endpoint
     handler — mocked to return a cached response so no DB is required).

Run with::

    python -m unittest test_central_tracker_auth
"""
import unittest
from unittest import mock

from starlette.testclient import TestClient

import api_pg

# ── Helpers ───────────────────────────────────────────────────────────────────

def _fake_user(role):
    """Minimal user dict that the auth gate considers 'active'."""
    return {
        "id": 1,
        "user_id": 1,
        "email": f"{role}@test.example",
        "name": "Test User",
        "role": role,
        "status": "active",
        "extra_pages": [],
        "allowed_pages": None,
        "hidden_pages": [],
        "pos_location_name": None,
    }


# A valid-looking Bearer token — the actual value doesn't matter because we
# patch _user_for_session to bypass the DB lookup entirely.
_TOKEN = "testtoken-does-not-hit-db"
_AUTH_HEADER = {"Authorization": f"Bearer {_TOKEN}"}

# Pre-built response payload used to short-circuit the DB query for allowed
# roles by seeding the in-process cache.
_FAKE_PAYLOAD = {
    "rows": [
        {
            "style_number": "TST001",
            "style_name":   "Test Style",
            "order_qty":    100,
            "order_date":   "2026-01-15",
            "source_year":  "2026",
        }
    ],
    "total": 1,
    "loaded_at": "2026-08-11T12:00:00+00:00",
}

# ── Test cases ────────────────────────────────────────────────────────────────

DENIED_ROLES = [
    "retail",
    "warehouse",
    "store_manager",
    "production",
    "fabric_warehouse",
    "fabric_quality_supervisor",
    "quality",
    "customer_service",
    "marketing",
    "hr",
    "employee",
]

ALLOWED_ROLES = [
    "product_development",
    "leadership",
    "smt",
    "admin",
]


class TestCentralTrackerAuthGate(unittest.TestCase):
    """HTTP-level role matrix: auth gate in clerk_auth_gate middleware."""

    def setUp(self):
        # Clear the in-process cache before each test so cache hits from one
        # test don't influence another.
        with api_pg._CACHE_LOCK:
            api_pg._cache.clear()

    # ── Denied roles must receive 403 ─────────────────────────────────────────

    def _assert_forbidden(self, role):
        with mock.patch.object(api_pg, "_user_for_session", return_value=_fake_user(role)):
            client = TestClient(api_pg.app, raise_server_exceptions=False)
            resp = client.get("/api/central-tracker", headers=_AUTH_HEADER)
        self.assertEqual(
            resp.status_code, 403,
            f"Expected 403 for role '{role}', got {resp.status_code}: {resp.text}",
        )
        # Employee hits the employee fence before the central-tracker gate, so
        # its detail differs. All other roles must carry the central-tracker msg.
        if role != "employee":
            detail = resp.json().get("detail", "")
            self.assertIn(
                "Order Tracker access", detail,
                f"Unexpected 403 detail for role '{role}': {detail!r}",
            )

    def test_retail_forbidden(self):        self._assert_forbidden("retail")
    def test_warehouse_forbidden(self):     self._assert_forbidden("warehouse")
    def test_store_manager_forbidden(self): self._assert_forbidden("store_manager")
    def test_production_forbidden(self):    self._assert_forbidden("production")
    def test_fabric_warehouse_forbidden(self): self._assert_forbidden("fabric_warehouse")
    def test_quality_forbidden(self):       self._assert_forbidden("quality")
    def test_customer_service_forbidden(self): self._assert_forbidden("customer_service")
    def test_marketing_forbidden(self):     self._assert_forbidden("marketing")
    def test_hr_forbidden(self):            self._assert_forbidden("hr")
    def test_employee_forbidden(self):      self._assert_forbidden("employee")

    # ── Allowed roles must NOT receive 403 from the auth gate ─────────────────

    def _assert_not_forbidden(self, role):
        # Seed the cache so the endpoint returns without touching the DB.
        cache_key = "central_tracker:all"
        with api_pg._CACHE_LOCK:
            api_pg._cache[cache_key] = (_FAKE_PAYLOAD, __import__("time").time(), 1800)

        with mock.patch.object(api_pg, "_user_for_session", return_value=_fake_user(role)):
            client = TestClient(api_pg.app, raise_server_exceptions=False)
            resp = client.get("/api/central-tracker", headers=_AUTH_HEADER)

        self.assertNotEqual(
            resp.status_code, 403,
            f"Role '{role}' should not be refused by the auth gate (got 403: {resp.text})",
        )
        # A 200 with the cached payload is the expected happy-path result.
        self.assertEqual(
            resp.status_code, 200,
            f"Expected 200 for allowed role '{role}', got {resp.status_code}: {resp.text}",
        )
        data = resp.json()
        self.assertIn("rows",      data, f"Response missing 'rows' for role '{role}'")
        self.assertIn("total",     data, f"Response missing 'total' for role '{role}'")
        self.assertIn("loaded_at", data, f"Response missing 'loaded_at' for role '{role}'")

    def test_product_development_allowed(self): self._assert_not_forbidden("product_development")
    def test_leadership_allowed(self):           self._assert_not_forbidden("leadership")
    def test_smt_allowed(self):                  self._assert_not_forbidden("smt")
    def test_admin_allowed(self):                self._assert_not_forbidden("admin")

    # ── Unauthenticated request must receive 401 ──────────────────────────────

    def test_unauthenticated_gets_401(self):
        client = TestClient(api_pg.app, raise_server_exceptions=False)
        resp = client.get("/api/central-tracker")   # no auth header
        self.assertEqual(
            resp.status_code, 401,
            f"Expected 401 for unauthenticated request, got {resp.status_code}",
        )


if __name__ == "__main__":
    unittest.main()
