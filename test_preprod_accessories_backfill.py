"""Regression tests for the one-time Pre-production Accessories % retrofit.

The tests exercise the real batch function against a narrow in-memory database
fake. They verify the controlled locked-sheet bypass, one common Done-DPS pick,
targeted line updates, no-history retention, audit rows, and idempotent reruns.
"""
import copy
import json
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr


class Store:
    def __init__(self):
        self.sheets = []
        self.lines = []
        self.history = []

    def add_sheet(self, sheet_id, *, stage="pre_production", pct=13,
                  meta=None, locked=False, style=None):
        self.sheets.append({
            "id": sheet_id,
            "style_name": style or f"Style {sheet_id}",
            "stage": stage,
            "accessories_pct": pct,
            "accessories_pct_meta": meta,
            "locked": locked,
        })

    def add_line(self, line_id, sheet_id, kind, label, qty, unit_cost,
                 total=None, is_auto=False, source=None, position=0,
                 component_id=None):
        self.lines.append({
            "id": line_id, "sheet_id": sheet_id, "kind": kind,
            "label": label, "qty": qty, "unit_cost": unit_cost,
            "total": qty * unit_cost if total is None else total,
            "is_auto": is_auto, "source": source, "position": position,
            "component_id": component_id,
        })


class Cursor:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=()):
        normalized = " ".join(sql.split())
        if normalized.startswith(("SAVEPOINT ", "RELEASE SAVEPOINT ",
                                  "ROLLBACK TO SAVEPOINT ")):
            return
        if normalized.startswith("UPDATE fabric_costing_sheets SET accessories_pct="):
            pct, meta_json, sheet_id = params
            sheet = next(s for s in self.store.sheets if s["id"] == sheet_id)
            if sheet["accessories_pct_meta"] is None:
                sheet["accessories_pct"] = pct
                sheet["accessories_pct_meta"] = json.loads(meta_json)
            return
        if (normalized.startswith("UPDATE fabric_costing_lines SET label=")
                and "qty=%s" in normalized):
            (label, qty, unit_cost, total, is_auto, source, component_id,
             line_id, sheet_id) = params
            line = next(l for l in self.store.lines
                        if l["id"] == line_id and l["sheet_id"] == sheet_id)
            line.update({
                "label": label, "qty": qty, "unit_cost": unit_cost,
                "total": total, "is_auto": is_auto, "source": source,
                "component_id": component_id,
            })
            return
        if normalized.startswith("UPDATE fabric_costing_lines SET label="):
            label, is_auto, source, line_id, sheet_id = params
            line = next(l for l in self.store.lines
                        if l["id"] == line_id and l["sheet_id"] == sheet_id)
            line.update({"label": label, "is_auto": is_auto, "source": source})
            return
        if normalized.startswith("DELETE FROM fabric_costing_lines"):
            sheet_id, ids = params
            ids = set(ids)
            self.store.lines = [
                l for l in self.store.lines
                if not (l["sheet_id"] == sheet_id and l["id"] in ids)]
            return
        if normalized.startswith("INSERT INTO fabric_costing_history"):
            self.store.history.append({
                "sheet_id": params[0], "action": params[1],
                "changed_by": params[2], "changed_by_name": params[3],
                "summary": params[4], "snapshot": json.loads(params[5]),
            })
            return
        raise AssertionError(f"Unexpected SQL: {sql}")


class Conn:
    def __init__(self, store):
        self.store = store
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self, *args, **kwargs):
        return Cursor(self.store)

    def commit(self):
        self.commits += 1


def fake_q(store):
    def q(conn, sql, params=()):
        if "FROM fabric_costing_sheets s" in sql:
            return [copy.deepcopy(s) for s in store.sheets
                    if (s.get("stage") or "main_production") == "pre_production"]
        if "FROM fabric_costing_lines" in sql:
            sheet_id = params[0]
            return [copy.deepcopy(l) for l in sorted(
                (l for l in store.lines if l["sheet_id"] == sheet_id),
                key=lambda row: (row["position"], row["id"]))]
        raise AssertionError(f"Unexpected query: {sql}")
    return q


PICK = {
    "pct": 8.981039134139472,
    "meta": {
        "pct": 8.981039134139472,
        "source_month": "2026-07",
        "month_label": "Jul 2026",
        "dps_count": 75,
        "fallback": False,
        "is_default": False,
        "requested_month": "2026-07",
        "requested_month_label": "Jul 2026",
        "picked_at": "2026-08-19T10:00:00+03:00",
    },
}


def seed_costing(store, sheet_id, *, basis, pct=13, locked=False):
    store.add_sheet(sheet_id, pct=pct, locked=locked)
    store.add_line(sheet_id * 10, sheet_id, "fabric", "Main fabric",
                   1, basis, position=0, component_id=sheet_id)
    store.add_line(sheet_id * 10 + 1, sheet_id, "trim",
                   f"Accessories ({pct}% of fabric cost)",
                   1, round(basis * pct / 100, 2), is_auto=False,
                   source=None, position=1)
    store.add_line(sheet_id * 10 + 2, sheet_id, "trim", "Buttons",
                   2, 7.5, total=15, is_auto=False, source="manual",
                   position=2, component_id=999)


class PickedBackfill(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        seed_costing(self.store, 1, basis=908.10, locked=False)
        seed_costing(self.store, 2, basis=451.00, locked=True)
        self.store.add_sheet(3, stage="main_production", pct=13)
        self.patch_q = mock.patch.object(fr, "q", fake_q(self.store))
        self.patch_pick = mock.patch.object(
            fr, "_preprod_accessories_pick",
            lambda conn, today=None: copy.deepcopy(PICK))
        self.patch_q.start()
        self.patch_pick.start()
        self.addCleanup(self.patch_q.stop)
        self.addCleanup(self.patch_pick.stop)
        self.conn = Conn(self.store)

    def test_common_pick_updates_locked_and_unlocked_sheets(self):
        out = fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        self.assertEqual(out["picked"], 2)
        self.assertEqual(out["retained"], 0)
        self.assertEqual(out["locked_updated"], 1)
        self.assertEqual(out["source_month"], "2026-07")
        self.assertEqual(out["dps_count"], 75)

        sheets = {s["id"]: s for s in self.store.sheets}
        self.assertEqual(sheets[3]["accessories_pct_meta"], None,
                         "Main Production must not be touched")
        for sid in (1, 2):
            self.assertAlmostEqual(
                sheets[sid]["accessories_pct"], PICK["pct"], places=10)
            meta = sheets[sid]["accessories_pct_meta"]
            self.assertEqual(meta["source_month"], "2026-07")
            self.assertEqual(meta["dps_count"], 75)
            self.assertEqual(meta["retrofit_status"], "picked")
            self.assertEqual(meta["migration_key"], fr._PP_ACC_BACKFILL_KEY)

        accessories = {
            l["sheet_id"]: l for l in self.store.lines
            if l["label"].startswith("Accessories (")}
        self.assertEqual(accessories[1]["unit_cost"], 81.56)
        self.assertEqual(accessories[1]["total"], 81.56)
        self.assertEqual(accessories[2]["unit_cost"], 40.50)
        self.assertIn("Jul 2026 Done-DPS avg, 75 DPS",
                      accessories[1]["label"])
        self.assertTrue(accessories[2]["is_auto"])

    def test_unrelated_lines_and_fields_remain_unchanged(self):
        before = copy.deepcopy([
            l for l in self.store.lines if l["label"] == "Buttons"])
        fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        after = [l for l in self.store.lines if l["label"] == "Buttons"]
        self.assertEqual(after, before)

    def test_one_audit_event_per_changed_sheet(self):
        fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(
            {h["action"] for h in self.store.history},
            {"accessories_pct_retrofit"})
        locked_snapshot = next(
            h["snapshot"] for h in self.store.history
            if h["sheet_id"] == 2)
        self.assertTrue(locked_snapshot["approved_sheet"])
        self.assertEqual(
            locked_snapshot["accessories_pct_meta"]["source_month"],
            "2026-07")

    def test_rerun_is_idempotent(self):
        first = fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        lines_after_first = copy.deepcopy(self.store.lines)
        second = fr._preprod_accessories_backfill(
            self.conn, "admin-1", "Admin User")
        self.assertEqual(first["picked"], 2)
        self.assertEqual(second["picked"], 0)
        self.assertEqual(second["skipped"], 2)
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(self.store.lines, lines_after_first,
                         "reruns must not compound rounding or labels")


class RetainedBackfill(unittest.TestCase):
    def test_no_history_keeps_percentage_and_cost_but_records_reason(self):
        store = Store()
        seed_costing(store, 4, basis=800, pct=15, locked=True)
        original_accessories = next(
            l for l in store.lines if l["label"].startswith("Accessories ("))
        original_cost = (original_accessories["qty"],
                         original_accessories["unit_cost"],
                         original_accessories["total"])
        no_history = copy.deepcopy(PICK)
        no_history["pct"] = 13.0
        no_history["meta"].update({
            "pct": 13.0, "source_month": None, "month_label": None,
            "dps_count": 0, "is_default": True,
        })
        with mock.patch.object(fr, "q", fake_q(store)), \
                mock.patch.object(
                    fr, "_preprod_accessories_pick",
                    lambda conn, today=None: copy.deepcopy(no_history)):
            out = fr._preprod_accessories_backfill(
                Conn(store), "admin-1", "Admin User")

        self.assertEqual(out["picked"], 0)
        self.assertEqual(out["retained"], 1)
        sheet = store.sheets[0]
        self.assertEqual(sheet["accessories_pct"], 15)
        self.assertEqual(
            sheet["accessories_pct_meta"]["retrofit_status"],
            "retained_no_history")
        line = next(
            l for l in store.lines if l["label"].startswith("Accessories ("))
        self.assertEqual((line["qty"], line["unit_cost"], line["total"]),
                         original_cost)
        self.assertIn("retained (no qualifying Done-DPS history)",
                      line["label"])
        self.assertIn("retained 15%", store.history[0]["summary"])


class AccessAndSurfaceContract(unittest.TestCase):
    def test_maintenance_endpoint_rejects_non_admin(self):
        request = SimpleNamespace(state=SimpleNamespace(
            user={"role": "leadership", "user_id": "u-1", "name": "Lead"}))
        with self.assertRaises(HTTPException) as ctx:
            fr.costing_backfill_preprod_accessories(request)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_list_and_editor_sources_expose_retrofit_provenance(self):
        with open("fabric_dashboard_live.html", encoding="utf-8") as fh:
            html = fh.read()
        self.assertIn("s.accessories_pct_meta", html)
        self.assertIn("retained (no qualifying Done-DPS history)", html)
        self.assertIn("backfilled automatically", html)


if __name__ == "__main__":
    unittest.main()