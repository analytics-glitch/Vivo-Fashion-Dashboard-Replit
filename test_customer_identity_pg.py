"""Behavioral PostgreSQL coverage; requires disposable TEST_DATABASE_URL."""

import os
import threading
import unittest
from datetime import date

import psycopg2

from customer_identity import ensure_schema, publish, reconciliation


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
            "all_sales,all_customers CASCADE"
        )
        cur.execute(
            "CREATE TABLE all_customers("
            "customer_id text,store_id text,first_name text,last_name text,"
            "email text,phone text)"
        )
        cur.execute(
            "CREATE TABLE all_sales("
            "customer_id text,store_id text,order_id text,sale_date date,"
            "sale_kind text,total_sales_kes numeric)"
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


if __name__ == "__main__":
    unittest.main()