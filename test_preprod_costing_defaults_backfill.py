"""Regression tests for the controlled Pre-production defaults retrofit.

The maintenance function is deliberately exercised through its real SQL-shaped
logic against a small in-memory database fake. This proves the migration stays
scoped to Pre-production, includes locked sheets, recalculates only machine
CMT/defect rows and proposed prices, writes audit history, and is idempotent.
"""
import copy
import json
import unittest
from types import SimpleNamespace

from fastapi import HTTPException
import fabric_router as fr


class Store:
    def __init__(self):
        self.sheets = []
        self.lines = []
        self.history = []

    def sheet(self, sheet_id, *, stage="pre_production", defect=10,
              cpm=5, start="08:00", stop="08:30", multiplier=1.4,
              price=1000, locked=False, embroidery=None):
        self.sheets.append({
            "id": sheet_id, "style_name": f"Style {sheet_id}", "stage": stage,
            "defect_allowance_pct": defect, "cost_per_minute": cpm,
            "cmt_start_time": start, "cmt_stop_time": stop,
            "production_multiplier": multiplier, "selling_price": price,
            "embroidery_data": embroidery, "preprod_defaults_meta": None,
            "locked": locked,
        })

    def line(self, line_id, sheet_id, kind, label, qty, unit_cost, *,
             is_auto=False, source=None, position=0):
        self.lines.append({
            "id": line_id, "sheet_id": sheet_id, "kind": kind, "label": label,
            "qty": qty, "unit_cost": unit_cost, "total": round(qty * unit_cost, 2),
            "is_auto": is_auto, "source": source, "position": position,
            "component_id": None,
        })


class Cursor:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=()):
        statement = " ".join(sql.split())
        if statement.startswith(("SAVEPOINT ", "RELEASE SAVEPOINT ",
                                 "ROLLBACK TO SAVEPOINT ")):
            return
        if statement.startswith("UPDATE fabric_costing_sheets SET defect_allowance_pct="):
            defect, cpm, price, meta_json, sheet_id = params
            row = next(s for s in self.store.sheets if s["id"] == sheet_id)
            row.update({
                "defect_allowance_pct": defect, "cost_per_minute": cpm,
                "selling_price": price, "preprod_defaults_meta": json.loads(meta_json),
            })
            return
        if statement.startswith("UPDATE fabric_costing_lines SET label="):
            (label, qty, unit_cost, total, is_auto, source, component_id,
             line_id, sheet_id) = params
            row = next(l for l in self.store.lines
                       if l["id"] == line_id and l["sheet_id"] == sheet_id)
            row.update({
                "label": label, "qty": qty, "unit_cost": unit_cost,
                "total": total, "is_auto": is_auto, "source": source,
                "component_id": component_id,
            })
            return
        if statement.startswith("DELETE FROM fabric_costing_lines"):
            sheet_id, ids = params
            self.store.lines = [
                line for line in self.store.lines
                if not (line["sheet_id"] == sheet_id and line["id"] in set(ids))]
            return
        if statement.startswith("INSERT INTO fabric_costing_history"):
            self.store.history.append({
                "sheet_id": params[0], "action": params[1],
                "changed_by": params[2], "changed_by_name": params[3],
                "summary": params[4], "snapshot": json.loads(params[5]),
            })
            return
        raise AssertionError("Unexpected SQL:\n" + sql)


class Conn:
    def __init__(self, store):
        self.store = store

    def cursor(self, *args, **kwargs):
        return Cursor(self.store)


def fake_q(store):
    def query(conn, sql, params=()):
        statement = " ".join(sql.split())
        if "FROM fabric_costing_sheets s" in statement and "FOR UPDATE" in statement:
            return [
                copy.deepcopy(sheet) for sheet in store.sheets
                if (sheet.get("stage") or "main_production") == "pre_production"
            ]
        if "FROM fabric_costing_lines" in statement and "WHERE sheet_id=%s" in statement:
            return [
                copy.deepcopy(line)
                for line in sorted(
                    (line for line in store.lines if line["sheet_id"] == params[0]),
                    key=lambda line: (line["position"], line["id"]))
            ]
        raise AssertionError("Unexpected query:\n" + sql)
    return query


class PreProductionDefaultsBackfillTest(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        # An editable sheet with a source-tagged default plus an exact-label
        # manual line: migration must change only the provably machine row.
        self.store.sheet(1)
        self.store.line(1, 1, "fabric", "Main fabric", 2.5, 363.24, position=0)
        self.store.line(2, 1, "cmt", "CMT (08:00–08:30, KES 5/min ×1.40)", 1, 210,
                        is_auto=True, source="pre-production auto: time-based CMT", position=1)
        self.store.line(3, 1, "overhead", "Defect Allowance (10% of fabric cost)", 1, 90.81,
                        is_auto=True, source="pre-production auto: 10% of fabric cost", position=2)
        self.store.line(4, 1, "overhead", "Defect Allowance (10% of fabric cost)", 1, 90.81,
                        is_auto=False, source=None, position=3)
        self.store.line(5, 1, "overhead", "Manual packing provision", 1, 12,
                        is_auto=False, source="manual", position=4)
        # NULL legacy inputs and an approved sheet are intentionally included.
        self.store.sheet(2, defect=None, cpm=None, locked=True)
        self.store.line(6, 2, "fabric", "Main fabric", 1, 100, position=0)
        self.store.line(7, 2, "cmt", "CMT (08:00–08:30, KES 0/min ×1.40)", 1, 0,
                        is_auto=True, source="pre-production auto: time-based CMT", position=1)
        self.store.line(8, 2, "overhead", "Defect Allowance (10% of fabric cost)", 1, 10,
                        is_auto=True, source="pre-production auto: 10% of fabric cost", position=2)
        # Main Production is a strict no-op even where it shares the old values.
        self.store.sheet(3, stage="main_production")
        self.store.line(9, 3, "fabric", "Main fabric", 1, 100, position=0)
        self.store.line(10, 3, "cmt", "Manual CMT", 1, 5, position=1)
        self.conn = Conn(self.store)
        self._q = fr.q
        fr.q = fake_q(self.store)
        self.addCleanup(setattr, fr, "q", self._q)

    def test_retrofit_updates_defaults_auto_lines_prices_and_audit(self):
        result = fr._preprod_defaults_backfill(self.conn, "admin", "Admin")
        self.assertEqual(result["updated"], 2)
        self.assertEqual(result["locked_updated"], 1)
        self.assertEqual(result["errors"], 0)

        editable = self.store.sheets[0]
        self.assertEqual(editable["defect_allowance_pct"], 4.0)
        self.assertEqual(editable["cost_per_minute"], 22.71)
        self.assertEqual(editable["preprod_defaults_meta"]["migration_key"],
                         fr._PP_DEFAULTS_BACKFILL_KEY)
        cmt = next(line for line in self.store.lines if line["id"] == 2)
        defect = next(line for line in self.store.lines if line["id"] == 3)
        self.assertEqual(cmt["unit_cost"], 953.82)       # 30 × 1.40 × 22.71
        self.assertIn("KES 22.71/min", cmt["label"])
        self.assertEqual(defect["unit_cost"], 36.32)     # 4% × 908.10
        self.assertEqual(defect["label"], "Defect Allowance (4% of fabric cost)")
        exact_manual = next(line for line in self.store.lines if line["id"] == 4)
        self.assertEqual((exact_manual["label"], exact_manual["unit_cost"]),
                         ("Defect Allowance (10% of fabric cost)", 90.81),
                         "a source-less exact label can be user-authored")
        manual = next(line for line in self.store.lines if line["id"] == 5)
        self.assertEqual((manual["label"], manual["unit_cost"]), ("Manual packing provision", 12))
        self.assertGreater(editable["selling_price"], 1000)

        locked = self.store.sheets[1]
        self.assertEqual((locked["defect_allowance_pct"], locked["cost_per_minute"]),
                         (4.0, 22.71))
        self.assertEqual(len(self.store.history), 2)
        self.assertTrue(all(row["action"] == "preprod_defaults_backfill"
                            for row in self.store.history))
        self.assertTrue(any(row["snapshot"]["approved_sheet"] for row in self.store.history))

        main = self.store.sheets[2]
        self.assertEqual((main["defect_allowance_pct"], main["cost_per_minute"]),
                         (10, 5))
        self.assertEqual(next(line for line in self.store.lines if line["id"] == 10)["unit_cost"], 5)

    def test_rerun_is_idempotent(self):
        first = fr._preprod_defaults_backfill(self.conn, "admin", "Admin")
        before = (copy.deepcopy(self.store.sheets), copy.deepcopy(self.store.lines),
                  copy.deepcopy(self.store.history))
        second = fr._preprod_defaults_backfill(self.conn, "admin", "Admin")
        self.assertEqual(first["updated"], 2)
        self.assertEqual(second["updated"], 0)
        self.assertEqual(second["skipped"], 2)
        self.assertEqual((self.store.sheets, self.store.lines, self.store.history), before)

    def test_maintenance_route_requires_an_admin(self):
        request = SimpleNamespace(
            state=SimpleNamespace(user={"role": "viewer", "user_id": "viewer"}))
        with self.assertRaises(HTTPException) as ctx:
            fr.costing_backfill_preprod_defaults(request)
        self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()