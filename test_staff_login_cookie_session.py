"""End-to-end regression tests for cookie-only staff web sessions.

Pins the contract shared by all staff web SPAs (vivo-bi, vivo-crm, vivo-hr):

* ``POST /api/auth/login`` sets the httpOnly ``session_token`` cookie on the
  response, and that cookie ALONE (no Bearer header) authenticates
  ``GET /api/auth/me`` — exactly how the cookie-only frontends operate.
* Unauthenticated ``/auth/me`` is rejected.
* ``POST /api/auth/logout`` destroys the session (the cookie stops working).

Runs against the live dev backend/db with a throwaway seeded user, cleaned up
in tearDown.
"""

import unittest
import uuid

from fastapi.testclient import TestClient

import api_pg


class CookieOnlySessionTests(unittest.TestCase):
    EMAIL = None
    PASSWORD = "C0okie-only-test!"

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(api_pg.app)
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

    def test_cookie_only_login_me_logout(self):
        c = TestClient(api_pg.app, base_url="https://testserver")
        r = c.post("/api/auth/login",
                   json={"email": self.EMAIL, "password": self.PASSWORD})
        self.assertEqual(r.status_code, 200, r.text)
        # httpOnly session cookie is set on the login response.
        self.assertIn("session_token", r.cookies)
        set_cookie = r.headers.get("set-cookie", "")
        self.assertIn("HttpOnly", set_cookie)

        # The cookie alone authenticates /auth/me — no Authorization header.
        me = c.get("/api/auth/me")
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual((me.json() or {}).get("email"), self.EMAIL)

        # Logout destroys the server-side session.
        out = c.post("/api/auth/logout")
        self.assertLess(out.status_code, 300)
        me2 = c.get("/api/auth/me")
        self.assertGreaterEqual(me2.status_code, 401)

    def test_me_rejected_without_credentials(self):
        fresh = TestClient(api_pg.app)
        r = fresh.get("/api/auth/me")
        self.assertGreaterEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
