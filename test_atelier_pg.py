"""Disposable-PostgreSQL integration coverage for Atelier (Task 1617).

This suite only connects to TEST_DATABASE_URL, which is supplied by
run_atelier_pg_test.py.  It deliberately builds the small shared-master schema
that Atelier needs instead of importing the application's production schema.
"""
import os
import threading
import unittest
from contextlib import contextmanager
from datetime import datetime

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import atelier
from import_atelier_history import ImportJob, ParseResult, commit_jobs


TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")


class _Database:
    """The narrow api_pg database/masking surface used by atelier routes."""
    def __init__(self, url):
        self.url = url

    def _users_exec(self, sql, params=None, fetch=True):
        with psycopg2.connect(self.url) as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                return cur.fetchall() if fetch and cur.description else []

    @contextmanager
    def _users_tx(self):
        conn = psycopg2.connect(self.url)
        try:
            with conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    yield cur
        finally:
            conn.close()

    @staticmethod
    def mask_pii_rows(rows, request, phone_keys=("phone",), email_keys=("email",)):
        # Route behavior is being exercised, not the platform reveal-token
        # implementation.  Returning copies avoids a fake mutation contract.
        return [dict(row) for row in rows]


@unittest.skipUnless(TEST_DB_URL, "TEST_DATABASE_URL not set")
class AtelierPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = _Database(TEST_DB_URL)
        cls.admin = psycopg2.connect(TEST_DB_URL)
        cls.admin.autocommit = True
        with cls.admin.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
            cur.execute("""CREATE TABLE app_users (
                user_id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT,
                status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
            cur.execute("""CREATE TABLE all_customers (
                customer_id TEXT NOT NULL, store_id TEXT NOT NULL,
                first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
                city TEXT, country TEXT, customer_type TEXT, total_orders INTEGER,
                total_spend_kes NUMERIC, avg_order_value_kes NUMERIC,
                last_synced TIMESTAMPTZ, PRIMARY KEY(customer_id,store_id))""")
            cur.execute("""CREATE TABLE all_products_clean (
                sku TEXT, product_name TEXT, size TEXT, color_print TEXT, barcode TEXT,
                style_number TEXT, style_name TEXT, product_type TEXT, category TEXT)""")
            cur.execute("""CREATE TABLE user_sessions (
                id BIGSERIAL PRIMARY KEY, user_id TEXT REFERENCES app_users(user_id),
                token TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
            cur.execute("""INSERT INTO app_users(user_id,name,email,role,status) VALUES
                ('admin','Admin','admin@example.test','admin','active'),
                ('staff','Enabled Staff','staff@example.test','operations','active'),
                ('plain','Plain Staff','plain@example.test','operations','active'),
                ('tailor','Tailor','tailor@example.test','operations','active')""")
        atelier.A = cls.db
        atelier.ensure_atelier_tables()
        with cls.admin.cursor() as cur:
            cur.execute("INSERT INTO atelier_staff(user_id,active) VALUES ('staff',TRUE),('tailor',TRUE)")
            # The importer owns this additive ledger in production; creating its
            # minimal form here lets every independently ordered test clean up.
            cur.execute("""CREATE TABLE atelier_history_imports (
                source_identity TEXT PRIMARY KEY, source_system TEXT NOT NULL,
                source_row INTEGER NOT NULL, source_item INTEGER NOT NULL,
                source_sha256 TEXT NOT NULL, job_id BIGINT NOT NULL UNIQUE
                  REFERENCES atelier_jobs(id) ON DELETE CASCADE,
                imported_at TIMESTAMPTZ NOT NULL DEFAULT now())""")

    @classmethod
    def tearDownClass(cls):
        try:
            cls.admin.close()
        finally:
            atelier.A = None

    def setUp(self):
        with self.admin.cursor() as cur:
            cur.execute("""TRUNCATE atelier_history_imports, atelier_edit_history,
                atelier_status_history, atelier_customer_measurements,
                atelier_measurements, atelier_jobs, all_customers RESTART IDENTITY CASCADE""")
            cur.execute("TRUNCATE all_products_clean")
            cur.execute("DROP TRIGGER IF EXISTS atelier_test_fail_history ON atelier_status_history")
            cur.execute("DROP FUNCTION IF EXISTS atelier_test_fail_history()")
        app = FastAPI()

        @app.middleware("http")
        async def identity(request: Request, call_next):
            uid = request.headers.get("x-test-user")
            roles = {"admin": "admin", "staff": "operations", "plain": "operations", "tailor": "operations"}
            if uid:
                request.state.user = {
                    "user_id": uid,
                    "role": roles[uid],
                    "status": "active",
                    "allowed_pages": ["atelier"] if uid != "plain" else [],
                }
            return await call_next(request)

        atelier.register_atelier_routes(app, self.db)
        self.client = TestClient(app, raise_server_exceptions=False)

    def _headers(self, user="staff"):
        return {"x-test-user": user}

    def _customer(self):
        response = self.client.post("/api/atelier/customers", headers=self._headers(), json={
            "first_name": "Ada", "last_name": "Customer", "phone": "0712 345 678",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["customer"]

    def _intake(self, garments=None):
        customer = self._customer()
        response = self.client.post("/api/atelier/intake", headers=self._headers(), json={
            "customer_id": customer["customer_id"], "customer_store_id": customer["store_id"],
            "garments": garments or [{"garment_type": "Dress", "assigned_to": "tailor"}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["jobs"]

    def _scalar(self, sql, params=()):
        with self.admin.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()[0]

    def test_access_boundaries_and_financial_configuration_denial(self):
        self.assertEqual(self.client.get("/api/atelier/config").status_code, 401)
        self.assertEqual(self.client.get("/api/atelier/config", headers=self._headers("plain")).status_code, 403)
        self.assertEqual(self.client.get("/api/atelier/config", headers=self._headers()).status_code, 200)
        self.assertEqual(self.client.get("/api/atelier/reports/operations", headers=self._headers()).status_code, 200)
        self.assertEqual(self.client.get("/api/atelier/admin/financial-report", headers=self._headers()).status_code, 403)
        self.assertEqual(self.client.put("/api/atelier/admin/config/ticket", headers=self._headers(),
                                         json={"value": {}}).status_code, 403)
        self.assertEqual(self.client.get("/api/atelier/admin/financial-report",
                                         headers=self._headers("admin")).status_code, 200)
        self.assertEqual(self.client.put("/api/atelier/admin/config/ticket", headers=self._headers("admin"),
                                         json={"value": {"footer": "ok"}}).status_code, 200)

    def test_phone_create_is_idempotent_under_repeated_and_concurrent_requests(self):
        payload = {"first_name": "Race", "last_name": "Winner", "phone": "+254 712 345 678"}
        self.assertTrue(self.client.post("/api/atelier/customers", headers=self._headers(), json=payload).json()["created"])
        self.assertFalse(self.client.post("/api/atelier/customers", headers=self._headers(), json={
            **payload, "phone": "0712345678"}).json()["created"])
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM all_customers WHERE phone='+254712345678'"), 1)
        barrier = threading.Barrier(5)
        results = []

        def create():
            client = TestClient(self.client.app, raise_server_exceptions=False)
            barrier.wait()
            results.append(client.post("/api/atelier/customers", headers=self._headers(), json={
                "first_name": "Concurrent", "phone": "0711-222-333"}).status_code)

        threads = [threading.Thread(target=create) for _ in range(5)]
        [thread.start() for thread in threads]
        [thread.join() for thread in threads]
        self.assertEqual(results, [200] * 5)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM all_customers WHERE phone='+254711222333'"), 1)

    def test_intake_measurements_and_valid_assignee(self):
        customer = self._customer()
        response = self.client.post("/api/atelier/intake", headers=self._headers(), json={
            "customer_id": customer["customer_id"], "customer_store_id": customer["store_id"],
            "garments": [{"garment_type": "Jacket", "assigned_to": "tailor",
                          "measurements": [{"name": "Chest", "value": "90", "unit": "cm"}]},
                         {"garment_type": "Trouser", "assigned_to": "tailor"}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        jobs = response.json()["jobs"]
        self.assertEqual(len(jobs), 2)
        self.assertEqual(len({job["claim_number"] for job in jobs}), 2)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_status_history"), 2)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_measurements"), 1)
        invalid = self.client.post("/api/atelier/intake", headers=self._headers(), json={
            "customer_id": customer["customer_id"], "customer_store_id": customer["store_id"],
            "garments": [{"garment_type": "Coat", "assigned_to": "plain"}],
        })
        self.assertEqual(invalid.status_code, 400)
        job = jobs[0]["id"]
        self.assertEqual(self.client.post(f"/api/atelier/jobs/{job}/measurements", headers=self._headers(),
                                           json={"name": "Waist", "value": 70}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/atelier/customers/{customer['customer_id']}/measurements",
                                           headers=self._headers(), json={"store_id": customer["store_id"],
                                                                          "name": "Hip", "value": 91}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/atelier/customers/{customer['customer_id']}/measurements",
                                           headers=self._headers(), json={"store_id": customer["store_id"],
                                                                          "name": "Hip", "value": 92}).status_code, 200)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_measurements WHERE job_id=%s", (job,)), 2)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_customer_measurements"), 2)

    def test_customer_search_is_selectable_and_product_snapshot_is_variant_safe(self):
        with self.admin.cursor() as cur:
            cur.execute("""INSERT INTO all_customers
                (customer_id,store_id,first_name,last_name,email,phone,last_synced)
                VALUES
                ('cust-b','other','Ada','Second','ada.second@example.test','+254700000002',now()),
                ('cust-a','vivofashiongroup','Ada','First','ada.first@example.test','+254700000001',now())""")
            cur.execute("""INSERT INTO all_products_clean
                (sku,product_name,size,color_print,barcode,style_number,style_name,product_type,category)
                VALUES
                ('V100M','System Maxi M','M','Ruby','222','V100','Vivo Maxi','Maxi Dresses','Dresses'),
                ('V100L','System Maxi L','L','Ruby','111','V100','Vivo Maxi','Maxi Dresses','Dresses')""")
        found = self.client.get("/api/atelier/customers/lookup", headers=self._headers(),
                                params={"q": "Ada"}).json()["customers"]
        self.assertEqual([row["customer_id"] for row in found], ["cust-a", "cust-b"])
        exact = self.client.get("/api/atelier/skus", headers=self._headers(),
                                params={"q": "V100L"}).json()["items"]
        self.assertEqual(exact[0]["sku"], "V100L")
        self.assertEqual(exact[0]["garment_subcategory"], "Maxi Dresses")
        keyword = self.client.get("/api/atelier/skus", headers=self._headers(),
                                  params={"q": "Dresses"}).json()["items"]
        self.assertEqual({row["sku"] for row in keyword}, {"V100M", "V100L"})
        response = self.client.post("/api/atelier/intake", headers=self._headers(), json={
            "customer_id": "cust-a", "customer_store_id": "vivofashiongroup",
            "garments": [{"sku": "V100L", "garment_subcategory": "Wrong",
                          "system_description": "Wrong"}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()["jobs"][0]
        self.assertEqual(job["garment_category"], "Dresses")
        self.assertEqual(job["garment_subcategory"], "Maxi Dresses")
        self.assertEqual(job["system_description"], "System Maxi L")
        self.assertEqual((job["size"], job["colour"]), ("L", "Ruby"))

    def test_combined_patch_is_atomic_and_history_failure_rolls_back(self):
        job = self._intake()[0]["id"]
        response = self.client.patch(f"/api/atelier/jobs/{job}", headers=self._headers(), json={
            "assigned_to": "staff", "status": "in_progress", "status_note": "Started",
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self._scalar("SELECT assigned_to FROM atelier_jobs WHERE id=%s", (job,)), "staff")
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_edit_history WHERE job_id=%s", (job,)), 1)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_status_history WHERE job_id=%s", (job,)), 2)
        with self.admin.cursor() as cur:
            cur.execute("""CREATE FUNCTION atelier_test_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.note='force rollback' THEN RAISE EXCEPTION 'forced history failure'; END IF;
                RETURN NEW; END $$""")
            cur.execute("""CREATE TRIGGER atelier_test_fail_history BEFORE INSERT ON atelier_status_history
                           FOR EACH ROW EXECUTE FUNCTION atelier_test_fail_history()""")
        failed = self.client.patch(f"/api/atelier/jobs/{job}", headers=self._headers(), json={
            "assigned_to": "tailor", "status": "quality_check", "status_note": "force rollback",
        })
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(self._scalar("SELECT status FROM atelier_jobs WHERE id=%s", (job,)), "in_progress")
        self.assertEqual(self._scalar("SELECT assigned_to FROM atelier_jobs WHERE id=%s", (job,)), "staff")
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_edit_history WHERE job_id=%s", (job,)), 1)

    def test_reports_and_escaped_ticket_footer(self):
        job = self._intake()[0]["id"]
        self.client.put("/api/atelier/admin/config/ticket", headers=self._headers("admin"),
                        json={"value": {"footer": "<b>Collect & enjoy</b>"}})
        ticket = self.client.get(f"/api/atelier/jobs/{job}/ticket", headers=self._headers())
        self.assertIn("&lt;b&gt;Collect &amp; enjoy&lt;/b&gt;", ticket.text)
        self.assertNotIn("<b>Collect", ticket.text)
        operations = self.client.get("/api/atelier/reports/operations", headers=self._headers()).text
        for forbidden in ("service_charge", "amount_paid", "customer_phone", "customer_name"):
            self.assertNotIn(forbidden, operations)
        self.assertEqual(self.client.get("/api/atelier/admin/financial-report",
                                         headers=self._headers()).status_code, 403)

    def test_importer_rerun_and_midrun_failure_are_transactional(self):
        def job(identity, status):
            return ImportJob(identity, 2, 1, "Legacy", "+254711111111", "Walk-in", "SKU",
                             "Shirt", "Maximillia Kubochi", "Hem", status,
                             datetime(2026, 7, 1), None, None, None, None)
        result = ParseResult([job("import-one", "Received"), job("import-two", "Ready for Pickup")],
                             [], 2, 0, 2, 0, "test-sha")
        with self.admin.cursor() as cur:
            cur.execute("""CREATE FUNCTION atelier_test_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.to_status='ready' AND NEW.note='Historical Tracker import'
                THEN RAISE EXCEPTION 'forced importer failure'; END IF; RETURN NEW; END $$""")
            cur.execute("""CREATE TRIGGER atelier_test_fail_history BEFORE INSERT ON atelier_status_history
                           FOR EACH ROW EXECUTE FUNCTION atelier_test_fail_history()""")
        with self.assertRaises(psycopg2.Error):
            commit_jobs(result, TEST_DB_URL)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_jobs"), 0)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_history_imports"), 0)
        with self.admin.cursor() as cur:
            cur.execute("DROP TRIGGER atelier_test_fail_history ON atelier_status_history")
        self.assertEqual(commit_jobs(result, TEST_DB_URL), (2, 0))
        self.assertEqual(commit_jobs(result, TEST_DB_URL), (0, 2))
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_jobs"), 2)
        self.assertEqual(self._scalar("SELECT COUNT(*) FROM atelier_history_imports"), 2)


if __name__ == "__main__":
    unittest.main()