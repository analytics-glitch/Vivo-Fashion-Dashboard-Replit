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
import unittest

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


if __name__ == "__main__":
    unittest.main()
