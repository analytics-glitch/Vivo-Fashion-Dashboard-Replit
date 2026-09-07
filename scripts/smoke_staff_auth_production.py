#!/usr/bin/env python3
"""Production-safe routed smoke for staff password + 2FA + cookie auth.

Requires STAFF_AUTH_SMOKE_ORIGIN (the published HTTPS origin). It creates a
short-lived, already-enrolled employee fixture directly in the configured
database, uses only routed public HTTP for the user journey, and deletes every
fixture row in a finally block. No password, TOTP seed, code, cookie, or response
body is printed or written to disk.
"""

import http.cookiejar
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PBKDF2_ITERS = 200_000
TOTP_STEP_SECONDS = 30


def _b64u(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, PBKDF2_ITERS)
    return "pbkdf2_sha256$%d$%s$%s" % (
        PBKDF2_ITERS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def _new_totp_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _encrypt_totp_secret(secret):
    session_secret = (os.environ.get("SESSION_SECRET") or "").encode()
    if not session_secret:
        raise RuntimeError("SESSION_SECRET is required")
    key = hashlib.sha256(
        b"vivo-staff-totp-aes-gcm-v1:" + session_secret).digest()
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(
        nonce, secret.encode("ascii"), b"vivo-staff-totp-v1")
    return "v1:" + _b64u(nonce + ciphertext)


def _totp_code(secret, counter):
    padded = secret + "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(padded, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def _request(opener, origin, method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        origin.rstrip("/") + path,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "X-Request-ID": "staff-auth-smoke-" + uuid.uuid4().hex[:16],
        },
    )
    try:
        with opener.open(request, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        # Keep sensitive response bodies out of logs.
        raise RuntimeError(f"{method} {path} returned HTTP {exc.code}") from None


def main():
    origin = (os.environ.get("STAFF_AUTH_SMOKE_ORIGIN") or "").strip()
    if not origin.startswith("https://"):
        raise RuntimeError("STAFF_AUTH_SMOKE_ORIGIN must be the published HTTPS origin")
    database_url = os.environ.get("VIVO_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("VIVO_DATABASE_URL or DATABASE_URL is required")

    marker = uuid.uuid4().hex
    user_id = f"auth-smoke:{marker}"
    email = f"auth-smoke-{marker}@vivofashiongroup.com"
    password = secrets.token_urlsafe(30)
    totp_secret = _new_totp_secret()
    code = None
    conn = psycopg2.connect(database_url)
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO app_users "
                    "(user_id,email,name,role,status,password_hash,totp_enabled,"
                    "totp_secret_enc,totp_enrolled_at) "
                    "VALUES (%s,%s,'Auth Release Smoke','employee','active',%s,"
                    "TRUE,%s,now())",
                    (
                        user_id,
                        email,
                        _hash_password(password),
                        _encrypt_totp_secret(totp_secret),
                    ),
                )

        status, login = _request(
            opener, origin, "POST", "/api/auth/login",
            {"email": email, "password": password},
        )
        if status != 200 or not login.get("two_factor_required"):
            raise RuntimeError("login did not create the required two-factor challenge")
        if any(cookie.name == "session_token" for cookie in jar):
            raise RuntimeError("login issued a session before two-factor verification")

        code = _totp_code(
            totp_secret, int(time.time()) // TOTP_STEP_SECONDS)
        status, verified = _request(
            opener, origin, "POST", "/api/auth/2fa/verify", {"code": code})
        if status != 200 or "token" in verified:
            raise RuntimeError("two-factor verification violated the browser session contract")
        if not any(cookie.name == "session_token" for cookie in jar):
            raise RuntimeError("two-factor verification did not issue a session cookie")

        status, me = _request(opener, origin, "GET", "/api/auth/me")
        if status != 200 or me.get("user_id") != user_id:
            raise RuntimeError("cookie session did not resolve through /api/auth/me")

        request = urllib.request.Request(origin.rstrip("/") + "/", method="GET")
        with opener.open(request, timeout=30) as response:
            if response.status != 200 or not response.read(4096):
                raise RuntimeError("dashboard entry did not load")
        print("staff auth production smoke: ok")
    finally:
        # FK cascades remove challenges and sessions; explicit deletes make the
        # retained-record contract obvious even if constraints drift.
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM user_2fa_challenges WHERE user_id=%s", (user_id,))
                    cur.execute("DELETE FROM user_sessions WHERE user_id=%s", (user_id,))
                    cur.execute("DELETE FROM app_users WHERE user_id=%s", (user_id,))
        finally:
            conn.close()
            jar.clear()
            password = totp_secret = code = None


if __name__ == "__main__":
    main()