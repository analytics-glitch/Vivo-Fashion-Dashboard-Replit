"""PII-in-logs regression tests (task: redact emails/phones from app logs).

Covers:
- api_pg._redact_email masks the local part and domain.
- community_app._throttle logs a hashed key, never the raw phone number.
- community_app._send_member_email logs only the exception class on SMTP
  failure, so a rejected recipient address never reaches the logs.
"""
import logging
import os
import smtplib
import unittest
from unittest import mock

os.environ.setdefault("DATABASE_URL", os.environ.get("DATABASE_URL", ""))


class TestRedactEmail(unittest.TestCase):
    def test_masks_email(self):
        import api_pg
        out = api_pg._redact_email("stephen@vivofashiongroup.com")
        self.assertNotIn("stephen@vivofashiongroup.com", out)
        self.assertNotIn("vivofashiongroup.com", out)
        self.assertEqual(out, "s***@vivo***")

    def test_handles_garbage(self):
        import api_pg
        self.assertEqual(api_pg._redact_email(""), "<redacted>")
        self.assertEqual(api_pg._redact_email(None), "<redacted>")
        self.assertEqual(api_pg._redact_email("no-at-sign"), "<redacted>")


class TestThrottleLogRedaction(unittest.TestCase):
    def test_phone_absent_from_throttle_log(self):
        import community_app
        phone = "+254712345678"
        req = mock.Mock()
        req.client.host = "1.2.3.4"
        req.headers = {}
        with mock.patch.object(community_app, "_rate_ok", return_value=False), \
                self.assertLogs(community_app.log, level="WARNING") as cm, \
                self.assertRaises(Exception):
            community_app._throttle(req, "req", [("phone", 1, 3600)],
                                    phone=phone)
        joined = "\n".join(cm.output)
        self.assertNotIn(phone, joined)
        self.assertIn("community throttle hit", joined)
        self.assertIn("key_hash=", joined)


class TestOauthProvisioningFailureLog(unittest.TestCase):
    def test_email_absent_from_provisioning_failure_log(self):
        """The provisioning-failure log must not include the raw email —
        neither via the formatted arg nor via exception text/traceback."""
        import api_pg
        from fastapi.testclient import TestClient

        addr = "staff.member@vivofashiongroup.com"

        class FakeResp:
            status_code = 200

            def __init__(self, payload):
                self._payload = payload

            def json(self):
                return self._payload

        tok = FakeResp({"access_token": "tok"})
        prof = FakeResp({"email": addr, "email_verified": True,
                         "sub": "123", "name": "Staff Member"})
        boom = RuntimeError(f"db insert failed for {addr}")

        with mock.patch.dict(os.environ, {"GOOGLE_CLIENT_ID": "cid",
                                          "GOOGLE_CLIENT_SECRET": "cs"}), \
                mock.patch.object(api_pg.requests, "post", return_value=tok), \
                mock.patch.object(api_pg.requests, "get", return_value=prof), \
                mock.patch.object(api_pg.clerk_auth, "email_allowed",
                                  return_value=True), \
                mock.patch.object(api_pg, "resolve_app_user",
                                  side_effect=boom), \
                self.assertLogs(level="ERROR") as cm:
            client = TestClient(api_pg.app)
            r = client.get(
                "/api/auth/google/callback?code=c&state=s",
                cookies={"g_oauth_state": "s"},
                follow_redirects=False)
        self.assertEqual(r.status_code, 307)
        self.assertIn("error=provisioning", r.headers.get("location", ""))
        joined = "\n".join(cm.output)
        self.assertIn("google oauth provisioning failed", joined)
        self.assertNotIn(addr, joined)
        self.assertIn("RuntimeError", joined)


class TestSmtpFailureLogRedaction(unittest.TestCase):
    def test_recipient_absent_from_failure_log(self):
        import community_app
        addr = "customer@example.com"
        exc = smtplib.SMTPRecipientsRefused({addr: (550, b"rejected")})
        with mock.patch.dict(os.environ,
                             {"LOYALTY_APP_SMTP_HOST": "smtp.test:587"}), \
                mock.patch.object(community_app.smtplib, "SMTP",
                                  side_effect=exc), \
                self.assertLogs(community_app.log, level="WARNING") as cm:
            community_app._send_member_email(addr, "Test subject", "body")
        joined = "\n".join(cm.output)
        self.assertNotIn(addr, joined)
        self.assertIn("SMTPRecipientsRefused", joined)


if __name__ == "__main__":
    unittest.main()
