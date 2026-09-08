"""Regression tests for the non-Kenya Shopify customer-profile sync."""

import ast
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import extract_shopify_customers as esc
import sync_incremental as si
import transform_all_customers as tac
import watchdog


class _Response:
    def __init__(self, customers=None, status=200, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._customers = customers or []

    def json(self):
        return {"customers": self._customers}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise esc.requests.HTTPError(f"HTTP {self.status_code}", response=self)


class _Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class FetchTests(unittest.TestCase):
    def test_cursor_pagination_keeps_watermark_only_on_first_request(self):
        session = _Session(
            [
                _Response(
                    [{"id": 1}],
                    headers={
                        "Link": '<https://store/admin/api/x/customers.json?page_info=abc>; rel="next"'
                    },
                ),
                _Response([{"id": 2}]),
            ]
        )
        rows = esc.fetch_customers(
            "store.myshopify.com",
            "token",
            "2026-08-01T00:00:00Z",
            session=session,
            sleep=lambda _: None,
        )
        self.assertEqual([r["id"] for r in rows], [1, 2])
        self.assertEqual(
            session.calls[0][1]["params"]["updated_at_min"],
            "2026-08-01T00:00:00Z",
        )
        self.assertEqual(session.calls[1][1]["params"], {})

    def test_rate_limit_is_retried(self):
        session = _Session(
            [
                _Response(status=429, headers={"Retry-After": "0"}),
                _Response([{"id": 7}]),
            ]
        )
        beats = []
        rows = esc.fetch_customers(
            "store.myshopify.com",
            "token",
            esc.FIRST_SYNC_AT,
            session=session,
            sleep=lambda _: None,
            heartbeat=beats.append,
        )
        self.assertEqual(rows, [{"id": 7}])
        self.assertEqual(len(session.calls), 2)
        self.assertIn("retry_http:429", beats)

    def test_customer_row_maps_complete_profile_and_consent(self):
        row = esc.customer_row(
            {
                "id": 10,
                "email": "new@example.com",
                "first_name": "New",
                "last_name": "Name",
                "phone": None,
                "default_address": {
                    "phone": "+2501",
                    "city": "Kigali",
                    "province": "Kigali City",
                    "country": "Rwanda",
                },
                "state": "enabled",
                "total_spent": "125.5",
                "orders_count": 2,
                "email_marketing_consent": {"state": "subscribed"},
                "sms_marketing_consent": {"state": "not_subscribed"},
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-08-31T10:00:00Z",
            },
            "vivo-rwanda",
            datetime(2026, 8, 31, tzinfo=timezone.utc),
        )
        self.assertEqual(row[2:11], (
            "new@example.com", "New", "Name", "+2501", "+2501",
            "Kigali", "Kigali City", "Rwanda", "enabled",
        ))
        self.assertTrue(row[13])
        self.assertFalse(row[14])


class WatermarkTests(unittest.TestCase):
    class Cursor:
        def __init__(self, answers):
            self.answers = iter(answers)
            self.queries = []
            self._answer = None

        def execute(self, sql, params=None):
            self.queries.append((" ".join(sql.split()), params))
            self._answer = next(self.answers)

        def fetchone(self):
            return self._answer

    def test_first_run_uses_2019_floor(self):
        cur = self.Cursor([(None,), (None,)])
        self.assertEqual(esc.get_last_sync(cur, "vivo-uganda"), esc.FIRST_SYNC_AT)

    def test_existing_state_watermark_wins(self):
        stamp = datetime(2026, 8, 30, 8, 0, tzinfo=timezone.utc)
        cur = self.Cursor([(stamp,)])
        self.assertEqual(
            esc.get_last_sync(cur, "vivo-uganda"),
            "2026-08-30T08:00:00Z",
        )
        self.assertEqual(len(cur.queries), 1)

    def test_failed_bootstrap_still_requires_full_reconcile(self):
        cur = self.Cursor([(None,)])
        self.assertTrue(
            esc.needs_full_read_model_reconcile(cur, "vivo-rwanda")
        )

    def test_successful_bootstrap_switches_to_changed_ids_only(self):
        cur = self.Cursor([
            (datetime(2026, 8, 31, 8, 0, tzinfo=timezone.utc),)
        ])
        self.assertFalse(
            esc.needs_full_read_model_reconcile(cur, "vivo-rwanda")
        )


class IsolationTests(unittest.TestCase):
    def test_one_store_failure_does_not_stop_following_stores(self):
        stores = [
            {"store_id": "vivo-uganda"},
            {"store_id": "vivo-rwanda"},
            {"store_id": "shop-zetu"},
        ]

        def fake_sync(store, **_):
            if store["store_id"] == "vivo-rwanda":
                raise RuntimeError("Rwanda unavailable")
            return {
                "store_id": store["store_id"],
                "success": True,
                "fetched": 1,
                "upserted": 1,
            }

        with mock.patch.object(esc, "sync_store", side_effect=fake_sync) as call:
            reports = esc.sync_all_stores(stores)
        self.assertEqual(call.call_count, 3)
        self.assertEqual([r["success"] for r in reports], [True, False, True])

    def test_active_registry_excludes_retired_kenya_shopify(self):
        self.assertEqual(
            {s["store_id"] for s in esc.STORES},
            {"vivo-uganda", "vivo-rwanda", "shop-zetu"},
        )
        self.assertNotIn("vivowoman", {s["store_id"] for s in esc.STORES})


class ReadModelContractTests(unittest.TestCase):
    def test_raw_conflict_update_refreshes_every_source_field(self):
        for field in (
            "email", "first_name", "last_name", "phone",
            "default_address_phone", "default_address_city",
            "default_address_province", "default_address_country", "state",
            "total_spent", "orders_count", "accepts_email_marketing",
            "accepts_sms_marketing", "created_at", "updated_at", "_loaded_at",
        ):
            self.assertIn(f"{field} = EXCLUDED.{field}", esc.RAW_UPSERT_SQL)

    def test_bi_upsert_is_store_scoped_and_updates_profile_fields(self):
        source = Path("transform_all_customers.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        fn = next(
            n for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name == "upsert_shopify_store"
        )
        strings = "\n".join(
            n.value for n in ast.walk(fn)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
        )
        self.assertIn("WHERE r.store_id = %s", strings)
        self.assertIn("ON CONFLICT (customer_id, store_id) DO UPDATE", strings)
        for field in (
            "first_name", "last_name", "email", "phone", "city", "country",
            "state", "customer_type", "total_orders", "total_spend_kes",
            "avg_order_value_kes", "first_order_date", "last_order_date",
            "accepts_email_marketing", "accepts_sms_marketing",
            "profile_updated_at", "last_synced",
        ):
            self.assertIn(f"{field} = EXCLUDED.{field}", strings)

    def test_country_mapping_keeps_online_scope(self):
        self.assertEqual(tac.SHOPIFY_COUNTRIES["vivo-uganda"], "Uganda")
        self.assertEqual(tac.SHOPIFY_COUNTRIES["vivo-rwanda"], "Rwanda")
        self.assertEqual(tac.SHOPIFY_COUNTRIES["shop-zetu"], "Online")

    def test_first_managed_run_reconciles_full_existing_raw_market(self):
        source = Path("extract_shopify_customers.py").read_text(encoding="utf-8")
        self.assertIn(
            "customer_ids=None if first_managed_run else customer_ids",
            source,
        )

    def test_verifier_checks_recent_identified_sales_and_visible_profiles(self):
        source = Path("extract_shopify_customers.py").read_text(encoding="utf-8")
        self.assertIn("recent_visible_profiles", source)
        self.assertIn("s.sale_date::date >= CURRENT_DATE - 30", source)
        self.assertIn("c.store_id = s.store_id", source)


class _OneShotStop(threading.Event):
    def wait(self, timeout=None):
        self.set()
        return True


class WorkerCadenceTests(unittest.TestCase):
    def test_worker_runs_all_markets_once_and_uses_own_heartbeat(self):
        reports = [
            {
                "store_id": sid,
                "success": True,
                "fetched": 1,
                "upserted": 1,
                "watermark": "2026-08-31T00:00:00Z",
            }
            for sid in ("vivo-uganda", "vivo-rwanda", "shop-zetu")
        ]
        fake_conn = mock.MagicMock()
        fake_conn.closed = False
        old_stamp = si._LAST_SHOPIFY_CUSTOMER_SYNC
        si._LAST_SHOPIFY_CUSTOMER_SYNC = None
        self.addCleanup(
            lambda: setattr(si, "_LAST_SHOPIFY_CUSTOMER_SYNC", old_stamp)
        )
        with mock.patch("extract_shopify_customers.sync_all_stores",
                        return_value=reports) as run, \
             mock.patch.object(si.psycopg2, "connect", return_value=fake_conn), \
             mock.patch.object(si, "ensure_heartbeat_table") as ensure, \
             mock.patch.object(si, "write_heartbeat") as heartbeat, \
             mock.patch.object(si, "record_source_success"):
            si.shopify_customer_worker_loop(_OneShotStop())
        run.assert_called_once()
        ensure.assert_called_once_with(fake_conn, "shopify_customer_heartbeat")
        self.assertTrue(
            any(
                call.kwargs.get("table") == "shopify_customer_heartbeat"
                for call in heartbeat.call_args_list
            )
        )


class WatchdogHeartbeatTests(unittest.TestCase):
    class Cursor:
        def __init__(self, stamp):
            self.stamp = stamp
            self.step = 0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def execute(self, *_):
            self.step += 1

        def fetchone(self):
            if self.step == 1:
                return ("public.shopify_customer_heartbeat",)
            return (self.stamp,)

    class Conn:
        def __init__(self, stamp):
            self.stamp = stamp

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def cursor(self):
            return WatchdogHeartbeatTests.Cursor(self.stamp)

    def test_stale_customer_worker_heartbeat_is_detected(self):
        from datetime import timedelta

        stamp = datetime.now(timezone.utc) - timedelta(
            minutes=watchdog.SHOPIFY_CUSTOMER_FRESH_MIN + 1
        )
        with mock.patch.object(
            watchdog, "_db", return_value=self.Conn(stamp)
        ):
            healthy, returned, minutes = (
                watchdog.check_shopify_customer_worker()
            )
        self.assertFalse(healthy)
        self.assertEqual(returned, stamp)
        self.assertGreater(minutes, watchdog.SHOPIFY_CUSTOMER_FRESH_MIN)

    def test_worker_starts_only_in_continuous_path(self):
        tree = ast.parse(
            Path("sync_incremental.py").read_text(encoding="utf-8")
        )
        module_if = next(
            node for node in tree.body
            if isinstance(node, ast.If)
            and isinstance(node.test, ast.Compare)
            and any(
                isinstance(x, ast.Constant) and x.value == "__main__"
                for x in ast.walk(node.test)
            )
        )
        once_if = next(
            node for node in ast.walk(module_if)
            if isinstance(node, ast.If)
            and any(
                isinstance(x, ast.Attribute) and x.attr == "once"
                for x in ast.walk(node.test)
            )
        )
        self.assertFalse(
            any(
                isinstance(x, ast.Name)
                and x.id == "shopify_customer_worker_loop"
                for stmt in once_if.body for x in ast.walk(stmt)
            )
        )
        self.assertTrue(
            any(
                isinstance(x, ast.Name)
                and x.id == "shopify_customer_worker_loop"
                for stmt in once_if.orelse for x in ast.walk(stmt)
            )
        )


if __name__ == "__main__":
    unittest.main()