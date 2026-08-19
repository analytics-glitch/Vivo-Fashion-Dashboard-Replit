"""Focused safety checks for the Fabric/Main BI L10 ownership boundary."""

import asyncio
import json
import unittest
from unittest import mock

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.requests import Request

import api_pg


def _request(path, *, method="GET", query="", body=None):
    raw = json.dumps(body or {}).encode("utf-8") if body is not None else b""
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    headers = [(b"authorization", b"Bearer l10-test")]
    if body is not None:
        headers.append((b"content-type", b"application/json"))
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "query_string": query.encode("ascii"),
            "headers": headers,
            "scheme": "https",
            "server": ("testserver", 443),
            "client": ("127.0.0.1", 12345),
        },
        receive,
    )


def _run(coro):
    try:
        previous = asyncio.get_event_loop()
    except RuntimeError:
        previous = None
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(
            previous if previous is not None and not previous.is_closed()
            else asyncio.new_event_loop()
        )


class _Cursor:
    def __init__(self, folder_by_id):
        self.folder_by_id = folder_by_id
        self.resource_id = None

    def execute(self, _query, params):
        self.resource_id = int(params[0])

    def fetchone(self):
        folder_id = self.folder_by_id.get(self.resource_id)
        return (folder_id,) if folder_id is not None else None

    def close(self):
        pass


class _Connection:
    def __init__(self, folder_by_id):
        self.autocommit = False
        self.folder_by_id = folder_by_id

    def cursor(self):
        return _Cursor(self.folder_by_id)


class _Pool:
    def putconn(self, _conn):
        pass


class L10MiddlewareSurfaceTests(unittest.TestCase):
    def _gate(self, path, *, method="GET", query="", body=None,
              user=None, folder_by_id=None):
        request = _request(
            path, method=method, query=query, body=body)
        effective_user = user or {
            "role": "admin",
            "email": "admin@vivofashiongroup.com",
            "status": "active",
            "extra_pages": [],
        }
        called = []

        async def call_next(_request):
            called.append(True)
            return JSONResponse({"ok": True})

        folder_by_id = folder_by_id or {}
        with mock.patch.object(
                api_pg, "_user_for_session", return_value=effective_user), \
             mock.patch.object(
                 api_pg,
                 "_acquire_conn",
                 return_value=(_Pool(), _Connection(folder_by_id))):
            response = _run(api_pg.clerk_auth_gate(request, call_next))
        return response.status_code, bool(called)

    def test_folder_query_cannot_cross_surface(self):
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/meetings", query="folder_id=2"),
            (200, True),
        )
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/meetings", query="folder_id=1"),
            (403, False),
        )
        self.assertEqual(
            self._gate("/api/l10/meetings", query="folder_id=1"),
            (200, True),
        )
        self.assertEqual(
            self._gate("/api/l10/meetings", query="folder_id=2"),
            (403, False),
        )

    def test_forged_id_routes_cannot_cross_surface(self):
        ownership = {2002: 2, 1001: 1}
        self.assertEqual(
            self._gate(
                "/api/l10/meetings/2002", folder_by_id=ownership),
            (403, False),
        )
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/meetings/2002",
                folder_by_id=ownership),
            (200, True),
        )
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/scorecard/1001",
                method="PUT",
                body={"values": []},
                folder_by_id=ownership),
            (403, False),
        )

    def test_forged_create_body_cannot_cross_surface(self):
        self.assertEqual(
            self._gate(
                "/api/l10/meetings",
                method="POST",
                body={"folder_id": 2}),
            (403, False),
        )
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/meetings",
                method="POST",
                body={"folder_id": 2}),
            (200, True),
        )

    def test_supply_chain_grant_uses_fabric_surface_only(self):
        supply_user = {
            "role": "buyer",
            "email": "bedan@vivofashiongroup.com",
            "status": "active",
            "extra_pages": [],
        }
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/meetings",
                query="folder_id=2",
                user=supply_user),
            (200, True),
        )
        self.assertEqual(
            self._gate(
                "/api/l10/meetings",
                query="folder_id=1",
                user=supply_user),
            (403, False),
        )
        self.assertEqual(
            self._gate(
                "/api/fabric/l10/settings",
                method="PUT",
                body={"default_start_time": "07:30"},
                user=supply_user),
            (403, False),
        )


class L10SettingsIsolationTests(unittest.TestCase):
    def test_default_start_time_cuts_over_then_changes_independently(self):
        config = {
            "l10_settings": json.dumps({"default_start_time": "08:00"}),
        }

        def fake_exec(query, params=None, fetch=False):
            normalized = " ".join(query.split())
            if normalized.startswith("SELECT value FROM app_config WHERE key=%s"):
                value = config.get(params[0])
                return [{"value": value}] if value is not None else []
            if "WHERE key='l10_settings'" in normalized:
                value = config.get("l10_settings")
                return [{"value": value}] if value is not None else []
            if normalized.startswith("INSERT INTO app_config"):
                config[params[0]] = params[1]
                return None
            return [] if fetch else None

        main_get = _request("/api/l10/settings")
        fabric_get = _request("/api/fabric/l10/settings")
        main_put = _request(
            "/api/l10/settings",
            method="PUT",
            body={"default_start_time": "09:15"},
        )
        fabric_put = _request(
            "/api/fabric/l10/settings",
            method="PUT",
            body={"default_start_time": "07:30"},
        )
        with mock.patch.object(api_pg, "_ensure_l10_tables", lambda: None), \
             mock.patch.object(api_pg, "_users_exec", side_effect=fake_exec):
            self.assertEqual(
                api_pg.l10_get_settings(main_get)["default_start_time"],
                "08:00",
            )
            self.assertEqual(
                api_pg.l10_get_settings(fabric_get)["default_start_time"],
                "08:00",
            )
            _run(api_pg.l10_update_settings(main_put))
            self.assertEqual(
                api_pg.l10_get_settings(fabric_get)["default_start_time"],
                "08:00",
            )
            _run(api_pg.l10_update_settings(fabric_put))
            self.assertEqual(
                api_pg.l10_get_settings(main_get)["default_start_time"],
                "09:15",
            )
            self.assertEqual(
                api_pg.l10_get_settings(fabric_get)["default_start_time"],
                "07:30",
            )


class L10SnapshotAndRouteTests(unittest.TestCase):
    @staticmethod
    def _empty_snapshot(folder_id):
        tables = {table: [] for table in api_pg._L10_INSERT_ORDER}
        tables["l10_folders"] = [{"id": folder_id, "name": "Test"}]
        return tables

    def test_main_and_fabric_imports_reject_the_other_folder(self):
        with self.assertRaises(HTTPException) as main_error:
            api_pg._l10_validate_import_scope(
                self._empty_snapshot(2), fabric=False)
        self.assertEqual(main_error.exception.status_code, 403)

        with self.assertRaises(HTTPException) as fabric_error:
            api_pg._l10_validate_import_scope(
                self._empty_snapshot(1), fabric=True)
        self.assertEqual(fabric_error.exception.status_code, 403)

    def test_fabric_bootstrap_routes_are_registered(self):
        routes = {
            (route.path, method)
            for route in api_pg.app.routes
            for method in (getattr(route, "methods", None) or [])
        }
        for path in (
            "/api/fabric/l10/meetings",
            "/api/fabric/l10/members",
            "/api/fabric/l10/settings",
        ):
            self.assertIn((path, "GET"), routes)

    def test_snapshot_queries_are_scoped(self):
        self.assertIn(
            "folder_id = 2",
            api_pg._l10_snapshot_select("l10_meetings", fabric=True),
        )
        self.assertIn(
            "folder_id <> 2",
            api_pg._l10_snapshot_select("l10_meetings", fabric=False),
        )
        self.assertIn(
            "folder_id <> 2",
            api_pg._l10_snapshot_select(
                "l10_scorecard_values", fabric=False),
        )


if __name__ == "__main__":
    unittest.main()