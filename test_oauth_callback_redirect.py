"""Regression tests for the staff auth hardening (task: Authentication Issues).

Pins two security properties:

1. The Google OAuth *web* callback redirect must NOT carry the session token
   in the URL (fragment or query). The httpOnly ``session_token`` cookie set
   on the same response is the sole web credential, so the token is never
   readable by page JavaScript (XSS hardening). Only native app deep links
   (``scheme://…``) may carry the token, as a query param, because the
   receiving process cannot read our cookies.

2. The login IP throttle must derive the client address from the trusted
   proxy contract: the platform proxy APPENDS the real client to
   X-Forwarded-For, so only the RIGHTMOST entry may be used. Leftmost
   entries are attacker-supplied and must not let a single client rotate
   identities.
"""

import unittest

import api_pg


class _Req:
    def __init__(self, headers=None, client_host=None):
        self.headers = headers or {}
        self.client = type("C", (), {"host": client_host})() if client_host else None


class OAuthSuccessRedirectTests(unittest.TestCase):
    def test_web_redirect_has_no_token(self):
        url = api_pg._oauth_success_redirect("/auth/callback", False, "sekret-token")
        self.assertEqual(url, "/auth/callback")
        self.assertNotIn("token", url)
        self.assertNotIn("sekret", url)

    def test_web_relative_spa_path_has_no_token(self):
        url = api_pg._oauth_success_redirect("/crm/auth/callback", False, "sekret-token")
        self.assertEqual(url, "/crm/auth/callback")
        self.assertNotIn("sekret", url)

    def test_native_deep_link_carries_token_as_query(self):
        url = api_pg._oauth_success_redirect(
            "vivobi://auth/callback", True, "tok en")
        self.assertTrue(url.startswith("vivobi://auth/callback?token="))
        self.assertNotIn("#", url)
        # URL-encoded, not raw
        self.assertIn("token=tok%20en", url)


class LoginClientIpTests(unittest.TestCase):
    def test_uses_rightmost_forwarded_entry(self):
        req = _Req(headers={"x-forwarded-for": "6.6.6.6, 7.7.7.7, 10.0.0.9"})
        self.assertEqual(api_pg._login_client_ip(req), "10.0.0.9")

    def test_spoofed_leftmost_entry_is_ignored(self):
        real = api_pg._login_client_ip(
            _Req(headers={"x-forwarded-for": "spoof-a, 10.0.0.9"}))
        rotated = api_pg._login_client_ip(
            _Req(headers={"x-forwarded-for": "spoof-b, 10.0.0.9"}))
        self.assertEqual(real, rotated)  # rotating the spoofed part changes nothing

    def test_falls_back_to_socket_peer(self):
        self.assertEqual(api_pg._login_client_ip(_Req(client_host="1.2.3.4")), "1.2.3.4")
        self.assertEqual(api_pg._login_client_ip(_Req()), "unknown")


if __name__ == "__main__":
    unittest.main()
