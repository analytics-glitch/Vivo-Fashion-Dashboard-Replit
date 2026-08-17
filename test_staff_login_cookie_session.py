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

from fastapi.testclient import TestClient

import api_pg


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
        # Response body should carry token + user (same shape as 2fa/verify).
        body = r.json()
        self.assertIn("token", body)
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

            # Cookie-only /auth/me works after 2FA.
            me = c.get("/api/auth/me")
            self.assertEqual(me.status_code, 200, me.text)
            self.assertEqual((me.json() or {}).get("email"), self.EMAIL)
        finally:
            api_pg._IS_PRODUCTION = orig

    # ── Unauthenticated rejection (both modes) ────────────────────────────────

    def test_me_rejected_without_credentials(self):
        fresh = TestClient(api_pg.app)
        r = fresh.get("/api/auth/me")
        self.assertGreaterEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
