"""Integration coverage for production workspace factory-scope guards.

Run only against a throwaway local PostgreSQL database supplied through
TEST_DATABASE_URL. The suite creates and drops only production-workspace
fixtures, never the application's configured DATABASE_URL.
"""

import os
import unittest

import psycopg2


TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")
ROOT = os.path.dirname(os.path.abspath(__file__))


@unittest.skipUnless(TEST_DB_URL, "TEST_DATABASE_URL not set")
class ProductionWorkspacePostgresIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = psycopg2.connect(TEST_DB_URL)
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS production_workspace_factories CASCADE")
            cur.execute("DROP TABLE IF EXISTS production_orders CASCADE")
            cur.execute("DROP TABLE IF EXISTS production_stages CASCADE")
            cur.execute("DROP TABLE IF EXISTS stage_movements CASCADE")
            cur.execute("CREATE TABLE production_orders (order_ref TEXT PRIMARY KEY)")
            cur.execute("CREATE TABLE production_stages (stage_key TEXT PRIMARY KEY)")
            cur.execute("CREATE TABLE stage_movements (id BIGSERIAL PRIMARY KEY)")
            with open(os.path.join(ROOT, "production_tracker_schema.sql"),
                      encoding="utf-8") as schema_file:
                schema = schema_file.read()
            marker = "-- ============================================================\n-- Production Workspace Foundation"
            cur.execute(schema[schema.index(marker):])
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        try:
            cls.conn.rollback()
            cls.conn.autocommit = True
            with cls.conn.cursor() as cur:
                cur.execute("DROP TABLE IF EXISTS production_workspace_factories CASCADE")
                cur.execute("DROP TABLE IF EXISTS production_orders CASCADE")
                cur.execute("DROP TABLE IF EXISTS production_stages CASCADE")
                cur.execute("DROP TABLE IF EXISTS stage_movements CASCADE")
        finally:
            cls.conn.close()

    def _insert(self, sql, params):
        with self.conn.cursor() as cur:
            cur.execute(sql + " RETURNING id", params)
            return cur.fetchone()[0]

    def test_scope_guards_reject_cross_factory_plan_and_inputs(self):
        factory_a = self._insert(
            "INSERT INTO production_workspace_factories(code,name) VALUES (%s,%s)",
            ("scope-a", "Factory A"),
        )
        factory_b = self._insert(
            "INSERT INTO production_workspace_factories(code,name) VALUES (%s,%s)",
            ("scope-b", "Factory B"),
        )
        line_a = self._insert(
            "INSERT INTO production_workspace_lines(factory_id,code,name) VALUES (%s,%s,%s)",
            (factory_a, "line-a", "Line A"),
        )
        line_b = self._insert(
            "INSERT INTO production_workspace_lines(factory_id,code,name) VALUES (%s,%s,%s)",
            (factory_b, "line-b", "Line B"),
        )
        shift_a = self._insert(
            "INSERT INTO production_workspace_shifts(factory_id,code,name,start_time,end_time) "
            "VALUES (%s,%s,%s,%s,%s)",
            (factory_a, "day-a", "Day A", "08:00", "17:00"),
        )
        shift_b = self._insert(
            "INSERT INTO production_workspace_shifts(factory_id,code,name,start_time,end_time) "
            "VALUES (%s,%s,%s,%s,%s)",
            (factory_b, "day-b", "Day B", "08:00", "17:00"),
        )
        calendar_b = self._insert(
            "INSERT INTO production_workspace_calendars(factory_id,calendar_date,shift_id) "
            "VALUES (%s,%s,%s)",
            (factory_b, "2099-01-01", shift_b),
        )
        machine_b = self._insert(
            "INSERT INTO production_workspace_machines(factory_id,line_id,code,name) "
            "VALUES (%s,%s,%s,%s)",
            (factory_b, line_b, "machine-b", "Machine B"),
        )
        unlined_machine_a = self._insert(
            "INSERT INTO production_workspace_machines(factory_id,code,name) "
            "VALUES (%s,%s,%s)",
            (factory_a, "machine-a-free", "Machine A Free"),
        )
        work_item = self._insert(
            "INSERT INTO production_workspace_work_items(external_ref,planned_qty) VALUES (%s,%s)",
            ("scope-test-order", 1),
        )

        with self.conn.cursor() as cur:
            cur.execute("SAVEPOINT invalid_capability")
            with self.assertRaisesRegex(psycopg2.Error, "Capability machine and line must share"):
                cur.execute(
                    "INSERT INTO production_workspace_capabilities "
                    "(machine_id,line_id,capability_key,name) VALUES (%s,%s,%s,%s)",
                    (unlined_machine_a, line_b, "scope-bad-capability", "Bad Capability"),
                )
            cur.execute("ROLLBACK TO SAVEPOINT invalid_capability")
            cur.execute("SAVEPOINT invalid_plan")
            with self.assertRaisesRegex(psycopg2.Error, "Plan line must belong"):
                cur.execute(
                    "INSERT INTO production_workspace_plan_versions "
                    "(work_item_id,version_no,factory_id,line_id,shift_id,planned_start,planned_end,planned_qty) "
                    "VALUES (%s,1,%s,%s,%s,'2099-01-01','2099-01-01',1)",
                    (work_item, factory_a, line_b, shift_a),
                )
            cur.execute("ROLLBACK TO SAVEPOINT invalid_plan")
            cur.execute(
                "INSERT INTO production_workspace_plan_versions "
                "(work_item_id,version_no,factory_id,line_id,shift_id,planned_start,planned_end,planned_qty) "
                "VALUES (%s,1,%s,%s,%s,'2099-01-01','2099-01-01',1) RETURNING id",
                (work_item, factory_a, line_a, shift_a),
            )
            plan_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO production_workspace_operations "
                "(work_item_id,plan_version_id,operation_code,name,sequence_no,sam_minutes) "
                "VALUES (%s,%s,%s,%s,1,1)",
                (work_item, plan_id, "scope-operation", "Scope Operation"),
            )

            cur.execute("SAVEPOINT invalid_plan_reparent")
            with self.assertRaisesRegex(psycopg2.Error, "Plan factory, line and shift are locked"):
                cur.execute(
                    "UPDATE production_workspace_plan_versions SET factory_id=%s WHERE id=%s",
                    (factory_b, plan_id),
                )
            cur.execute("ROLLBACK TO SAVEPOINT invalid_plan_reparent")

            cur.execute("SAVEPOINT invalid_capacity")
            with self.assertRaisesRegex(psycopg2.Error, "Capacity calendar must belong"):
                cur.execute(
                    "INSERT INTO production_workspace_capacity_inputs "
                    "(plan_version_id,calendar_id,available_minutes,required_minutes) "
                    "VALUES (%s,%s,60,60)",
                    (plan_id, calendar_b),
                )
            cur.execute("ROLLBACK TO SAVEPOINT invalid_capacity")

            cur.execute("SAVEPOINT invalid_assignment")
            with self.assertRaisesRegex(psycopg2.Error, "Plan input machine must belong"):
                cur.execute(
                    "INSERT INTO production_workspace_assignments "
                    "(plan_version_id,machine_id,planned_minutes) VALUES (%s,%s,60)",
                    (plan_id, machine_b),
                )
            cur.execute("ROLLBACK TO SAVEPOINT invalid_assignment")

            cur.execute("SAVEPOINT invalid_reparent")
            with self.assertRaisesRegex(psycopg2.Error, "Factory ownership is immutable"):
                cur.execute(
                    "UPDATE production_workspace_lines SET factory_id=%s WHERE id=%s",
                    (factory_b, line_a),
                )
            cur.execute("ROLLBACK TO SAVEPOINT invalid_reparent")


if __name__ == "__main__":
    unittest.main()