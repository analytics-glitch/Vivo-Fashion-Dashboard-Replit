"""End-to-end regression tests for cookie-only staff web sessions.

Pins the contract shared by all staff web SPAs (vivo-bi, vivo-crm, vivo-hr):

Preview / dev (``_IS_PRODUCTION = False``, the default when REPLIT_DEPLOYMENT
is unset):
* ``POST /api/auth/login`` returns a session immediately — no 2FA challenge.
  The response sets the httpOnly ``session_token`` cookie directly.
* That cookie ALONE (no Bearer header) authenticates ``GET /api/auth/me``.
* ``POST /api/auth/logout`` destroys the session.

Production (``_IS_PRODUCTION = True``):
* ``POST /api/auth/login`` returns a short-lived ``staff_2fa_challenge``
  cookie and *no* ``session_token`` yet.
* The normal session is issued only after ``POST /api/auth/2fa/verify``
  succeeds with a valid TOTP code.
* The cookie-only session contract then holds the same way.

Runs against the live dev backend/db with a throwaway seeded user, cleaned up
in tearDown.
"""

import unittest
import uuid
import time
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import api_pg
import fabric_router


class CookieOnlySessionTests(unittest.TestCase):
    EMAIL = None
    PASSWORD = "C0okie-only-test!"

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(api_pg.app)
        api_pg._ensure_users_table()
        cls.EMAIL = f"cookie-test-{uuid.uuid4().hex[:10]}@example.com"
        cls.user_id = "test:" + uuid.uuid4().hex[:12]
        api_pg._users_exec(
            "INSERT INTO app_users (user_id, email, name, role, status, password_hash) "
            "VALUES (%s, %s, %s, 'analyst', 'active', %s)",
            (cls.user_id, cls.EMAIL, "Cookie Test", api_pg._hash_password(cls.PASSWORD)),
        )

    @classmethod
    def tearDownClass(cls):
        api_pg._users_exec(
            "DELETE FROM user_sessions WHERE user_id=%s", (cls.user_id,))
        api_pg._users_exec(
            "DELETE FROM app_users WHERE user_id=%s", (cls.user_id,))

    # ── Preview / dev mode ────────────────────────────────────────────────────

    def test_cookie_only_login_me_logout(self):
        """In preview, login returns session_token immediately (no 2FA step)."""
        # Ensure we are running in preview (non-production) mode.
        self.assertFalse(api_pg._IS_PRODUCTION,
                         "Expected _IS_PRODUCTION=False in the test environment; "
                         "make sure REPLIT_DEPLOYMENT is unset when running tests.")
        c = TestClient(api_pg.app, base_url="https://testserver")
        r = c.post("/api/auth/login",
                   json={"email": self.EMAIL, "password": self.PASSWORD})
        self.assertEqual(r.status_code, 200, r.text)
        # Preview bypass: session is issued immediately.
        self.assertIn("session_token", r.cookies)
        self.assertNotIn("staff_2fa_challenge", r.cookies)
        # The cookie must be httpOnly.
        set_cookie = r.headers.get("set-cookie", "")
        self.assertIn("HttpOnly", set_cookie)
        # Web responses carry the user but never expose the opaque session token
        # to JavaScript; the browser authenticates with the httpOnly cookie only.
        body = r.json()
        self.assertNotIn("token", body)
        self.assertIn("user", body)
        self.assertEqual(body["user"].get("email"), self.EMAIL)

        # The cookie alone authenticates /auth/me — no Authorization header.
        me = c.get("/api/auth/me")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual((me.json() or {}).get("email"), self.EMAIL)

        # Logout destroys the server-side session.
        out = c.post("/api/auth/logout")
        self.assertLess(out.status_code, 300)
        me2 = c.get("/api/auth/me")
        self.assertGreaterEqual(me2.status_code, 401)

    def test_native_preview_login_receives_explicit_session_token(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        r = c.post(
            "/api/auth/login",
            headers={"x-vivo-mobile": "1"},
            json={"email": self.EMAIL, "password": self.PASSWORD},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("token", r.json())

    def test_browser_origin_cannot_spoof_native_token_response(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        r = c.post(
            "/api/auth/login",
            headers={
                "x-vivo-mobile": "1",
                "origin": "https://testserver",
            },
            json={"email": self.EMAIL, "password": self.PASSWORD},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("token", r.json())
        self.assertIn("session_token", r.cookies)

    def test_invalid_credentials_keep_uniform_response(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        r = c.post(
            "/api/auth/login",
            json={"email": self.EMAIL, "password": "definitely-wrong"},
        )
        self.assertEqual(r.status_code, 401, r.text)
        self.assertEqual(r.json().get("detail"), "Invalid email or password")
        self.assertNotIn("session_token", r.cookies)

    def test_disabled_account_is_rejected_after_valid_password(self):
        api_pg._users_exec(
            "UPDATE app_users SET status='disabled' WHERE user_id=%s",
            (self.user_id,),
        )
        try:
            c = TestClient(api_pg.app, base_url="https://testserver")
            r = c.post(
                "/api/auth/login",
                json={"email": self.EMAIL, "password": self.PASSWORD},
            )
            self.assertEqual(r.status_code, 403, r.text)
            self.assertEqual(r.json().get("detail"), "account_disabled")
            self.assertNotIn("session_token", r.cookies)
        finally:
            api_pg._users_exec(
                "UPDATE app_users SET status='active' WHERE user_id=%s",
                (self.user_id,),
            )

    def test_locked_account_returns_throttle_response(self):
        api_pg._users_exec(
            "UPDATE app_users SET locked_until=now() + interval '5 minutes' "
            "WHERE user_id=%s",
            (self.user_id,),
        )
        try:
            c = TestClient(api_pg.app, base_url="https://testserver")
            r = c.post(
                "/api/auth/login",
                json={"email": self.EMAIL, "password": self.PASSWORD},
            )
            self.assertEqual(r.status_code, 429, r.text)
            self.assertNotIn("session_token", r.cookies)
        finally:
            api_pg._users_exec(
                "UPDATE app_users SET locked_until=NULL, failed_logins=0 "
                "WHERE user_id=%s",
                (self.user_id,),
            )

    def test_database_unavailability_returns_safe_503_and_stage_log(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        with (
            mock.patch.object(api_pg, "_ensure_auth_schema", return_value=True),
            mock.patch.object(
                api_pg, "_users_tx", side_effect=RuntimeError("sensitive-driver-detail")
            ),
            mock.patch.object(api_pg.log, "error") as error_log,
        ):
            r = c.post(
                "/api/auth/login",
                json={"email": self.EMAIL, "password": self.PASSWORD},
            )
        self.assertEqual(r.status_code, 503, r.text)
        self.assertIn("temporarily unavailable", r.json().get("detail", "").lower())
        rendered_log = repr(error_log.call_args)
        self.assertIn("account_lookup", rendered_log)
        self.assertIn("RuntimeError", rendered_log)
        self.assertNotIn(self.EMAIL, rendered_log)
        self.assertNotIn(self.PASSWORD, rendered_log)
        self.assertNotIn("sensitive-driver-detail", rendered_log)
        self.assertRegex(r.json().get("correlation_ref", ""), r"^[a-f0-9]{16}$")
        self.assertEqual(r.headers.get("x-request-id"), r.json()["correlation_ref"])

    def test_preview_session_creation_failure_returns_safe_503(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        with mock.patch.object(
            api_pg, "_create_session", side_effect=RuntimeError("session insert failed")
        ), mock.patch.object(api_pg.log, "error") as error_log:
            r = c.post(
                "/api/auth/login",
                json={"email": self.EMAIL, "password": self.PASSWORD},
            )
        self.assertEqual(r.status_code, 503, r.text)
        self.assertNotIn("session_token", r.cookies)
        self.assertIn("session_creation", repr(error_log.call_args))

    # ── Production mode (2FA required) ────────────────────────────────────────

    def test_production_mode_triggers_2fa(self):
        """With _IS_PRODUCTION forced True, login must return a 2FA challenge."""
        orig = api_pg._IS_PRODUCTION
        api_pg._IS_PRODUCTION = True
        try:
            c = TestClient(api_pg.app, base_url="https://testserver")
            r = c.post("/api/auth/login",
                       json={"email": self.EMAIL, "password": self.PASSWORD})
            self.assertEqual(r.status_code, 200, r.text)
            # Production: no session yet — only the 2FA challenge cookie.
            self.assertNotIn("session_token", r.cookies)
            self.assertIn("staff_2fa_challenge", r.cookies)
            body = r.json()
            self.assertTrue(body.get("two_factor_required"))
            self.assertIn("mode", body.get("two_factor", {}))

            # Complete the 2FA flow so the session is issued.
            setup = c.post("/api/auth/2fa/enroll")
            self.assertEqual(setup.status_code, 200, setup.text)
            self.assertEqual(len(setup.json().get("backup_codes") or []), 8)
            secret = setup.json()["manual_key"]
            counter = int(time.time()) // api_pg._TOTP_STEP_SECONDS
            code = api_pg._totp_code(secret, counter)
            verified = c.post("/api/auth/2fa/verify", json={"code": code})
            self.assertEqual(verified.status_code, 200, verified.text)
            self.assertIn("session_token", verified.cookies)
            self.assertNotIn("token", verified.json())

            # Cookie-only /auth/me works after 2FA.
            me = c.get("/api/auth/me")
            self.assertEqual(me.status_code, 200, me.text)
            self.assertEqual((me.json() or {}).get("email"), self.EMAIL)
        finally:
            api_pg._IS_PRODUCTION = orig

    def test_production_challenge_creation_failure_returns_safe_503(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        with (
            mock.patch.object(api_pg, "_IS_PRODUCTION", True),
            mock.patch.object(
                api_pg,
                "_create_2fa_challenge",
                side_effect=RuntimeError("challenge insert failed"),
            ),
            mock.patch.object(api_pg.log, "error") as error_log,
        ):
            r = c.post(
                "/api/auth/login",
                json={"email": self.EMAIL, "password": self.PASSWORD},
            )
        self.assertEqual(r.status_code, 503, r.text)
        self.assertNotIn("session_token", r.cookies)
        self.assertNotIn("staff_2fa_challenge", r.cookies)
        self.assertIn("challenge_creation", repr(error_log.call_args))

    # ── Unauthenticated rejection (both modes) ────────────────────────────────

    def test_me_rejected_without_credentials(self):
        fresh = TestClient(api_pg.app)
        r = fresh.get("/api/auth/me")
        self.assertGreaterEqual(r.status_code, 401)

    def test_cross_origin_preview_allows_credentialed_auth_requests(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        r = c.options(
            "/api/auth/login",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            r.headers.get("access-control-allow-origin"),
            "http://localhost:5173",
        )
        self.assertEqual(
            r.headers.get("access-control-allow-credentials"),
            "true",
        )

    def test_fabric_costing_gate_uses_cookie_identity_and_keeps_allowlist(self):
        """A stale browser Bearer cannot override the signed-in web identity."""
        class FakeConn:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def resolved_user(token):
            users = {
                "allowlisted-cookie": {
                    "user_id": "local:costing", "email": "costing@vivofashiongroup.com",
                    "name": "Costing", "role": "analyst", "status": "active",
                },
                "outsider-cookie": {
                    "user_id": "local:outsider", "email": "outsider@example.com",
                    "name": "Outsider", "role": "analyst", "status": "active",
                },
            }
            return users.get(token)

        patches = (
            mock.patch.object(api_pg, "_user_for_session", resolved_user),
            mock.patch.object(fabric_router, "_get_conn", FakeConn),
            mock.patch.object(fabric_router, "_ensure_costing_tables", lambda conn: None),
            mock.patch.object(fabric_router, "q", lambda *args, **kwargs: [{"n": 0}]),
        )
        with patches[0], patches[1], patches[2], patches[3]:
            allowed = TestClient(api_pg.app, base_url="https://testserver")
            allowed.cookies.set("session_token", "allowlisted-cookie")
            r = allowed.get("/api/fabric/costing/access")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["allowed"])
            self.assertEqual(r.json()["email"], "costing@vivofashiongroup.com")

            denied = TestClient(api_pg.app, base_url="https://testserver")
            denied.cookies.set("session_token", "outsider-cookie")
            r = denied.get("/api/fabric/costing/access")
            self.assertEqual(r.status_code, 403, r.text)

    def test_standalone_fabric_page_never_reads_or_sends_legacy_bearer(self):
        """Pin cookie-only auth across helpers, mutations, exports, and streams."""
        source = Path("fabric_dashboard_live.html").read_text(encoding="utf-8")
        self.assertNotIn("vivo_token", source)
        self.assertNotRegex(source, r"Authorization\s*['\"]?\s*[:=]")
        self.assertNotRegex(source, r"Bearer\s*[+'\"]")
        self.assertIn("credentials:'include'", source)

class AuthSchemaReadinessTests(unittest.TestCase):
    def setUp(self):
        self.original_ready = api_pg._AUTH_SCHEMA_READY
        self.original_readiness_cached = api_pg._AUTH_READINESS_CACHED
        self.original_readiness_cached_at = api_pg._AUTH_READINESS_CACHED_AT
        api_pg._AUTH_SCHEMA_READY = False
        api_pg._AUTH_READINESS_CACHED = None

    def tearDown(self):
        api_pg._AUTH_SCHEMA_READY = self.original_ready
        api_pg._AUTH_READINESS_CACHED = self.original_readiness_cached
        api_pg._AUTH_READINESS_CACHED_AT = self.original_readiness_cached_at

    def test_partial_schema_failure_is_retried_then_cached(self):
        with mock.patch.object(
            api_pg,
            "_ensure_users_table",
            side_effect=[RuntimeError("legacy schema incomplete"), None],
        ) as ensure:
            self.assertFalse(api_pg._ensure_auth_schema())
            self.assertTrue(api_pg._ensure_auth_schema())
            self.assertTrue(api_pg._ensure_auth_schema())
        self.assertEqual(ensure.call_count, 2)

    def test_auth_readiness_retries_after_transient_schema_failure(self):
        with mock.patch.object(
            api_pg, "_ensure_users_table",
            side_effect=[RuntimeError("temporary outage"), None],
        ):
            self.assertEqual(
                api_pg._auth_readiness_probe(),
                (False, "schema_preparation"),
            )
            # Failed probes are cached for only two seconds in production;
            # clearing it here represents the next post-TTL retry.
            api_pg._AUTH_READINESS_CACHED = None
            ok, detail = api_pg._auth_readiness_probe()
        self.assertTrue(ok)
        self.assertEqual(detail, "ok")

    def test_auth_transaction_falls_back_when_pool_is_exhausted(self):
        class ExhaustedPool:
            def getconn(self):
                raise api_pg._pg_pool.PoolError("full")

        fake_conn = mock.MagicMock()
        fake_conn.cursor.return_value = mock.MagicMock()
        with (
            mock.patch.object(api_pg, "_get_pool", return_value=ExhaustedPool()),
            mock.patch.object(
                api_pg, "_open_bounded_auth_connection",
                return_value=fake_conn,
            ),
            mock.patch.object(api_pg, "_close_bounded_auth_connection") as close,
        ):
            with api_pg._users_tx() as cur:
                cur.execute("SELECT 1")
        fake_conn.commit.assert_called_once()
        close.assert_called_once_with(fake_conn)

    def test_users_exec_uses_same_bounded_fallback(self):
        class ExhaustedPool:
            def getconn(self):
                raise api_pg._pg_pool.PoolError("full")

        fake_conn = mock.MagicMock()
        fake_conn.cursor.return_value.fetchall.return_value = [{"ok": 1}]
        with (
            mock.patch.object(api_pg, "_get_pool", return_value=ExhaustedPool()),
            mock.patch.object(
                api_pg, "_open_bounded_auth_connection",
                return_value=fake_conn,
            ),
            mock.patch.object(api_pg, "_close_bounded_auth_connection") as close,
        ):
            rows = api_pg._users_exec("SELECT 1", fetch=True)
        self.assertEqual(rows, [{"ok": 1}])
        close.assert_called_once_with(fake_conn)

    def test_auth_direct_connection_budget_fails_closed(self):
        held = [api_pg._AUTH_DIRECT_BUDGET.acquire() for _ in range(2)]
        try:
            with self.assertRaises(api_pg._pg_pool.PoolError):
                api_pg._open_bounded_auth_connection()
        finally:
            for acquired in held:
                if acquired:
                    api_pg._AUTH_DIRECT_BUDGET.release()

    def test_readyz_fails_closed_when_auth_path_is_broken(self):
        with mock.patch.object(
            api_pg, "_auth_readiness_probe",
            return_value=(False, "auth_path"),
        ):
            response = api_pg._readyz_sync()
        self.assertEqual(response.status_code, 503)
        self.assertIn(b'"staff_auth":"auth_path"', response.body)

    def test_production_smoke_has_cleanup_and_cookie_only_contract(self):
        source = Path("scripts/smoke_staff_auth_production.py").read_text(
            encoding="utf-8")
        self.assertIn('"/api/auth/login"', source)
        self.assertIn('"/api/auth/2fa/verify"', source)
        self.assertIn('"/api/auth/me"', source)
        self.assertIn("HTTPCookieProcessor", source)
        self.assertNotIn('"x-vivo-mobile"', source.lower())
        self.assertIn("finally:", source)
        self.assertIn("DELETE FROM user_2fa_challenges", source)
        self.assertIn("DELETE FROM user_sessions", source)
        self.assertIn("DELETE FROM app_users", source)


if __name__ == "__main__":
    unittest.main()
