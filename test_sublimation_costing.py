"""Regression tests for the Sublimation Printing costing model (fabric_router).

Anchors come from the worked example in the "Vivo Sublimation Printing Costing
→ Odoo BOM" template (attached_assets): 311.8 m of a 1.49 m-wide / 140 gsm
fabric, 1 cm print margin per side, 5 h 13 min machine time, ink 2.75 KES/ml
with a 60×60 cm tile reading C/Y/M/K = 0.01/0.13/0.09/0.02 ml, papers
69.76 + 17.81 KES/m, 5% reprint allowance, greige 268.8 KES/m.

Two invariants this file exists to protect:
1. The Odoo BOM's operation time uses the SETTABLE standard throughput
   (default 60 m/hr) — never the run's actual rate, which is variance only.
2. The server recomputes every derived column on save (_sublim_prepare);
   client-sent totals are ignored, so a stored row always matches its inputs.
"""
import json
import re
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr

WORKED = dict(
    fabric_name="SHOWME Polyester 18206",
    fabric_barcode="18206",
    fabric_width_m=1.49,
    fabric_gsm=140,
    metres_printed=311.8,
    machine_time_h=5,
    machine_time_min=13,
    ink_cost_per_ml=2.75,
    tile_width_cm=60,
    tile_height_cm=60,
    ink_cyan_ml=0.01,
    ink_yellow_ml=0.13,
    ink_magenta_ml=0.09,
    ink_black_ml=0.02,
    sub_paper_cost_per_m=69.76,
    prot_paper_cost_per_m=17.81,
    reprint_pct=5,
    base_fabric_cost_per_m=268.8,
    print_margin_cm=1,
)


class RunCostingAnchors(unittest.TestCase):
    """The per-run costing must reproduce the template's worked example."""

    def setUp(self):
        self.c = fr._sublim_compute(dict(WORKED))

    def test_ink_paper_machine_subtotals(self):
        self.assertAlmostEqual(self.c["_ink_subtotal"], 875.3135417, delta=0.001)
        self.assertAlmostEqual(self.c["_paper_subtotal"], 27304.326, delta=0.001)
        self.assertAlmostEqual(self.c["_machine_conversion"], 26496.29192, delta=0.001)
        self.assertAlmostEqual(self.c["_printing_subtotal"], 54675.93147, delta=0.001)

    def test_totals_and_unit_costs(self):
        self.assertAlmostEqual(self.c["total_printing_cost"], 57409.72804, delta=0.001)
        self.assertAlmostEqual(self.c["printing_cost_per_m"], 184.1235665, delta=1e-5)
        self.assertAlmostEqual(self.c["printing_cost_per_kg"], 882.6633102, delta=1e-5)
        self.assertAlmostEqual(self.c["finished_cost_per_m"], 452.9235665, delta=1e-5)
        self.assertAlmostEqual(self.c["finished_cost_per_kg"], 2171.253914, delta=1e-5)


class BomStandardThroughput(unittest.TestCase):
    """BOM operation time runs at the settable standard, default 60 m/hr."""

    def test_default_standard_is_60(self):
        c = fr._sublim_compute(dict(WORKED))  # no std_throughput_m_hr sent
        self.assertAlmostEqual(c["_std_throughput_m_hr"], 60.0)
        # At exactly 60 m/hr, min/kg == metres/kg by construction.
        self.assertAlmostEqual(c["_operation_min_per_kg"], 4.793863854, delta=1e-6)
        self.assertAlmostEqual(c["_operation_min_per_kg"], c["_metres_per_kg"], delta=1e-9)
        self.assertAlmostEqual(c["_machine_cost_per_kg"], 405.81347, delta=0.001)
        self.assertAlmostEqual(c["_material_subtotal_per_kg"], 1721.847036, delta=0.001)
        self.assertAlmostEqual(c["_clean_std_cost_per_kg"], 2127.66051, delta=0.002)
        self.assertAlmostEqual(c["std_cost_per_kg"], 2169.614, delta=0.002)
        # Standard cost is deliberately decoupled from the run's finished /kg.
        self.assertNotAlmostEqual(
            c["std_cost_per_kg"], c["finished_cost_per_kg"], delta=1.0)

    def test_standard_ignores_machine_time_entirely(self):
        base = fr._sublim_compute(dict(WORKED))
        slow = fr._sublim_compute({**WORKED, "machine_time_h": 99, "machine_time_min": 0})
        self.assertAlmostEqual(
            slow["std_cost_per_kg"], base["std_cost_per_kg"], delta=1e-9)
        self.assertAlmostEqual(
            slow["_operation_min_per_kg"], base["_operation_min_per_kg"], delta=1e-9)
        # ...while the run costing does move with machine time.
        self.assertGreater(
            slow["total_printing_cost"], base["total_printing_cost"])

    def test_settable_standard_reproduces_template_workcentre(self):
        # The template sheet happened to derive its work-centre figures at the
        # run's actual rate (59.76996805 m/hr). Feeding that as the SETTABLE
        # standard must reproduce those figures exactly.
        c = fr._sublim_compute({**WORKED, "std_throughput_m_hr": 59.76996805})
        self.assertAlmostEqual(c["_operation_min_per_kg"], 4.812313619, delta=1e-6)
        self.assertAlmostEqual(c["_machine_cost_per_kg"], 407.3752923, delta=0.001)
        self.assertAlmostEqual(c["_clean_std_cost_per_kg"], 2129.222328, delta=0.001)
        self.assertAlmostEqual(c["std_cost_per_kg"], 2171.253914, delta=0.001)

    def test_zero_or_missing_standard_falls_back_to_60(self):
        for bad in (0, -5, None, ""):
            c = fr._sublim_compute({**WORKED, "std_throughput_m_hr": bad})
            self.assertAlmostEqual(c["_std_throughput_m_hr"], 60.0,
                                   msg=f"std_throughput_m_hr={bad!r}")

    def test_reprint_applies_to_printing_lines_only(self):
        c = fr._sublim_compute(dict(WORKED))
        bom_base = WORKED["base_fabric_cost_per_m"] * c["_metres_per_kg"]
        expect = bom_base + (c["_clean_std_cost_per_kg"] - bom_base) * 1.05
        self.assertAlmostEqual(c["std_cost_per_kg"], expect, delta=1e-9)

    def test_actual_throughput_reported_as_variance(self):
        c = fr._sublim_compute(dict(WORKED))
        self.assertAlmostEqual(c["_actual_throughput_m_hr"], 59.76996805, delta=1e-6)


class SavedCostIntegrity(unittest.TestCase):
    """POST persists _sublim_prepare's output — client totals can't poison it."""

    def test_prepare_ignores_client_supplied_totals(self):
        body = {
            **WORKED,
            # Hostile/buggy client values in every derived column:
            "total_printing_cost": 1.0,
            "printing_cost_per_m": -5,
            "printing_cost_per_kg": 0,
            "finished_cost_per_m": 123456,
            "finished_cost_per_kg": "garbage",  # not even numeric — ignored
            "std_cost_per_kg": 999999.0,
        }
        vals = fr._sublim_prepare(body)
        self.assertAlmostEqual(vals["total_printing_cost"], 57409.72804, delta=0.001)
        self.assertAlmostEqual(vals["printing_cost_per_m"], 184.1235665, delta=1e-5)
        self.assertAlmostEqual(vals["finished_cost_per_kg"], 2171.253914, delta=1e-5)
        self.assertAlmostEqual(vals["std_cost_per_kg"], 2169.614, delta=0.002)
        self.assertAlmostEqual(vals["std_throughput_m_hr"], 60.0)

    def test_prepare_persists_the_effective_standard(self):
        vals = fr._sublim_prepare({**WORKED, "std_throughput_m_hr": 55})
        self.assertAlmostEqual(vals["std_throughput_m_hr"], 55.0)
        self.assertAlmostEqual(
            vals["std_cost_per_kg"],
            fr._sublim_compute({**WORKED, "std_throughput_m_hr": 55})["std_cost_per_kg"],
            delta=1e-9)

    def test_prepare_preserves_final_product_labels(self):
        vals = fr._sublim_prepare({
            **WORKED,
            "final_product_name": "Printed Satin Dress Fabric",
            "final_fabric_barcode": "PF-00123",
        })
        self.assertEqual(vals["final_product_name"], "Printed Satin Dress Fabric")
        self.assertEqual(vals["final_fabric_barcode"], "PF-00123")

    def test_validation_rejects_bad_input(self):
        with self.assertRaises(HTTPException) as ctx:
            fr._sublim_prepare({**WORKED, "fabric_name": ""})
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            fr._sublim_prepare({**WORKED, "metres_printed": 0})
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            fr._sublim_prepare({**WORKED, "fabric_gsm": "abc"})
        self.assertEqual(ctx.exception.status_code, 400)


class SavedCostLibraryPagination(unittest.TestCase):
    """The full library remains reachable in stable newest-first pages."""

    def _list(self, page=1, page_size=25, total=57):
        calls = []

        def fake_q(_conn, sql, params=()):
            compact = " ".join(sql.split())
            calls.append((compact, params))
            if "COUNT(*)" in compact:
                return [{"total": total}]
            offset = params[1]
            return [{"id": total - offset - i, "saved_at": "2026-08-01"}
                    for i in range(min(params[0], max(0, total - offset)))]

        request = SimpleNamespace(state=SimpleNamespace(user={}))
        conn = mock.MagicMock()
        conn.__enter__.return_value = conn
        with mock.patch.object(fr, "_get_conn", return_value=conn), \
             mock.patch.object(fr, "_ensure_sublimation_tables"), \
             mock.patch.object(fr, "q", side_effect=fake_q), \
             mock.patch.object(fr, "_sublim_enrich_row", side_effect=lambda r: r):
            result = fr.sublimation_costings_list(
                request, page=page, page_size=page_size)
        return result, calls

    def test_page_metadata_and_deterministic_order(self):
        result, calls = self._list(page=2, page_size=25)
        self.assertEqual(result["total"], 57)
        self.assertEqual(result["page"], 2)
        self.assertEqual(result["total_pages"], 3)
        self.assertEqual([row["id"] for row in result["items"]],
                         list(range(32, 7, -1)))
        self.assertIn("ORDER BY saved_at DESC, id DESC", calls[1][0])
        self.assertEqual(calls[1][1], (25, 25))

    def test_requested_page_past_end_is_clamped(self):
        result, calls = self._list(page=99, page_size=25)
        self.assertEqual(result["page"], 3)
        self.assertEqual([row["id"] for row in result["items"]],
                         list(range(7, 0, -1)))
        self.assertEqual(calls[1][1], (25, 50))

    def test_older_product_is_retrievable_without_skips(self):
        result, _ = self._list(page=3, page_size=20, total=41)
        result["items"][0]["fabric_product_id"] = 120000058
        self.assertEqual(result["items"][0]["id"], 1)
        self.assertEqual(result["items"][0]["fabric_product_id"], 120000058)


class SavedCostRevisionRules(unittest.TestCase):
    """Saved-library edits keep identity/original metadata and write revisions."""

    def test_only_bedan_can_edit_existing_costings(self):
        self.assertTrue(fr._sublimation_can_edit(
            {"email": "Bedan@vivofashiongroup.com"}))
        self.assertFalse(fr._sublimation_can_edit(
            {"email": "another.user@vivofashiongroup.com"}))
        self.assertFalse(fr._sublimation_can_edit({}))

    def test_change_summary_is_readable_and_snapshot_is_server_owned(self):
        before = {**fr._sublim_prepare(WORKED), "id": 8, "saved_by": "Original",
                  "client_only": "must not be audited"}
        after = {**before, "metres_printed": 420.0,
                 "total_printing_cost": 123.0}
        summary = fr._sublim_change_summary(before, after)
        self.assertIn("metres printed", summary)
        self.assertNotIn("total_printing_cost", summary)
        snapshot = fr._sublim_snapshot(before)
        self.assertNotIn("client_only", snapshot)
        self.assertEqual(snapshot["id"], 8)
        self.assertIn("std_cost_per_kg", snapshot)

    def test_authorized_update_recalculates_and_audits_before_commit(self):
        store = _RevisionStore()
        conn = _RevisionConn(store)
        request = _revision_request("bedan@vivofashiongroup.com")
        body = {**WORKED, "metres_printed": 400,
                "total_printing_cost": 1, "std_cost_per_kg": 1}
        with mock.patch.object(fr, "_get_conn", lambda: conn), \
             mock.patch.object(fr, "_ensure_sublimation_tables", lambda _c: None), \
             mock.patch.object(fr, "_log_fabric_change", lambda *a, **k: None):
            result = fr.sublimation_costing_update(8, request, body)

        self.assertEqual(result["id"], 8)
        self.assertEqual(len(store.rows), 1, "update must not create a duplicate row")
        self.assertEqual(store.row["saved_by"], "Original saver")
        self.assertEqual(store.row["saved_at"], "2026-08-01T09:00:00Z")
        self.assertEqual(store.row["last_edited_by"], "Bedan")
        self.assertAlmostEqual(
            float(store.row["total_printing_cost"]),
            fr._sublim_compute({**WORKED, "metres_printed": 400})["total_printing_cost"],
            delta=0.001)
        self.assertEqual(conn.commits, 1)
        self.assertEqual(len(store.history), 1)
        audit = store.history[0]
        self.assertEqual(audit["action"], "edited")
        self.assertIn("metres printed", audit["summary"])
        self.assertEqual(audit["before"]["metres_printed"], WORKED["metres_printed"])
        self.assertEqual(audit["after"]["metres_printed"], 400.0)

    def test_unauthorized_update_does_not_touch_saved_row(self):
        store = _RevisionStore()
        conn = _RevisionConn(store)
        with mock.patch.object(fr, "_get_conn", lambda: conn):
            with self.assertRaises(HTTPException) as ctx:
                fr.sublimation_costing_update(
                    8, _revision_request("not-bedan@vivofashiongroup.com"),
                    {**WORKED, "metres_printed": 400})
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(store.row["metres_printed"], WORKED["metres_printed"])
        self.assertEqual(store.history, [])
        self.assertEqual(conn.commits, 0)


class _RevisionStore:
    def __init__(self):
        self.row = {
            **fr._sublim_prepare(WORKED),
            "id": 8,
            "saved_at": "2026-08-01T09:00:00Z",
            "saved_by": "Original saver",
            "last_edited_at": None,
            "last_edited_by": None,
        }
        self.rows = [self.row]
        self.history = []


class _RevisionCursor:
    def __init__(self, store):
        self.store = store
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=()):
        compact = " ".join(sql.split())
        if compact.startswith("SELECT * FROM sublimation_costings"):
            self._result = dict(self.store.row)
            return
        if compact.startswith("UPDATE sublimation_costings SET"):
            columns = re.findall(r"([a-z_]+)=%s", compact)
            for column, value in zip(columns, params[:-1]):
                self.store.row[column] = value
            self._result = dict(self.store.row)
            return
        if compact.startswith("INSERT INTO sublimation_costing_history"):
            before = json.loads(params[5]) if params[5] else None
            after = json.loads(params[6]) if params[6] else None
            self.store.history.append({
                "costing_id": params[0], "action": params[1],
                "summary": params[4], "before": before, "after": after,
            })
            self._result = None
            return
        raise AssertionError(f"Unexpected revision SQL: {compact}")

    def fetchone(self):
        return self._result


class _RevisionConn:
    def __init__(self, store):
        self.store = store
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self, *args, **kwargs):
        return _RevisionCursor(self.store)

    def commit(self):
        self.commits += 1


def _revision_request(email):
    return SimpleNamespace(state=SimpleNamespace(user={
        "email": email, "user_id": "local:" + email, "name": "Bedan",
    }))


if __name__ == "__main__":
    unittest.main()
