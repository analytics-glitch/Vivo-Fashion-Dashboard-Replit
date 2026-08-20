"""Integration coverage for referral attribution and first-purchase rewards.

This module intentionally requires ``TEST_DATABASE_URL``.  Its registered
runner starts a fresh local PostgreSQL cluster and strips application database
variables before this test process starts, so it can never use development or
production customer data.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import os
import threading
import unittest
import uuid
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg2

import community_app as ca


TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")


@unittest.skipUnless(TEST_DB_URL, "TEST_DATABASE_URL not set")
class CommunityReferralPostgresTests(unittest.TestCase):
    """Run referral paths against real PostgreSQL uniqueness and row locks."""

    def setUp(self):
        self.schema = "community_referral_test_" + uuid.uuid4().hex
        bootstrap = psycopg2.connect(TEST_DB_URL)
        bootstrap.autocommit = True
        try:
            with bootstrap.cursor() as cur:
                cur.execute(f"CREATE SCHEMA {self.schema}")
        finally:
            bootstrap.close()

        self.admin = self._connect()
        self.admin.autocommit = True
        with self.admin.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE community_members (
                    id SERIAL PRIMARY KEY,
                    phone TEXT UNIQUE NOT NULL,
                    full_name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    dob DATE,
                    consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    customer_id TEXT,
                    customer_store_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    last_login_at TIMESTAMPTZ,
                    username TEXT,
                    consent_terms_version TEXT,
                    referral_code TEXT UNIQUE,
                    referred_by_member_id INT REFERENCES community_members(id)
                );
                CREATE UNIQUE INDEX community_members_username_uq
                    ON community_members (LOWER(username))
                    WHERE username IS NOT NULL;
                CREATE TABLE community_sessions (
                    token_hash TEXT PRIMARY KEY,
                    member_id INT,
                    phone TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL
                );
                CREATE TABLE community_points_events (
                    id SERIAL PRIMARY KEY,
                    member_id INT NOT NULL REFERENCES community_members(id),
                    kind TEXT NOT NULL,
                    points INT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    UNIQUE (member_id, kind)
                );
                CREATE TABLE community_referral_rewards (
                    referred_member_id INT PRIMARY KEY REFERENCES community_members(id),
                    referrer_member_id INT NOT NULL REFERENCES community_members(id),
                    awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CHECK (referred_member_id <> referrer_member_id)
                );
                CREATE TABLE all_customers (
                    customer_id TEXT NOT NULL,
                    store_id TEXT NOT NULL,
                    phone TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    total_orders INT NOT NULL DEFAULT 0,
                    total_spend_kes NUMERIC NOT NULL DEFAULT 0,
                    first_order_date DATE,
                    last_order_date DATE,
                    preferred_size TEXT,
                    city TEXT,
                    PRIMARY KEY (customer_id, store_id)
                );
                """
            )
        ca._me_cache.clear()

    def tearDown(self):
        try:
            self.admin.close()
        finally:
            bootstrap = psycopg2.connect(TEST_DB_URL)
            bootstrap.autocommit = True
            try:
                with bootstrap.cursor() as cur:
                    cur.execute(f"DROP SCHEMA IF EXISTS {self.schema} CASCADE")
            finally:
                bootstrap.close()

    def _connect(self):
        return psycopg2.connect(
            TEST_DB_URL,
            connect_timeout=5,
            options=f"-c search_path={self.schema},public",
        )

    def _insert_referral_pair(self, *, customer_orders=0):
        with self.admin.cursor() as cur:
            cur.execute(
                """INSERT INTO community_members (phone, full_name, email, referral_code)
                   VALUES ('254700000001', 'Referrer Member', 'referrer@example.test', 'REFERRER01')
                   RETURNING id"""
            )
            referrer_id = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO community_members
                       (phone, full_name, email, customer_id, customer_store_id, referred_by_member_id)
                   VALUES ('254700000002', 'Referred Member', 'friend@example.test',
                           'customer-friend', 'shopzetu', %s)
                   RETURNING id""",
                (referrer_id,),
            )
            referred_id = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO all_customers
                       (customer_id, store_id, phone, total_orders, total_spend_kes)
                   VALUES ('customer-friend', 'shopzetu', '254700000002', %s, 1200)""",
                (customer_orders,),
            )
        return referrer_id, referred_id

    @contextmanager
    def _patched_referral_reconciler(self):
        with mock.patch.object(ca, "A", None), \
                mock.patch.object(ca, "_ensure_tables", return_value=None), \
                mock.patch.object(ca, "_conn", side_effect=self._connect):
            yield

    def _reconcile(self):
        with self._patched_referral_reconciler():
            ca._reconcile_referral_rewards()

    def _reward_counts(self, referrer_id, referred_id):
        with self.admin.cursor() as cur:
            cur.execute(
                """SELECT COUNT(*) FROM community_referral_rewards
                   WHERE referred_member_id = %s AND referrer_member_id = %s""",
                (referred_id, referrer_id),
            )
            reward_count = cur.fetchone()[0]
            cur.execute(
                """SELECT COUNT(*), COALESCE(SUM(points), 0)
                   FROM community_points_events
                   WHERE member_id = %s AND kind = %s""",
                (referrer_id, f"referral:{referred_id}"),
            )
            event_count, point_sum = cur.fetchone()
        return reward_count, event_count, point_sum

    def test_first_synced_purchase_rewards_referrer_without_member_read(self):
        referrer_id, referred_id = self._insert_referral_pair(customer_orders=0)

        # The customer sync updates the canonical aggregate; neither member
        # opens /me before the independent reconciler runs.
        with self.admin.cursor() as cur:
            cur.execute(
                """UPDATE all_customers SET total_orders = 1
                   WHERE customer_id = 'customer-friend' AND store_id = 'shopzetu'"""
            )
        self._reconcile()

        self.assertEqual(
            self._reward_counts(referrer_id, referred_id),
            (1, 1, ca.REFERRAL_REWARD_POINTS),
        )

    def test_repeated_and_concurrent_reconciliation_awards_exactly_once(self):
        referrer_id, referred_id = self._insert_referral_pair(customer_orders=1)

        # Four isolated sessions race the same database uniqueness fence while
        # the reward is still absent.
        barrier = threading.Barrier(4)

        def reconcile_after_barrier():
            barrier.wait(timeout=10)
            self._reconcile()

        with self._patched_referral_reconciler():
            with ThreadPoolExecutor(max_workers=4) as workers:
                futures = [workers.submit(reconcile_after_barrier) for _ in range(4)]
                for future in futures:
                    future.result(timeout=20)

            # Normal subsequent reconciliations must also remain no-ops.
            ca._reconcile_referral_rewards()
            ca._reconcile_referral_rewards()

        self.assertEqual(
            self._reward_counts(referrer_id, referred_id),
            (1, 1, ca.REFERRAL_REWARD_POINTS),
        )

    def test_signup_does_not_attribute_existing_customer_to_referrer(self):
        referrer_id, _ = self._insert_referral_pair(customer_orders=0)
        with self.admin.cursor() as cur:
            cur.execute(
                """INSERT INTO all_customers
                       (customer_id, store_id, phone, total_orders, total_spend_kes)
                   VALUES ('customer-existing', 'shopzetu', '254711111111', 3, 3900)"""
            )
            signup_token = "historical-customer-signup-token"
            cur.execute(
                """INSERT INTO community_sessions (token_hash, phone, purpose, expires_at)
                   VALUES (%s, '254711111111', 'signup', now() + interval '10 minutes')""",
                (ca._hash_token(signup_token),),
            )

        app = FastAPI()
        with mock.patch.object(ca, "A", None), \
                mock.patch.object(ca, "_ensure_tables", return_value=None), \
                mock.patch.object(ca, "_conn", side_effect=self._connect), \
                mock.patch.object(ca, "_member_payload", return_value={}), \
                mock.patch.object(ca, "_referral_reconciler_started", True):
            ca.register_community_routes(app, None)
            with TestClient(app, raise_server_exceptions=True) as client:
                response = client.post(
                    "/api/community/auth/signup",
                    json={
                        "signup_token": signup_token,
                        "full_name": "Existing Customer",
                        "email": "existing@example.test",
                        "dob": "1990-01-01",
                        "consent": True,
                        "username": "existing.customer",
                        "referral_code": "REFERRER01",
                    },
                )

        self.assertEqual(response.status_code, 200)
        with self.admin.cursor() as cur:
            cur.execute(
                """SELECT referred_by_member_id
                   FROM community_members WHERE phone = '254711111111'"""
            )
            self.assertIsNone(cur.fetchone()[0])
            cur.execute(
                "SELECT COUNT(*) FROM community_referral_rewards WHERE referrer_member_id = %s",
                (referrer_id,),
            )
            self.assertEqual(cur.fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()