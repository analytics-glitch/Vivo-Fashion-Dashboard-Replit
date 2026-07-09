"""E2E check: item-history done marks stay correct as real picks accumulate.

The Track-an-item history (`_replen_item_history`) attributes a done mark to
the MOST RECENT pick-list date on/before the mark's EAT acted-at day and
dedups the twin sku/barcode ledger rows to one canonical mark. That was first
verified with a synthetic mark because dev had almost no real done marks
overlapping pick-list snapshots. This test pins the contract end-to-end
against the live dev Postgres using the REAL production write path — the
`POST /api/recommendations/bulk` handler (twin sku+barcode rows, exactly as
Replenishments.jsx sends them) — then asserts:

* the mark lands on exactly ONE (store, date) row — the latest list date on
  or before the acted-at day — with the right actual units + transfer ref;
* every earlier appearance of the same (store, item) shows done=False;
* a barcode-kind-ONLY mark (no sku-kind ledger row) is still attributed once.

All rows use a ZZVIH- synthetic sku/run prefix and are deleted in tearDown
(fact_replen_suggestion, recommendation_actions, fact_pick_event), so the test
is safe to run repeatedly against the shared dev DB.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_replen_item_history
"""
import asyncio
import json
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import api_pg


def _eat_today():
    return (datetime.now(timezone.utc) + timedelta(hours=3)).date()


class _FakeState:
    def __init__(self):
        self.user = {"name": "IH E2E Test", "email": "ih-e2e@test.local",
                     "user_id": "ih-e2e-test"}


class _FakeRequest:
    """Minimal stand-in for fastapi.Request as used by the bulk handler."""

    def __init__(self, body):
        self._body = body
        self.state = _FakeState()

    async def json(self):
        return json.loads(json.dumps(self._body))


def _post_bulk(actions):
    return asyncio.run(api_pg.post_recommendations_bulk(_FakeRequest({"actions": actions})))


class ReplenItemHistoryDoneMarks(unittest.TestCase):
    """Marks lines done via the real bulk endpoint and checks attribution."""

    @classmethod
    def setUpClass(cls):
        api_pg._ensure_replen_tables()
        tag = uuid.uuid4().hex[:8].upper()
        cls.store = f"ZZVIH Test Store {tag}"
        cls.sku = f"ZZVIH-{tag}-SKU"
        cls.barcode = f"ZZVIH{tag}0001"
        cls.sku2 = f"ZZVIH-{tag}-SKU2"
        cls.barcode2 = f"ZZVIH{tag}0002"
        cls.style = f"ZZVIH Style {tag}"
        cls.run_prefix = f"zzvih-{tag}"
        today = _eat_today()
        cls.dates = [today - timedelta(days=10), today - timedelta(days=3)]
        rows = []
        for i, d in enumerate(cls.dates):
            for sku, bc in ((cls.sku, cls.barcode), (cls.sku2, cls.barcode2)):
                rows.append((f"{cls.run_prefix}-{i}", d, cls.store, sku, bc, d))
        for run_id, d, pos, sku, bc, _ in rows:
            api_pg._users_exec(
                "INSERT INTO fact_replen_suggestion "
                "(run_id, business_date, store_scope, ruleset_version, "
                " pos_location, country, sku, barcode, size, style_name, "
                " demand_weeks, suggested_qty, deploy_now) "
                "VALUES (%s,%s,'test','ih-e2e',%s,'Kenya',%s,%s,'M',%s,4,5,TRUE) "
                "ON CONFLICT (run_id, pos_location, sku) DO NOTHING",
                (run_id, d, pos, sku, bc, cls.style))

    @classmethod
    def tearDownClass(cls):
        api_pg._users_exec(
            "DELETE FROM fact_replen_suggestion WHERE run_id LIKE %s",
            (cls.run_prefix + "%",))
        api_pg._users_exec(
            "DELETE FROM recommendation_actions WHERE rec_key LIKE %s",
            (cls.store + "|%",))
        api_pg._users_exec(
            "DELETE FROM fact_pick_event WHERE pos_location=%s", (cls.store,))

    # ── helpers ──────────────────────────────────────────────────────────────
    def _history_rows(self, query):
        data = api_pg._replen_item_history(query)
        self.assertTrue(data["appeared"], f"item {query} not on any list")
        return [r for r in data["rows"] if r["pos_location"] == self.store], data

    # ── 1) twin sku+barcode mark (the normal Replenishments.jsx flow) ────────
    def test_twin_row_mark_attributed_to_single_latest_date(self):
        res = _post_bulk([
            {"rec_type": "replenish", "rec_key": f"{self.store}|sku|{self.sku}",
             "status": "done", "actual_units": 4, "transfer_ref": "TR-IH-001"},
            {"rec_type": "replenish", "rec_key": f"{self.store}|barcode|{self.barcode}",
             "status": "done", "actual_units": 4, "transfer_ref": "TR-IH-001"},
        ])
        self.assertTrue(res.get("ok"))

        rows, data = self._history_rows(self.sku)
        self.assertEqual(len(rows), len(self.dates),
                         "one history row per list appearance")
        done = [r for r in rows if r["done"]]
        # Twin dedup: exactly ONE (store, date) row carries the mark …
        self.assertEqual(len(done), 1, f"expected exactly 1 done row, got {done}")
        # … and it is the latest list date on/before the acted-at day.
        self.assertEqual(done[0]["business_date"], str(max(self.dates)))
        self.assertEqual(done[0]["actual_units"], 4)
        self.assertEqual(done[0]["transfer_ref"], "TR-IH-001")
        # Earlier appearance shows not picked.
        earlier = [r for r in rows if r["business_date"] == str(min(self.dates))]
        self.assertTrue(earlier and not earlier[0]["done"])
        self.assertEqual(earlier[0]["actual_units"], 0)
        # Summary counts only the one attributed mark.
        mine_done = sum(1 for r in data["rows"]
                        if r["pos_location"] == self.store and r["done"])
        self.assertEqual(mine_done, 1)

        # Barcode lookup resolves to the same canonical rows (no double view).
        brows, _ = self._history_rows(self.barcode)
        self.assertEqual(sum(1 for r in brows if r["done"]), 1)

    # ── 2) barcode-kind-ONLY mark (no sku-kind ledger row) ───────────────────
    def test_barcode_only_mark_attributed_once(self):
        res = _post_bulk([
            {"rec_type": "replenish", "rec_key": f"{self.store}|barcode|{self.barcode2}",
             "status": "done", "actual_units": 2, "transfer_ref": "TR-IH-002"},
        ])
        self.assertTrue(res.get("ok"))
        # Sanity: genuinely no sku-kind row exists in the ledger.
        skurow = api_pg._users_exec(
            "SELECT 1 FROM recommendation_actions WHERE rec_type='replenish' "
            "AND rec_key=%s", (f"{self.store}|sku|{self.sku2}",), fetch=True)
        self.assertFalse(skurow)

        rows, _ = self._history_rows(self.sku2)
        done = [r for r in rows if r["done"]]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["business_date"], str(max(self.dates)))
        self.assertEqual(done[0]["actual_units"], 2)
        self.assertEqual(done[0]["transfer_ref"], "TR-IH-002")


if __name__ == "__main__":
    unittest.main()
