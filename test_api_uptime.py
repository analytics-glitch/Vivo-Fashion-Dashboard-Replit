"""Regression tests for the public API liveness and readiness contracts.

The tests keep the health probe DB-free and exercise readiness with a small fake
connection so database failures and each sync-heartbeat state are deterministic.
"""

import json
import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

import api_pg


class _FakeCursor:
    def __init__(self, last_cycle):
        self.last_cycle = last_cycle
        self.result = None

    def execute(self, sql):
        if "SELECT 1 AS ok" in sql:
            self.result = {"ok": 1}
        elif "to_regclass" in sql:
            self.result = {"t": "public.sync_heartbeat"}
        elif "last_cycle_at" in sql:
            self.result = {"last_cycle_at": self.last_cycle}
        else:
            raise AssertionError(f"Unexpected readiness SQL: {sql}")

    def fetchone(self):
        return self.result

    def close(self):
        pass


class _FakeConnection:
    def __init__(self, last_cycle):
        self.last_cycle = last_cycle
        self.autocommit = False

    def cursor(self, cursor_factory=None):
        return _FakeCursor(self.last_cycle)


class _FakePool:
    def __init__(self, conn):
        self.conn = conn

    def putconn(self, conn, close=False):
        self.returned = (conn, close)


class ApiUptimeTests(unittest.TestCase):
    def test_healthz_is_public_and_reports_monotonic_uptime(self):
        client = TestClient(api_pg.app)

        first = client.get("/api/healthz")
        second = client.get("/api/healthz")

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        first_body = first.json()
        second_body = second.json()
        self.assertEqual(first_body["status"], "ok")
        started = datetime.fromisoformat(first_body["started_at"])
        self.assertIsNotNone(started.tzinfo)
        self.assertGreaterEqual(first_body["uptime_seconds"], 0)
        self.assertGreaterEqual(
            second_body["uptime_seconds"], first_body["uptime_seconds"]
        )

    def _readyz(self, minutes_since=None):
        last_cycle = (
            None
            if minutes_since is None
            else datetime.now(timezone.utc) - timedelta(minutes=minutes_since)
        )
        conn = _FakeConnection(last_cycle)
        pool = _FakePool(conn)
        with patch.object(api_pg, "_acquire_conn", return_value=(pool, conn)), \
             patch.object(api_pg, "_DATABASE_URL_DIRECT_IS_FALLBACK", True):
            response = asyncio.run(api_pg.readyz())
        return response.status_code, json.loads(response.body)

    def test_readyz_reports_starting_when_heartbeat_is_missing(self):
        status_code, body = self._readyz()

        self.assertEqual(status_code, 200)
        self.assertTrue(body["ready"])
        self.assertEqual(body["checks"]["api"], "ok")
        self.assertEqual(body["checks"]["db"], "ok")
        self.assertEqual(body["checks"]["sync"]["state"], "starting")

    def test_readyz_preserves_existing_heartbeat_states(self):
        expected = ((0, "ok"), (11, "warning"), (31, "critical"))
        for minutes, state in expected:
            with self.subTest(state=state):
                status_code, body = self._readyz(minutes)
                self.assertEqual(status_code, 200)
                self.assertEqual(body["checks"]["sync"]["state"], state)

    def test_readyz_returns_503_when_database_is_unavailable(self):
        with patch.object(
            api_pg, "_acquire_conn", side_effect=RuntimeError("database offline")
        ), patch.object(api_pg, "_DATABASE_URL_DIRECT_IS_FALLBACK", True):
            response = asyncio.run(api_pg.readyz())

        body = json.loads(response.body)
        self.assertEqual(response.status_code, 503)
        self.assertFalse(body["ready"])
        self.assertEqual(body["checks"]["api"], "ok")
        self.assertEqual(body["checks"]["db"], "down")
        self.assertEqual(body["detail"], "db_unreachable")


if __name__ == "__main__":
    unittest.main()