"""Behavioral PostgreSQL coverage; requires disposable TEST_DATABASE_URL."""

import os
import threading
import unittest
import sys
from datetime import date
from unittest.mock import MagicMock, patch

import psycopg2

from customer_identity import ensure_schema, publish, reconciliation, diagnostics


URL = os.environ.get("TEST_DATABASE_URL")


def db():
    if not URL:
        raise RuntimeError("TEST_DATABASE_URL is required; DATABASE_URL is forbidden")
    return psycopg2.connect(URL)


class IdentityPG(unittest.TestCase):
    def setUp(self):
        self.conn = db()
        cur = self.conn.cursor()
        cur.execute(
            "DROP TABLE IF EXISTS "
            "customer_identity_override_audit,customer_identity_publish_source,"
            "customer_identity_publish_lock,customer_identity_publish,"
            "customer_identity_review,customer_identity_override,customer_people,"
            "customer_identity,customer_identity_registry,customer_person_registry,"
            "shopify_customer_missing_retry,shopify_customer_source_sync,"
            "shopify_customer_pending,"
            "raw_shopify_customers,all_sales,all_customers CASCADE"
        )
        cur.execute(
            "CREATE TABLE all_customers("
            "customer_id text,store_id text,first_name text,last_name text,"
            "email text,phone text,city text,country text,customer_type text,"
            "total_orders integer default 0,total_spend_kes numeric default 0,"
            "avg_order_value_kes numeric default 0,first_order_date text,"
            "last_order_date text,preferred_size text,last_synced timestamptz,"
            "UNIQUE(customer_id,store_id))"
        )
        cur.execute(
            "CREATE TABLE all_sales("
            "customer_id text,store_id text,order_id text,sale_date date,"
            "sale_kind text,total_sales_kes numeric)"
        )
        cur.execute(
            "CREATE TABLE raw_shopify_customers("
            "id text,store_id text,email text,first_name text,last_name text,"
            "phone text,default_address_phone text,state text,total_spent numeric,"
            "orders_count integer,accepts_sms_marketing boolean,"
            "accepts_email_marketing boolean,created_at text,updated_at text,"
            "_loaded_at timestamptz,PRIMARY KEY(id,store_id))"
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def customers(self, rows):
        cur = self.conn.cursor()
        cur.execute("DELETE FROM all_customers")
        cur.executemany("INSERT INTO all_customers VALUES(%s,%s,%s,%s,%s,%s)", rows)
        self.conn.commit()

    def identities(self):
        cur = self.conn.cursor()
        cur.execute(
            "SELECT source_key,person_id,match_method "
            "FROM customer_identity ORDER BY 1"
        )
        return cur.fetchall()

    def test_stable_collision_phone_pseudo_and_override(self):
        self.customers(
            [
                ("1", "vivo-uganda", "Ada", "", "a@x", "254700000001"),
                ("1", "vivo-rwanda", "Ada", "", "b@x", "254700000001"),
                ("9", "vivo-uganda", "Walk in", "", "", ""),
            ]
        )
        publish(self.conn)
        first = self.identities()
        self.assertEqual(first[0][1], first[1][1])
        self.assertEqual(first[2][2], "pseudo")

        # Reorder/contact edit/new source retains durable source identities.
        self.customers(
            [
                ("1", "vivo-rwanda", "Ada", "", "b@x", "254700000099"),
                ("1", "vivo-uganda", "Ada", "", "a@x", "254700000001"),
                ("2", "vivo-uganda", "Bea", "", "", ""),
            ]
        )
        publish(self.conn)
        second = {key: person for key, person, _ in self.identities()}
        self.assertEqual(second["shopify:vivo-rwanda:1"], first[1][1])
        self.assertIn("shopify:vivo-uganda:2", second)

        cur = self.conn.cursor()
        cur.execute("INSERT INTO customer_person_registry(person_id) VALUES(999)")
        cur.executemany(
            "INSERT INTO customer_identity_override("
            "source_system,source_customer_id,store_id,source_key,force_person_id"
            ") VALUES(%s,%s,%s,%s,%s)",
            [
                ("shopify", "2", "vivo-uganda", "shopify:vivo-uganda:2", 999),
                ("shopify", "2", "vivo-rwanda", "shopify:vivo-rwanda:2", 999),
            ],
        )
        self.conn.commit()
        publish(self.conn)
        publish(self.conn)
        cur.execute("SELECT count(*) FROM customer_identity_override_audit")
        self.assertEqual(cur.fetchone()[0], 1)

    def test_ambiguity_sales_and_failed_snapshot_preserve(self):
        self.customers(
            [
                ("1", "vivo-uganda", "Ada", "", "", "254711"),
                ("2", "vivo-uganda", "Bea", "", "", "254711"),
            ]
        )
        publish(self.conn)
        self.assertTrue(
            all(row[2] == "ambiguous_phone" for row in self.identities())
        )
        cur = self.conn.cursor()
        cur.execute(
            "UPDATE customer_identity_review SET status='resolved',"
            "resolved_by='test',resolved_at=now()"
        )
        self.conn.commit()
        publish(self.conn)
        cur.execute("SELECT DISTINCT status FROM customer_identity_review")
        self.assertEqual(cur.fetchall(), [("resolved",)])
        cur.execute(
            "INSERT INTO all_sales VALUES"
            "('1','vivo-uganda','o1','2024-01-01','sale',100)"
        )
        self.conn.commit()
        before = self.identities()
        with self.assertRaises(ValueError):
            publish(self.conn)
        self.assertEqual(self.identities(), before)
        cur.execute("SELECT last_error FROM customer_identity_publish")
        self.assertIn("readiness failed", cur.fetchone()[0])

    def test_source_qualified_sales_and_incremental_freshness(self):
        self.customers(
            [
                ("1", "vivo-uganda", "Ada", "", "", "254700"),
                ("1", "vivo-rwanda", "Bea", "", "", "250700"),
            ]
        )
        cur = self.conn.cursor()
        cur.executemany(
            "INSERT INTO all_sales VALUES(%s,%s,%s,%s,%s,%s)",
            [
                ("1", "vivo-uganda", "same-order", "2024-01-01", "sale", 10),
                ("1", "vivo-rwanda", "same-order", "2024-01-02", "sale", 20),
            ],
        )
        self.conn.commit()
        publish(self.conn)
        report = reconciliation(self.conn.cursor())
        self.assertEqual(report["totals"]["sales_spend"], 30.0)
        self.assertEqual(report["unmatched_sales_lines"], 0)
        snapshot = diagnostics(self.conn.cursor())
        self.assertTrue(snapshot["fresh"])
        self.assertEqual(snapshot["people_count"], 2)
        self.assertEqual(snapshot["reconciliation"]["unmatched_sales_lines"], 0)
        cur.execute(
            "SELECT person_id,total_orders,total_spend_kes,"
            "first_purchase,last_purchase "
            "FROM customer_people ORDER BY total_spend_kes"
        )
        people = cur.fetchall()
        self.assertEqual(
            [(int(row[2]), row[3], row[4]) for row in people],
            [(10, date(2024, 1, 1), date(2024, 1, 1)),
             (20, date(2024, 1, 2), date(2024, 1, 2))],
        )

        cur.execute(
            "INSERT INTO all_sales VALUES"
            "('1','vivo-rwanda','r2','2024-02-03','sale',5)"
        )
        self.conn.commit()
        publish(self.conn)
        cur.execute(
            "SELECT total_orders,total_spend_kes,last_purchase "
            "FROM customer_people WHERE person_id=%s",
            (people[1][0],),
        )
        updated = cur.fetchone()
        self.assertEqual(
            (updated[0], int(updated[1]), updated[2]),
            (2, 25, date(2024, 2, 3)),
        )

    def test_source_scoped_publish_ignores_unrelated_legacy_gap(self):
        self.customers(
            [("1", "vivo-rwanda", "Ada", "", "", "250700000001")]
        )
        cur = self.conn.cursor()
        cur.executemany(
            "INSERT INTO all_sales VALUES(%s,%s,%s,%s,%s,%s)",
            [
                ("1", "vivo-rwanda", "rw1", "2026-09-01", "order", 20),
                ("missing", "shop-zetu", "sz1", "2026-09-01", "order", 30),
            ],
        )
        self.conn.commit()
        report = publish(
            self.conn,
            required_sources={"shopify:vivo-rwanda"},
            ready_stores={"vivo-rwanda"},
        )
        self.assertEqual(report["unmatched_sales_lines"], 1)
        cur.execute(
            "SELECT status FROM customer_identity_publish WHERE singleton=true"
        )
        self.assertEqual(cur.fetchone()[0], "ready")
        with self.assertRaises(ValueError):
            publish(
                self.conn,
                required_sources={"shopify:vivo-rwanda"},
            )

    def test_unchanged_publish_rechecks_each_selected_store_scope(self):
        self.customers(
            [
                ("1", "vivo-rwanda", "Ada", "", "", "250700000001"),
                ("2", "vivo-uganda", "Bea", "", "", "256700000002"),
                ("3", "vivo-uganda", "Cara", "", "", "256700000002"),
            ]
        )
        cur = self.conn.cursor()
        cur.executemany(
            "INSERT INTO all_sales VALUES(%s,%s,%s,%s,%s,%s)",
            [
                ("1", "vivo-rwanda", "rw1", "2026-09-01", "order", 20),
                ("2", "vivo-uganda", "ug1", "2026-09-01", "order", 30),
            ],
        )
        self.conn.commit()
        publish(
            self.conn,
            required_sources={
                "shopify:vivo-rwanda",
                "shopify:vivo-uganda",
            },
            ready_stores={"vivo-rwanda"},
        )
        with self.assertRaises(ValueError):
            publish(
                self.conn,
                required_sources={
                    "shopify:vivo-rwanda",
                    "shopify:vivo-uganda",
                },
                ready_stores={"vivo-uganda"},
            )

    def test_source_scoped_publish_blocks_ambiguity_in_selected_store(self):
        self.customers(
            [
                ("1", "vivo-rwanda", "Ada", "", "", "250700000001"),
                ("2", "vivo-rwanda", "Bea", "", "", "250700000001"),
            ]
        )
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO all_sales VALUES"
            "('1','vivo-rwanda','rw1','2026-09-01','order',20)"
        )
        self.conn.commit()
        with self.assertRaises(ValueError):
            publish(
                self.conn,
                required_sources={"shopify:vivo-rwanda"},
                ready_stores={"vivo-rwanda"},
            )

    def test_retry_queue_does_not_exempt_global_unmatched_sales(self):
        self.customers(
            [("1", "vivo-rwanda", "Ada", "", "", "250700000001")]
        )
        cur = self.conn.cursor()
        cur.execute(
            "CREATE TABLE shopify_customer_missing_retry("
            "store_id text,customer_id text,PRIMARY KEY(store_id,customer_id))"
        )
        cur.execute(
            "INSERT INTO shopify_customer_missing_retry VALUES"
            "('vivo-rwanda','missing')"
        )
        cur.execute(
            "INSERT INTO all_sales VALUES"
            "('missing','vivo-rwanda','rw1','2026-09-01','order',20)"
        )
        self.conn.commit()
        with self.assertRaises(ValueError):
            publish(
                self.conn,
                required_sources={"shopify:vivo-rwanda"},
            )
        report = reconciliation(self.conn.cursor())
        self.assertEqual(
            report["totals"]["retry_queued_unmatched_sales_lines"], 1
        )
        self.assertEqual(report["blocking_unmatched_sales_lines"], 1)

    def test_fingerprint_detects_aggregate_preserving_reassignment(self):
        self.customers(
            [
                ("1", "vivo-rwanda", "Ada", "", "", "250700000001"),
                ("2", "vivo-rwanda", "Bea", "", "", "250700000002"),
            ]
        )
        cur = self.conn.cursor()
        cur.executemany(
            "INSERT INTO all_sales VALUES(%s,%s,%s,%s,%s,%s)",
            [
                ("1", "vivo-rwanda", "rw1", "2026-09-01", "order", 10),
                ("2", "vivo-rwanda", "rw2", "2026-09-01", "order", 20),
            ],
        )
        self.conn.commit()
        publish(
            self.conn,
            required_sources={"shopify:vivo-rwanda"},
        )
        cur.execute("""SELECT cp.total_spend_kes
          FROM customer_people cp JOIN customer_identity ci USING(person_id)
          WHERE ci.store_id='vivo-rwanda' AND ci.source_customer_id='1'""")
        self.assertEqual(int(cur.fetchone()[0]), 10)
        cur.execute("""UPDATE all_sales SET customer_id=CASE customer_id
          WHEN '1' THEN '2' WHEN '2' THEN '1' END""")
        self.conn.commit()
        publish(
            self.conn,
            required_sources={"shopify:vivo-rwanda"},
        )
        cur.execute("""SELECT cp.total_spend_kes
          FROM customer_people cp JOIN customer_identity ci USING(person_id)
          WHERE ci.store_id='vivo-rwanda' AND ci.source_customer_id='1'""")
        self.assertEqual(int(cur.fetchone()[0]), 20)

    def test_cross_store_person_is_one_churn_and_acquisition_identity(self):
        self.customers(
            [
                ("1", "vivo-uganda", "Ada", "", "", "254700"),
                ("77", "vivo-rwanda", "Ada", "", "", "254700"),
            ]
        )
        cur = self.conn.cursor()
        cur.executemany(
            "INSERT INTO all_sales VALUES(%s,%s,%s,%s,%s,%s)",
            [
                ("1", "vivo-uganda", "old-order", "2024-01-01", "sale", 10),
                ("77", "vivo-rwanda", "new-store-order", "2026-01-15", "sale", 20),
            ],
        )
        self.conn.commit()
        publish(self.conn)

        cur.execute(
            "SELECT COUNT(*),MIN(first_purchase),MAX(last_purchase) "
            "FROM customer_people WHERE is_pseudo IS NOT TRUE"
        )
        self.assertEqual(
            cur.fetchone(),
            (1, date(2024, 1, 1), date(2026, 1, 15)),
        )
        cur.execute(
            "SELECT COUNT(DISTINCT ci.person_id) "
            "FROM all_sales s JOIN customer_identity ci "
            "ON ci.source_customer_id=s.customer_id "
            "AND ci.store_id=s.store_id "
            "WHERE s.sale_date BETWEEN '2026-01-01' AND '2026-01-31' "
            "AND ci.person_id IN ("
            " SELECT person_id FROM customer_people "
            " WHERE first_purchase BETWEEN '2026-01-01' AND '2026-01-31')"
        )
        self.assertEqual(cur.fetchone()[0], 0)

    def test_regression_preserves_and_reader_only_sees_complete_snapshots(self):
        rows = [
            (str(i), "vivo-uganda", "Ada", "", "", f"25470{i:07d}")
            for i in range(5)
        ]
        self.customers(rows)
        publish(self.conn)
        observed = []
        done = threading.Event()

        def reader():
            conn = db()
            conn.autocommit = True
            try:
                while not done.is_set():
                    cur = conn.cursor()
                    cur.execute("SELECT count(*) FROM customer_identity")
                    observed.append(cur.fetchone()[0])
            finally:
                conn.close()

        thread = threading.Thread(target=reader)
        thread.start()
        self.customers(
            rows + [("6", "vivo-uganda", "New", "", "", "254799999999")]
        )
        publish(self.conn)
        done.set()
        thread.join()
        self.assertTrue(set(observed).issubset({5, 6}))

        self.customers(rows[:1])
        with self.assertRaises(ValueError):
            publish(self.conn)
        self.assertEqual(len(self.identities()), 6)
        cur = self.conn.cursor()
        cur.execute("SELECT published_at,last_error FROM customer_identity_publish")
        published_at, last_error = cur.fetchone()
        self.assertIsNotNone(published_at)
        self.assertIn("incomplete source snapshot", last_error)

    def test_first_partial_snapshot_cannot_replace_legacy_live_rows(self):
        cur = self.conn.cursor()
        ensure_schema(cur)
        cur.execute("INSERT INTO customer_person_registry(person_id) VALUES(77)")
        cur.execute(
            "INSERT INTO customer_identity("
            "person_id,source_key,source_system,source_customer_id,store_id,"
            "display_name,match_method"
            ") VALUES(77,'shopify:vivo-rwanda:legacy','shopify','legacy',"
            "'vivo-rwanda','Legacy Customer','phone')"
        )
        cur.execute(
            "INSERT INTO customer_people("
            "person_id,name,source_records,systems,is_pseudo,total_orders,"
            "total_spend_kes,customer_type"
            ") VALUES(77,'Legacy Customer',1,'shopify',false,0,0,'No purchase')"
        )
        self.conn.commit()
        self.customers(
            [("1", "vivo-uganda", "Ada", "", "", "254700000001")]
        )

        with self.assertRaises(ValueError):
            publish(
                self.conn,
                required_sources={
                    "shopify:vivo-uganda",
                    "shopify:vivo-rwanda",
                },
            )
        cur.execute("SELECT source_key FROM customer_identity")
        self.assertEqual(cur.fetchall(), [("shopify:vivo-rwanda:legacy",)])
        cur.execute("SELECT name FROM customer_people")
        self.assertEqual(cur.fetchall(), [("Legacy Customer",)])

    def test_legacy_odoo_override_is_migrated_and_applied(self):
        cur = self.conn.cursor()
        cur.execute(
            "CREATE TABLE customer_identity("
            "person_id bigint NOT NULL,source_system text NOT NULL,"
            "source_customer_id text NOT NULL,store_id text,display_name text,"
            "email_n text,phone9 text,name_n text,match_method text,"
            "built_at timestamp DEFAULT now(),"
            "PRIMARY KEY(source_system,source_customer_id))"
        )
        cur.execute(
            "INSERT INTO customer_identity("
            "person_id,source_system,source_customer_id,store_id,display_name"
            ") VALUES(999,'odoo','legacy','vivofashiongroup','Legacy Person')"
        )
        cur.execute(
            "CREATE TABLE customer_identity_override("
            "source_system text NOT NULL,source_customer_id text NOT NULL,"
            "force_person_id bigint NOT NULL,reason text,created_by text,"
            "created_at timestamp DEFAULT now(),"
            "PRIMARY KEY(source_system,source_customer_id))"
        )
        cur.execute(
            "INSERT INTO customer_identity_override("
            "source_system,source_customer_id,force_person_id,reason,created_by"
            ") VALUES('odoo','44',999,'confirmed legacy match','tester')"
        )
        self.conn.commit()
        self.customers(
            [("44", "vivofashiongroup", "Odoo", "Customer", "", "2547001")]
        )

        publish(self.conn, required_sources={"odoo:vivofashiongroup"})
        cur.execute(
            "SELECT person_id,match_method FROM customer_identity "
            "WHERE source_key='odoo:vivofashiongroup:44'"
        )
        self.assertEqual(cur.fetchone(), (999, "override"))
        cur.execute(
            "SELECT source_key,force_person_id FROM customer_identity_override"
        )
        self.assertEqual(
            cur.fetchone(),
            ("odoo:vivofashiongroup:44", 999),
        )
        cur.execute("SELECT count(*) FROM customer_identity_override_audit")
        self.assertEqual(cur.fetchone()[0], 1)

    def test_shopify_incremental_recovers_missing_sales_customer(self):
        self.customers(
            [("100", "vivo-uganda", "Existing", "", "", "256700000100")]
        )
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO all_sales VALUES"
            "('700','vivo-rwanda','rw-order','2026-09-05','order',120)"
        )
        self.conn.commit()

        def fake_sync(conn, selected=None, missing_by_store=None):
            self.assertIn("700", missing_by_store["vivo-rwanda"])
            c = conn.cursor()
            c.execute(
                "INSERT INTO raw_shopify_customers VALUES("
                "'700','vivo-rwanda','ada@example.test','Ada','K','+250788000111',"
                "NULL,'enabled',120,1,false,false,'2026-09-05','2026-09-05',now())"
            )
            c.execute(
                "INSERT INTO shopify_customer_pending VALUES"
                "('vivo-rwanda','700',now())"
            )
            conn.commit()
            return {"vivo-uganda": set(), "vivo-rwanda": {"700"}}

        with patch("extract_shopify_customers.sync", side_effect=fake_sync):
            from sync_incremental import sync_shopify_customers_incremental
            self.assertEqual(sync_shopify_customers_incremental(self.conn), 1)

        cur.execute(
            "SELECT email,phone,total_orders,customer_type "
            "FROM all_customers WHERE store_id='vivo-rwanda' AND customer_id='700'"
        )
        self.assertEqual(
            cur.fetchone(),
            ("ada@example.test", "250788000111", 1, "New"),
        )
        first_person = dict(
            (key, person) for key, person, _ in self.identities()
        )["shopify:vivo-rwanda:700"]

        # A partial profile update must not erase known contact fields, and the
        # registry must retain the established person ID.
        cur.execute(
            "UPDATE raw_shopify_customers SET email=NULL,phone=NULL,"
            "default_address_phone=NULL,orders_count=2 WHERE id='700'"
        )
        cur.execute(
            "INSERT INTO shopify_customer_pending VALUES"
            "('vivo-rwanda','700',now()) "
            "ON CONFLICT(store_id,customer_id) DO UPDATE SET queued_at=now()"
        )
        self.conn.commit()
        with patch(
            "extract_shopify_customers.sync",
            return_value={"vivo-uganda": set(), "vivo-rwanda": {"700"}},
        ):
            sync_shopify_customers_incremental(self.conn)
        cur.execute(
            "SELECT email,phone FROM all_customers "
            "WHERE store_id='vivo-rwanda' AND customer_id='700'"
        )
        self.assertEqual(cur.fetchone(), ("ada@example.test", "250788000111"))
        self.assertEqual(
            dict((key, person) for key, person, _ in self.identities())[
                "shopify:vivo-rwanda:700"
            ],
            first_person,
        )

    def test_pending_profile_survives_publication_failure(self):
        self.customers(
            [("100", "vivo-uganda", "Existing", "", "", "256700000100")]
        )
        cur = self.conn.cursor()
        cur.execute(
            "INSERT INTO raw_shopify_customers VALUES("
            "'701','vivo-rwanda',NULL,'Retry','Me','+250788000112',"
            "NULL,'enabled',10,1,false,false,'2026-09-05','2026-09-05',now())"
        )
        cur.execute(
            "CREATE TABLE shopify_customer_pending("
            "store_id text,customer_id text,queued_at timestamptz,"
            "PRIMARY KEY(store_id,customer_id))"
        )
        cur.execute(
            "INSERT INTO shopify_customer_pending VALUES"
            "('vivo-rwanda','701',now())"
        )
        self.conn.commit()
        with patch(
            "extract_shopify_customers.sync",
            return_value={"vivo-uganda": set(), "vivo-rwanda": set()},
        ), patch("customer_identity.publish", side_effect=ValueError("blocked")):
            from sync_incremental import sync_shopify_customers_incremental
            with self.assertRaises(ValueError):
                sync_shopify_customers_incremental(self.conn)
        cur.execute(
            "SELECT count(*) FROM shopify_customer_pending "
            "WHERE store_id='vivo-rwanda' AND customer_id='701'"
        )
        self.assertEqual(cur.fetchone()[0], 1)

    def test_concurrent_requeue_is_not_acknowledged_as_old_work(self):
        self.customers(
            [
                ("100", "vivo-uganda", "Existing", "", "", "256700000100"),
                ("701", "vivo-rwanda", "Retry", "", "", "250788000112"),
            ]
        )
        cur = self.conn.cursor()
        cur.execute(
            "CREATE TABLE shopify_customer_pending("
            "store_id text,customer_id text,queued_at timestamptz,"
            "PRIMARY KEY(store_id,customer_id))"
        )
        cur.execute(
            "INSERT INTO raw_shopify_customers VALUES("
            "'701','vivo-rwanda',NULL,'Retry','Me','+250788000112',"
            "NULL,'enabled',10,1,false,false,'2026-09-05','2026-09-05',now())"
        )
        cur.execute(
            "INSERT INTO shopify_customer_pending VALUES"
            "('vivo-rwanda','701',now()-interval '1 minute')"
        )
        self.conn.commit()
        from customer_identity import publish as real_publish

        def requeue_during_publish(conn, **kwargs):
            c = conn.cursor()
            c.execute(
                "UPDATE shopify_customer_pending SET queued_at=now() "
                "WHERE store_id='vivo-rwanda' AND customer_id='701'"
            )
            return real_publish(conn, **kwargs)

        with patch(
            "extract_shopify_customers.sync",
            return_value={"vivo-uganda": set(), "vivo-rwanda": set()},
        ), patch("customer_identity.publish", side_effect=requeue_during_publish):
            from sync_incremental import sync_shopify_customers_incremental
            sync_shopify_customers_incremental(self.conn)
        cur.execute(
            "SELECT count(*) FROM shopify_customer_pending "
            "WHERE store_id='vivo-rwanda' AND customer_id='701'"
        )
        self.assertEqual(cur.fetchone()[0], 1)

    def test_partial_shopify_failure_blocks_full_customer_pipeline(self):
        import extract_shopify_customers
        import sync_all

        fake_conn = MagicMock()
        partial = {
            "vivo-uganda": {"1"},
            "vivo-rwanda": RuntimeError("source failed"),
        }
        with patch.object(
            extract_shopify_customers, "DATABASE_URL", "postgres://test"
        ), patch.object(
            extract_shopify_customers.psycopg2,
            "connect",
            return_value=fake_conn,
        ), patch.object(
            extract_shopify_customers, "sync", return_value=partial
        ):
            with self.assertRaises(SystemExit) as exited:
                extract_shopify_customers.main()
        self.assertEqual(exited.exception.code, 1)

        calls = []
        def fake_run(script):
            calls.append(script)
            return script != "extract_shopify_customers.py"

        with patch.object(sys, "argv", ["sync_all.py"]), patch.object(
            sync_all, "run_script", side_effect=fake_run
        ):
            self.assertEqual(sync_all.main(), 1)
        self.assertNotIn("transform_all_customers.py", calls)
        self.assertNotIn("build_customer_identity.py", calls)

    def test_failed_required_shopify_source_marks_snapshot_not_fresh(self):
        self.customers(
            [
                ("1", "vivo-uganda", "Ada", "", "", "256700000001"),
                ("2", "vivo-rwanda", "Bea", "", "", "250700000002"),
            ]
        )
        publish(self.conn)
        cur = self.conn.cursor()
        cur.execute("""CREATE TABLE shopify_customer_source_sync(
          store_id text PRIMARY KEY,attempted_at timestamptz,
          succeeded_at timestamptz,source_updated_at timestamptz,
          rows_fetched integer,status text,error text)""")
        cur.executemany(
            "INSERT INTO shopify_customer_source_sync(store_id,status) "
            "VALUES(%s,%s)",
            [
                ("vivo-uganda", "ready"),
                ("vivo-rwanda", "failed"),
            ],
        )
        self.conn.commit()
        with patch.dict(
            os.environ,
            {"IDENTITY_EXPECTED_SOURCES": "shopify:vivo-rwanda"},
        ):
            self.assertFalse(diagnostics(self.conn.cursor())["fresh"])


if __name__ == "__main__":
    unittest.main()