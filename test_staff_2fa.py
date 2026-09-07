"""Focused live tests for staff RFC 6238 enrollment and recovery."""

import time
import unittest
import uuid
from unittest import mock

from fastapi.testclient import TestClient

import api_pg


class StaffTwoFactorTests(unittest.TestCase):
    def setUp(self):
        self.original_is_production = api_pg._IS_PRODUCTION
        api_pg._IS_PRODUCTION = True
        api_pg._ensure_users_table()
        self.client = TestClient(api_pg.app, base_url="https://testserver")
        self.user_id = "test-2fa:" + uuid.uuid4().hex[:14]
        self.email = f"2fa-{uuid.uuid4().hex[:10]}@example.com"
        self.password = "T0tp-test-password!"
        api_pg._users_exec(
            "INSERT INTO app_users "
            "(user_id,email,name,role,status,password_hash) "
            "VALUES (%s,%s,'2FA Test','analyst','active',%s)",
            (self.user_id, self.email, api_pg._hash_password(self.password)),
        )

    def tearDown(self):
        api_pg._users_exec("DELETE FROM user_2fa_challenges WHERE user_id=%s",
                           (self.user_id,))
        api_pg._users_exec("DELETE FROM user_sessions WHERE user_id=%s",
                           (self.user_id,))
        api_pg._users_exec("DELETE FROM app_users WHERE user_id=%s",
                           (self.user_id,))
        api_pg._IS_PRODUCTION = self.original_is_production

    def _enrol(self):
        login = self.client.post(
            "/api/auth/login", json={"email": self.email, "password": self.password})
        self.assertEqual(login.status_code, 200, login.text)
        self.assertEqual(login.json()["two_factor"]["mode"], "enroll")
        setup = self.client.post("/api/auth/2fa/enroll")
        self.assertEqual(setup.status_code, 200, setup.text)
        body = setup.json()
        self.assertEqual(len(body["backup_codes"]), 8)
        self.assertTrue(body["qr_svg"].startswith("<svg"))
        self.assertTrue(body["provisioning_uri"].startswith("otpauth://totp/"))
        self.assertIn("issuer=Vivo%20Fashion%20Group", body["provisioning_uri"])
        self.assertIn(f"secret={body['manual_key']}", body["provisioning_uri"])
        return body["manual_key"], body["backup_codes"]

    def test_accepts_one_step_forward_clock_drift(self):
        secret, _ = self._enrol()
        code = api_pg._totp_code(
            secret, int(time.time()) // api_pg._TOTP_STEP_SECONDS + 1)
        verified = self.client.post("/api/auth/2fa/verify", json={"code": code})
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertIn("session_token", verified.cookies)
        self.assertTrue(verified.json()["user"]["two_factor_enabled"])

    def test_backup_code_is_one_time(self):
        secret, backup_codes = self._enrol()
        verified = self.client.post(
            "/api/auth/2fa/verify",
            json={"code": api_pg._totp_code(
                secret, int(time.time()) // api_pg._TOTP_STEP_SECONDS)})
        self.assertEqual(verified.status_code, 200, verified.text)

        again = TestClient(api_pg.app, base_url="https://testserver")
        login = again.post(
            "/api/auth/login", json={"email": self.email, "password": self.password})
        self.assertEqual(login.json()["two_factor"]["mode"], "verify")
        used = again.post(
            "/api/auth/2fa/verify", json={"code": backup_codes[0]})
        self.assertEqual(used.status_code, 200, used.text)

        third = TestClient(api_pg.app, base_url="https://testserver")
        login = third.post(
            "/api/auth/login", json={"email": self.email, "password": self.password})
        self.assertEqual(login.json()["two_factor"]["mode"], "verify")
        reused = third.post(
            "/api/auth/2fa/verify", json={"code": backup_codes[0]})
        self.assertEqual(reused.status_code, 401, reused.text)

    def test_native_verification_receives_explicit_session_token(self):
        secret, _ = self._enrol()
        verified = self.client.post(
            "/api/auth/2fa/verify",
            headers={"x-vivo-mobile": "1"},
            json={"code": api_pg._totp_code(
                secret, int(time.time()) // api_pg._TOTP_STEP_SECONDS)},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertIn("token", verified.json())
        self.assertIn("session_token", verified.cookies)

    def test_browser_origin_cannot_spoof_native_verification_token(self):
        secret, _ = self._enrol()
        verified = self.client.post(
            "/api/auth/2fa/verify",
            headers={
                "x-vivo-mobile": "1",
                "origin": "https://testserver",
            },
            json={"code": api_pg._totp_code(
                secret, int(time.time()) // api_pg._TOTP_STEP_SECONDS)},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertNotIn("token", verified.json())
        self.assertIn("session_token", verified.cookies)

    def test_verification_rate_limit(self):
        self._enrol()
        responses = [
            self.client.post("/api/auth/2fa/verify", json={"code": "000000"})
            for _ in range(5)
        ]
        self.assertTrue(all(r.status_code == 401 for r in responses[:4]))
        self.assertEqual(responses[-1].status_code, 429, responses[-1].text)

    def test_session_creation_failure_returns_safe_503(self):
        secret, _ = self._enrol()
        code = api_pg._totp_code(
            secret, int(time.time()) // api_pg._TOTP_STEP_SECONDS)
        conflicting_token = api_pg._create_session(self.user_id)
        with mock.patch.object(
            api_pg.secrets, "token_urlsafe", return_value=conflicting_token
        ), mock.patch.object(api_pg.log, "error") as error_log:
            verified = self.client.post(
                "/api/auth/2fa/verify", json={"code": code})
        self.assertEqual(verified.status_code, 503, verified.text)
        self.assertNotIn("session_token", verified.cookies)
        self.assertIn("two_factor_verification", repr(error_log.call_args))
        # The failed session insert must roll back enrollment and challenge
        # consumption, allowing the same valid challenge to be retried.
        state = api_pg._users_exec(
            "SELECT totp_enabled FROM app_users WHERE user_id=%s",
            (self.user_id,), fetch=True)[0]
        self.assertFalse(state["totp_enabled"])
        challenge_count = api_pg._users_exec(
            "SELECT COUNT(*) AS n FROM user_2fa_challenges WHERE user_id=%s",
            (self.user_id,), fetch=True)[0]["n"]
        self.assertEqual(challenge_count, 1)
        retried = self.client.post("/api/auth/2fa/verify", json={"code": code})
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertIn("session_token", retried.cookies)
        self.assertNotIn("token", retried.json())

    def test_admin_reset_keeps_existing_session(self):
        api_pg._users_exec(
            "UPDATE app_users SET totp_enabled=TRUE, totp_secret_enc=%s "
            "WHERE user_id=%s",
            (api_pg._encrypt_totp_secret(api_pg._new_totp_secret()), self.user_id),
        )
        admin_id = "test-2fa-admin:" + uuid.uuid4().hex[:14]
        api_pg._users_exec(
            "INSERT INTO app_users "
            "(user_id,email,name,role,status,password_hash) "
            "VALUES (%s,%s,'2FA Admin','admin','active',%s)",
            (admin_id, f"admin-{uuid.uuid4().hex[:10]}@example.com",
             api_pg._hash_password(self.password)),
        )
        session = api_pg._create_session(self.user_id)
        admin_session = api_pg._create_session(admin_id)
        self.client.cookies.set("session_token", admin_session)
        reset = self.client.post(f"/api/admin/users/{self.user_id}/2fa-reset")
        self.assertEqual(reset.status_code, 200, reset.text)
        row = api_pg._users_exec(
            "SELECT totp_enabled FROM app_users WHERE user_id=%s",
            (self.user_id,), fetch=True)[0]
        self.assertFalse(row["totp_enabled"])
        sessions = api_pg._users_exec(
            "SELECT COUNT(*) AS n FROM user_sessions WHERE session_token=%s",
            (session,), fetch=True)[0]["n"]
        self.assertEqual(sessions, 1)
        api_pg._users_exec("DELETE FROM user_sessions WHERE user_id=%s",
                           (admin_id,))
        api_pg._users_exec("DELETE FROM app_users WHERE user_id=%s", (admin_id,))


if __name__ == "__main__":
    unittest.main()