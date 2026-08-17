"""Unit tests for the proxy-aware SameSite cookie helpers in api_pg.

Covers ``_proxy_https``, ``_login_cookie_kwargs``, ``_two_factor_cookie_kwargs``,
and the ``g_oauth_state``/``g_oauth_return`` cookies set by the
``GET /api/auth/google/login`` endpoint — exercised via FastAPI's TestClient so
a regression in the inline cookie calls (wrong SameSite, missing cookie) fails
the test.

Run::

    python -m unittest validation_agent.test_login_cookie_kwargs
"""
import sys
import types
import unittest
from unittest import mock


# ---------------------------------------------------------------------------
# Lightweight stub so ``import api_pg`` doesn't hit the network or require
# DATABASE_URL to be set. We patch the heavy module-level side-effects that
# would fire on import (DB URL lookup, pool creation) with safe stubs, then
# import the module and extract only the thin helpers we need.
# ---------------------------------------------------------------------------

def _import_api_pg_helpers():
    """Import api_pg with DB / env / route setup safely stubbed out.

    Returns a reference to the api_pg module (already imported) so individual
    tests can monkey-patch ``api_pg._IS_PRODUCTION`` as needed.
    """
    # If the module was already imported (e.g. in a larger test run), re-use it.
    if "api_pg" in sys.modules:
        return sys.modules["api_pg"]

    # Provide a dummy DATABASE_URL so the module-level env lookup doesn't KeyError.
    env_patch = mock.patch.dict(
        "os.environ",
        {"DATABASE_URL": "postgresql://test:test@localhost/testdb"},
        clear=False,
    )
    env_patch.start()

    # Stub out the DB pool so nothing actually connects.
    pool_patch = mock.patch("psycopg2.pool.ThreadedConnectionPool", autospec=True)
    pool_patch.start()

    import api_pg as _m

    # Stop patches after import — the module is already loaded; the stubs
    # are only needed during the module-level initialisation.
    pool_patch.stop()
    env_patch.stop()

    return _m


# ---------------------------------------------------------------------------
# Fake request helpers
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    """Case-insensitive header dict (FastAPI behaviour approximation)."""
    def get(self, key, default=None):
        return super().get(key.lower(), default)


class _FakeRequest:
    """Minimal stand-in for a FastAPI ``Request``."""

    def __init__(self, forwarded_proto=None):
        headers = {}
        if forwarded_proto is not None:
            headers["x-forwarded-proto"] = forwarded_proto
        self.headers = _FakeHeaders(headers)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class TestProxyHttps(unittest.TestCase):
    """Low-level ``_proxy_https`` logic."""

    @classmethod
    def setUpClass(cls):
        cls.m = _import_api_pg_helpers()

    def _call(self, forwarded_proto=None, is_production=False):
        req = _FakeRequest(forwarded_proto=forwarded_proto)
        with mock.patch.object(self.m, "_IS_PRODUCTION", is_production):
            return self.m._proxy_https(req)

    def test_https_header_returns_true(self):
        self.assertTrue(self._call(forwarded_proto="https"))

    def test_https_header_uppercase_returns_true(self):
        self.assertTrue(self._call(forwarded_proto="HTTPS"))

    def test_http_header_returns_false(self):
        self.assertFalse(self._call(forwarded_proto="http"))

    def test_no_header_returns_false(self):
        self.assertFalse(self._call(forwarded_proto=None))

    def test_production_guard_suppresses_none(self):
        # Even with the right header, production must not emit SameSite=None.
        self.assertFalse(self._call(forwarded_proto="https", is_production=True))


class TestLoginCookieKwargs(unittest.TestCase):
    """``_login_cookie_kwargs`` SameSite matrix."""

    @classmethod
    def setUpClass(cls):
        cls.m = _import_api_pg_helpers()

    def _call(self, forwarded_proto=None, is_production=False):
        req = _FakeRequest(forwarded_proto=forwarded_proto)
        with mock.patch.object(self.m, "_IS_PRODUCTION", is_production):
            return self.m._login_cookie_kwargs(req)

    def test_https_proxy_gives_samesite_none(self):
        kw = self._call(forwarded_proto="https")
        self.assertEqual(kw["samesite"], "none")

    def test_plain_http_gives_samesite_lax(self):
        kw = self._call(forwarded_proto=None)
        self.assertEqual(kw["samesite"], "lax")

    def test_http_header_gives_samesite_lax(self):
        kw = self._call(forwarded_proto="http")
        self.assertEqual(kw["samesite"], "lax")

    def test_no_request_gives_samesite_lax(self):
        with mock.patch.object(self.m, "_IS_PRODUCTION", False):
            kw = self.m._login_cookie_kwargs(None)
        self.assertEqual(kw["samesite"], "lax")

    def test_production_with_https_header_gives_samesite_lax(self):
        kw = self._call(forwarded_proto="https", is_production=True)
        self.assertEqual(kw["samesite"], "lax")

    def test_httponly_always_set(self):
        for proto in (None, "https"):
            with self.subTest(proto=proto):
                kw = self._call(forwarded_proto=proto)
                self.assertTrue(kw.get("httponly"))

    def test_secure_always_set(self):
        for proto in (None, "https"):
            with self.subTest(proto=proto):
                kw = self._call(forwarded_proto=proto)
                self.assertTrue(kw.get("secure"))


class TestTwoFactorCookieKwargs(unittest.TestCase):
    """``_two_factor_cookie_kwargs`` SameSite matrix (same logic as login)."""

    @classmethod
    def setUpClass(cls):
        cls.m = _import_api_pg_helpers()

    def _call(self, forwarded_proto=None, is_production=False):
        req = _FakeRequest(forwarded_proto=forwarded_proto)
        with mock.patch.object(self.m, "_IS_PRODUCTION", is_production):
            return self.m._two_factor_cookie_kwargs(req)

    def test_https_proxy_gives_samesite_none(self):
        kw = self._call(forwarded_proto="https")
        self.assertEqual(kw["samesite"], "none")

    def test_plain_http_gives_samesite_lax(self):
        kw = self._call(forwarded_proto=None)
        self.assertEqual(kw["samesite"], "lax")

    def test_no_request_gives_samesite_lax(self):
        with mock.patch.object(self.m, "_IS_PRODUCTION", False):
            kw = self.m._two_factor_cookie_kwargs(None)
        self.assertEqual(kw["samesite"], "lax")

    def test_production_with_https_header_gives_samesite_lax(self):
        kw = self._call(forwarded_proto="https", is_production=True)
        self.assertEqual(kw["samesite"], "lax")

    def test_httponly_always_set(self):
        for proto in (None, "https"):
            with self.subTest(proto=proto):
                kw = self._call(forwarded_proto=proto)
                self.assertTrue(kw.get("httponly"))

    def test_secure_always_set(self):
        for proto in (None, "https"):
            with self.subTest(proto=proto):
                kw = self._call(forwarded_proto=proto)
                self.assertTrue(kw.get("secure"))

    def test_max_age_present(self):
        kw = self._call(forwarded_proto="https")
        self.assertIn("max_age", kw)
        self.assertGreater(kw["max_age"], 0)


class TestOAuthStateCookies(unittest.TestCase):
    """The inline ``g_oauth_state`` / ``g_oauth_return`` cookie logic.

    Those cookies are set directly in the OAuth-start endpoint using
    ``_proxy_https(request)`` to pick the samesite value.  We test
    ``_proxy_https`` outcomes (covered exhaustively above) and verify that the
    helper is accessible and consistent so any future refactor of the inline
    code can rely on the same tested primitive.
    """

    @classmethod
    def setUpClass(cls):
        cls.m = _import_api_pg_helpers()

    def test_oauth_state_samesite_value_via_proxy_https(self):
        """The samesite string set on g_oauth_state mirrors _proxy_https."""
        req_https = _FakeRequest(forwarded_proto="https")
        req_http = _FakeRequest(forwarded_proto=None)

        with mock.patch.object(self.m, "_IS_PRODUCTION", False):
            ss_https = "none" if self.m._proxy_https(req_https) else "lax"
            ss_http = "none" if self.m._proxy_https(req_http) else "lax"

        self.assertEqual(ss_https, "none")
        self.assertEqual(ss_http, "lax")

    def test_oauth_state_production_guard(self):
        """Production must always resolve to lax even with the header present."""
        req = _FakeRequest(forwarded_proto="https")
        with mock.patch.object(self.m, "_IS_PRODUCTION", True):
            ss = "none" if self.m._proxy_https(req) else "lax"
        self.assertEqual(ss, "lax")


class TestOAuthLoginEndpointCookies(unittest.TestCase):
    """Endpoint-level tests for ``GET /api/auth/google/login``.

    These tests invoke the real FastAPI endpoint via TestClient (no mocked
    response) and assert that ``Set-Cookie`` headers for ``g_oauth_state`` and
    ``g_oauth_return`` carry the correct ``SameSite`` attribute for each
    deployment scenario: HTTPS-preview proxy, plain HTTP, and production.

    A regression in the endpoint's inline ``set_cookie()`` calls — wrong
    SameSite value, missing cookie, or dropped flag — will fail here even
    if the unit tests for ``_proxy_https`` still pass.
    """

    @classmethod
    def setUpClass(cls):
        cls.m = _import_api_pg_helpers()
        # Import TestClient once; re-creating it per test is fine but slow.
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_one_set_cookie(raw):
        """Parse a single ``Set-Cookie`` value string into an attribute dict.

        Keys are lower-cased; boolean flags (``HttpOnly``, ``Secure``) become
        True; ``Max-Age`` is stored under the key ``max-age``.

        Returns ``None`` if ``raw`` is empty.
        """
        parts = [p.strip() for p in raw.split(";")]
        if not parts or not parts[0]:
            return None
        cookie_name, _, cookie_val = parts[0].partition("=")
        attrs = {"name": cookie_name.strip(),
                 "value": cookie_val.strip('"')}  # unquote simple values
        for part in parts[1:]:
            if not part:
                continue
            if "=" in part:
                k, _, v = part.partition("=")
                attrs[k.strip().lower()] = v.strip()
            else:
                attrs[part.strip().lower()] = True
        return attrs

    def _get_cookies(self, headers_list, name):
        """Return parsed attribute dicts for every Set-Cookie entry whose
        cookie name is ``name``.

        ``headers_list`` is a list of ``(header-name, header-value)`` tuples as
        returned by ``response.headers.items()``.  httpx's TestClient may fold
        multiple ``Set-Cookie`` values into one header separated by ``", "``, so
        we split on that boundary before parsing each individual cookie string.

        Returns a list of dicts::

            [{"name": "g_oauth_state", "value": "…", "samesite": "lax",
              "httponly": True, "secure": True, "path": "/", "max-age": "600"}]
        """
        results = []
        for hname, hval in headers_list:
            if hname.lower() != "set-cookie":
                continue
            # httpx folds multiple cookies into one header with ", " between them.
            # We split carefully: cookie boundaries are ", <name>=" (alphabetic).
            # A simple re-split is robust enough here since we control the shape.
            import re as _re
            segments = _re.split(r',\s*(?=[A-Za-z_][A-Za-z0-9_]*=)', hval)
            for seg in segments:
                parsed = self._parse_one_set_cookie(seg)
                if parsed and parsed["name"] == name:
                    results.append(parsed)
        return results

    def _login_response(self, extra_headers=None, query="", is_production=False):
        """Hit GET /api/auth/google/login with the given headers, return the
        raw response (redirects NOT followed so cookies are visible)."""
        with (
            mock.patch.dict("os.environ", {"GOOGLE_CLIENT_ID": "test-client-id"}),
            mock.patch.object(self.m, "_IS_PRODUCTION", is_production),
        ):
            client = self.TestClient(self.m.app, raise_server_exceptions=True)
            headers = extra_headers or {}
            return client.get(
                f"/api/auth/google/login{query}",
                headers=headers,
                follow_redirects=False,
            )

    # ------------------------------------------------------------------
    # g_oauth_state cookie
    # ------------------------------------------------------------------

    def test_state_cookie_present_on_redirect(self):
        resp = self._login_response()
        self.assertIn(resp.status_code, (302, 307, 308),
                      "Expected a redirect response")
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_state")
        self.assertTrue(cookies, "g_oauth_state cookie must be set on the response")

    def test_state_cookie_samesite_none_for_https_proxy(self):
        resp = self._login_response(
            extra_headers={"x-forwarded-proto": "https"}, is_production=False)
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_state")
        self.assertTrue(cookies, "g_oauth_state must be present")
        self.assertEqual(cookies[0].get("samesite", "").lower(), "none",
                         "HTTPS-proxy dev request must get SameSite=None")

    def test_state_cookie_samesite_lax_for_plain_http(self):
        resp = self._login_response(extra_headers={}, is_production=False)
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_state")
        self.assertTrue(cookies, "g_oauth_state must be present")
        self.assertEqual(cookies[0].get("samesite", "").lower(), "lax",
                         "Plain HTTP request must get SameSite=Lax")

    def test_state_cookie_samesite_lax_in_production_even_with_https_header(self):
        resp = self._login_response(
            extra_headers={"x-forwarded-proto": "https"}, is_production=True)
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_state")
        self.assertTrue(cookies, "g_oauth_state must be present in production")
        self.assertEqual(cookies[0].get("samesite", "").lower(), "lax",
                         "Production must always use SameSite=Lax")

    def test_state_cookie_httponly_and_secure(self):
        resp = self._login_response()
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_state")
        self.assertTrue(cookies, "g_oauth_state must be present")
        c = cookies[0]
        self.assertTrue(c.get("httponly"), "g_oauth_state must be HttpOnly")
        self.assertTrue(c.get("secure"), "g_oauth_state must be Secure")

    def test_state_cookie_has_short_max_age(self):
        resp = self._login_response()
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_state")
        self.assertTrue(cookies)
        max_age = int(cookies[0].get("max-age", 0))
        self.assertGreater(max_age, 0, "g_oauth_state must have a positive max-age")
        self.assertLessEqual(max_age, 600, "g_oauth_state max-age should be ≤ 600s")

    # ------------------------------------------------------------------
    # g_oauth_return cookie (only set when a valid ``return`` param is given)
    # ------------------------------------------------------------------

    def test_return_cookie_absent_without_return_param(self):
        resp = self._login_response()
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_return")
        self.assertFalse(cookies,
                         "g_oauth_return must NOT be set when no ?return= param is given")

    def test_return_cookie_set_for_valid_native_return(self):
        # A native deep-link return value that passes _safe_oauth_return.
        valid_return = "vivo-mobile://auth/callback"
        import urllib.parse
        query = "?return=" + urllib.parse.quote(valid_return, safe="")
        resp = self._login_response(query=query)
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_return")
        self.assertTrue(cookies,
                        "g_oauth_return must be set when a valid ?return= is supplied")

    def test_return_cookie_samesite_none_for_https_proxy(self):
        import urllib.parse
        valid_return = "vivo-mobile://auth/callback"
        query = "?return=" + urllib.parse.quote(valid_return, safe="")
        resp = self._login_response(
            extra_headers={"x-forwarded-proto": "https"},
            query=query,
            is_production=False,
        )
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_return")
        self.assertTrue(cookies, "g_oauth_return must be present")
        self.assertEqual(cookies[0].get("samesite", "").lower(), "none",
                         "g_oauth_return must use SameSite=None for HTTPS-proxy dev")

    def test_return_cookie_samesite_lax_for_plain_http(self):
        import urllib.parse
        valid_return = "vivo-mobile://auth/callback"
        query = "?return=" + urllib.parse.quote(valid_return, safe="")
        resp = self._login_response(query=query, is_production=False)
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_return")
        self.assertTrue(cookies, "g_oauth_return must be present")
        self.assertEqual(cookies[0].get("samesite", "").lower(), "lax",
                         "g_oauth_return must use SameSite=Lax for plain HTTP")

    def test_return_cookie_samesite_lax_in_production(self):
        import urllib.parse
        valid_return = "vivo-mobile://auth/callback"
        query = "?return=" + urllib.parse.quote(valid_return, safe="")
        resp = self._login_response(
            extra_headers={"x-forwarded-proto": "https"},
            query=query,
            is_production=True,
        )
        cookies = self._get_cookies(list(resp.headers.items()), "g_oauth_return")
        self.assertTrue(cookies, "g_oauth_return must be present in production")
        self.assertEqual(cookies[0].get("samesite", "").lower(), "lax",
                         "g_oauth_return must use SameSite=Lax in production")

    def test_no_client_id_returns_503(self):
        """Endpoint must return 503 (not crash) when GOOGLE_CLIENT_ID is unset."""
        with (
            mock.patch.dict("os.environ", {}, clear=False),
            mock.patch.object(self.m, "_IS_PRODUCTION", False),
        ):
            # Temporarily remove GOOGLE_CLIENT_ID if it happens to be set.
            env = dict(__import__("os").environ)
            env.pop("GOOGLE_CLIENT_ID", None)
            with mock.patch.dict("os.environ", env, clear=True):
                client = self.TestClient(self.m.app, raise_server_exceptions=True)
                resp = client.get("/api/auth/google/login", follow_redirects=False)
        self.assertEqual(resp.status_code, 503)


if __name__ == "__main__":
    unittest.main()
