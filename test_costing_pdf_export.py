"""Unit tests confirming the costing PDF export pipeline works end-to-end.

The PDF export route (GET /api/fabric/costing/sheets/{id}/export.pdf) converts
a ``_sheet_payload`` dict → ``_costing_to_build_data`` → ``build_sheet`` in
``artifacts/costing-pdf/costing.py``.  These tests call that pipeline with
synthetic fixture dicts — no live Postgres, no HTTP server — and assert:

* the output is a valid PDF byte string (``%PDF`` magic header);
* both an **unsigned** sheet and a **fully-signed** (all 3 signoffs) sheet
  export without error;
* ``_costing_to_build_data`` maps the ``_sheet_payload`` shape correctly
  (groups, signoff status, order-qty extraction from the CMT source field).

Run with the stdlib test path (no pytest required)::

    python -m unittest test_costing_pdf_export
"""
import unittest

import fabric_router as fr


# ─────────────────────────────────────────────────────────────────────────────
# Shared fixture helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_signoffs(signed_count: int) -> list:
    """Return 3 signoff dicts shaped like ``_costing_signoff_rows`` output.
    ``signed_count`` of them (0, 1, 2, or 3) are marked signed."""
    defaults = {
        1: "Prepared by",
        2: "Checked by",
        3: "Approved by",
    }
    names = ["Bedan Mwaura", "Amina Hassan", "James Kuria"]
    out = []
    for step in (1, 2, 3):
        signed = step <= signed_count
        out.append({
            "step": step,
            "title": defaults[step],
            "signed": signed,
            "signed_by": f"user{step}" if signed else None,
            "signed_by_name": names[step - 1] if signed else None,
            "signed_at": f"2026-07-{20 + step}T10:00:00+03:00" if signed else None,
        })
    return out


def _make_history(n: int = 2) -> list:
    """Return ``n`` history rows shaped like ``_sheet_payload``'s history list."""
    return [
        {
            "action": "created" if i == 0 else "edited",
            "changed_by_name": "Bedan Mwaura",
            "changed_at": f"2026-07-2{i}T08:{i:02d}:00+03:00",
            "summary": "sheet created" if i == 0 else "line edited",
        }
        for i in range(n)
    ]


def _acc_meta(**over) -> dict:
    """Accessories % provenance meta as persisted at sheet creation."""
    meta = {
        "pct": 8.981039134139472, "source_month": "2026-07",
        "month_label": "Jul 2026", "dps_count": 75,
        "fallback": False, "is_default": False,
        "requested_month": "2026-07", "requested_month_label": "Jul 2026",
        "picked_at": "2026-08-08T10:00:00+03:00",
    }
    meta.update(over)
    return meta


def _base_sheet(**overrides) -> dict:
    """Minimal ``_sheet_payload``-shaped dict that produces a renderable PDF."""
    sheet = {
        "style_name":    "Test Blouse in Crepe",
        "style_number":  "V1025999",
        "selling_price": 3900.0,
        "dps_ref":       "DPS00001",
        "color":         "Navy Blue",
        "notes":         "",
        "lines": [
            {
                "kind":      "fabric",
                "label":     "Main fabric — crepe navy (m/garment)",
                "qty":       1.30,
                "unit_cost": 350.00,
                "total":     455.00,
                "barcode":   "302001",
                "source":    None,
                "is_auto":   True,
                "position":  1,
                "component_id": 1,
            },
            {
                "kind":      "trim",
                "label":     "Care label (pcs/garment)",
                "qty":       1.0,
                "unit_cost": 0.20,
                "total":     0.20,
                "barcode":   "305001",
                "source":    None,
                "is_auto":   False,
                "position":  2,
                "component_id": 2,
            },
            {
                "kind":      "cmt",
                "label":     "CMT labour — actual DPS",
                "qty":       1.0,
                "unit_cost": 400.00,
                "total":     400.00,
                "barcode":   None,
                # order_qty extractor reads this field
                "source":    "Total DPS labour ÷ 100 garments",
                "is_auto":   True,
                "position":  3,
                "component_id": None,
            },
        ],
        "signoffs": _make_signoffs(0),
        "history":  _make_history(2),
    }
    sheet.update(overrides)
    return sheet


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

class CostingPdfBuildData(unittest.TestCase):
    """Unit tests for the adapter layer ``_costing_to_build_data``."""

    def test_groups_mapped_correctly(self):
        s = _base_sheet()
        d = fr._costing_to_build_data(s)
        labels = [g["label"] for g in d["groups"]]
        self.assertIn("Fabric", labels)
        self.assertIn("Trims and accessories", labels)
        self.assertIn("CMT / labour", labels)

    def test_order_qty_extracted_from_cmt_source(self):
        s = _base_sheet()
        d = fr._costing_to_build_data(s)
        self.assertEqual(d["order_qty"], 100,
                         "order_qty must be parsed from the CMT source field")

    def test_order_qty_defaults_to_1_when_no_cmt(self):
        s = _base_sheet()
        s["lines"] = [ln for ln in s["lines"] if ln["kind"] != "cmt"]
        d = fr._costing_to_build_data(s)
        self.assertEqual(d["order_qty"], 1)

    def test_unsigned_signoffs_produce_none_name(self):
        s = _base_sheet(signoffs=_make_signoffs(0))
        d = fr._costing_to_build_data(s)
        for so in d["signoffs"]:
            self.assertIsNone(so["name"],
                              "unsigned signoff must have name=None")
            self.assertIsNone(so["signed_at"])

    def test_full_signoffs_produce_names(self):
        s = _base_sheet(signoffs=_make_signoffs(3))
        d = fr._costing_to_build_data(s)
        for so in d["signoffs"]:
            self.assertIsNotNone(so["name"],
                                 "every step in a fully-signed sheet must have a name")

    def test_retail_price_forwarded(self):
        s = _base_sheet()
        d = fr._costing_to_build_data(s)
        self.assertAlmostEqual(d["retail_incl_vat"], 3900.0)

    def test_missing_lines_omitted_from_groups(self):
        """A sheet with no trim lines must not include a Trims group."""
        s = _base_sheet()
        s["lines"] = [ln for ln in s["lines"] if ln["kind"] != "trim"]
        d = fr._costing_to_build_data(s)
        labels = [g["label"] for g in d["groups"]]
        self.assertNotIn("Trims and accessories", labels)

    def test_unit_suffix_stripped_from_label(self):
        s = _base_sheet()
        d = fr._costing_to_build_data(s)
        fabric_lines = next(
            g["lines"] for g in d["groups"] if g["label"] == "Fabric"
        )
        # "(m/garment)" suffix must be removed from the fabric line description
        self.assertNotIn("/garment", fabric_lines[0]["desc"])


class CostingPdfUnsigned(unittest.TestCase):
    """End-to-end: unsigned sheet renders a valid PDF."""

    @classmethod
    def setUpClass(cls):
        s = _base_sheet(signoffs=_make_signoffs(0))
        cls.pdf_bytes = fr._costing_build_pdf(s)

    def test_returns_bytes(self):
        self.assertIsInstance(self.pdf_bytes, bytes)

    def test_valid_pdf_magic(self):
        self.assertTrue(
            self.pdf_bytes.startswith(b"%PDF"),
            "Response must begin with the PDF magic bytes %%PDF",
        )

    def test_non_empty(self):
        self.assertGreater(len(self.pdf_bytes), 1024,
                           "PDF must be larger than 1 KB")


class CostingPdfFullySigned(unittest.TestCase):
    """End-to-end: fully-signed sheet (all 3 signoffs) renders a valid PDF."""

    @classmethod
    def setUpClass(cls):
        s = _base_sheet(signoffs=_make_signoffs(3))
        cls.pdf_bytes = fr._costing_build_pdf(s)

    def test_returns_bytes(self):
        self.assertIsInstance(self.pdf_bytes, bytes)

    def test_valid_pdf_magic(self):
        self.assertTrue(
            self.pdf_bytes.startswith(b"%PDF"),
            "Response must begin with the PDF magic bytes %%PDF",
        )

    def test_non_empty(self):
        self.assertGreater(len(self.pdf_bytes), 1024,
                           "PDF must be larger than 1 KB")


class CostingPdfPartialSignoff(unittest.TestCase):
    """End-to-end: partially-signed sheet (1 of 3 signoffs) renders a valid PDF."""

    @classmethod
    def setUpClass(cls):
        s = _base_sheet(signoffs=_make_signoffs(1))
        cls.pdf_bytes = fr._costing_build_pdf(s)

    def test_valid_pdf_magic(self):
        self.assertTrue(self.pdf_bytes.startswith(b"%PDF"))


class CostingPdfEdgeCases(unittest.TestCase):
    """Edge-case fixtures that have caused silent failures in the past."""

    def test_zero_selling_price_raises_value_error(self):
        """A sheet with selling_price=0 violates the accounting identity
        (cogs_pc + margin_pc = 0 ≠ 100), so _derive raises ValueError.
        The export endpoint wraps this as HTTP 500; here we just confirm the
        error is raised rather than silently producing a corrupt PDF."""
        s = _base_sheet(selling_price=0.0)
        with self.assertRaises(ValueError):
            fr._costing_build_pdf(s)

    def test_no_history_rows(self):
        """Sheets with an empty history list render without error."""
        s = _base_sheet(history=[])
        pdf = fr._costing_build_pdf(s)
        self.assertTrue(pdf.startswith(b"%PDF"))

    def test_missing_barcode_on_fabric_line(self):
        """A fabric line whose barcode is None must not crash the renderer."""
        s = _base_sheet()
        for ln in s["lines"]:
            if ln["kind"] == "fabric":
                ln["barcode"] = None
        pdf = fr._costing_build_pdf(s)
        self.assertTrue(pdf.startswith(b"%PDF"))

    def test_notes_field_forwarded_as_basis_note(self):
        """When the sheet has a notes field, it should be used as basis_note
        (not the auto-generated fallback)."""
        custom_note = "Custom basis note for testing."
        s = _base_sheet(notes=custom_note)
        d = fr._costing_to_build_data(s)
        self.assertEqual(d["basis_note"], custom_note)

    def test_preprod_basis_note_quotes_sheet_multiplier(self):
        """The pre-production fallback basis note must quote the sheet's OWN
        Production Multiplier, not a fixed ×1.40."""
        s = _base_sheet(notes="", stage="pre_production",
                        production_multiplier=1.55)
        d = fr._costing_to_build_data(s)
        self.assertIn("\u00d71.55 efficiency factor", d["basis_note"])
        self.assertNotIn("1.40", d["basis_note"])

    def test_preprod_basis_note_falls_back_to_140_for_legacy_sheets(self):
        """Sheets saved before the field existed (NULL multiplier) used the
        then-hardcoded 1.40 — the note must say so."""
        s = _base_sheet(notes="", stage="pre_production",
                        production_multiplier=None)
        d = fr._costing_to_build_data(s)
        self.assertIn("\u00d71.40 efficiency factor", d["basis_note"])


class CostingPdfAccessoriesProvenance(unittest.TestCase):
    """The auto-picked Accessories % must reach the PDF with full provenance
    (source month, DPS count, fallback note) — while legacy sheets' wording
    stays byte-identical to what they always exported."""

    def test_generated_note_carries_month_and_dps_count(self):
        s = _base_sheet(notes="", stage="pre_production",
                        production_multiplier=1.55,
                        accessories_pct=8.981039134139472,
                        accessories_pct_meta=_acc_meta())
        d = fr._costing_to_build_data(s)
        self.assertIn(
            "Accessories are 8.98% of fabric cost — the Jul 2026 "
            "Done-DPS average (75 DPS), picked at sheet creation.",
            d["basis_note"])
        self.assertNotIn("Fallback month", d["basis_note"])

    def test_generated_note_fallback_month(self):
        s = _base_sheet(notes="", stage="pre_production",
                        accessories_pct=11.52,
                        accessories_pct_meta=_acc_meta(
                            pct=11.52, source_month="2026-06",
                            month_label="Jun 2026", dps_count=45,
                            fallback=True))
        d = fr._costing_to_build_data(s)
        self.assertIn("the Jun 2026 Done-DPS average (45 DPS)",
                      d["basis_note"])
        self.assertIn("Fallback month: Jul 2026 had no qualifying Done DPS.",
                      d["basis_note"])

    def test_generated_note_labelled_default(self):
        s = _base_sheet(notes="", stage="pre_production",
                        accessories_pct=13,
                        accessories_pct_meta=_acc_meta(
                            pct=13.0, source_month=None, month_label=None,
                            dps_count=0, is_default=True))
        d = fr._costing_to_build_data(s)
        self.assertIn(
            "Accessories are 13% of fabric cost — the standard default "
            "(no month with qualifying Done-DPS data), picked at sheet "
            "creation.", d["basis_note"])

    def test_legacy_generated_note_byte_identical(self):
        """Pre-auto-pick sheets (no meta) must export the exact wording they
        always had — approved/locked PDFs cannot change."""
        s = _base_sheet(notes="", stage="pre_production",
                        production_multiplier=None)
        d = fr._costing_to_build_data(s)
        self.assertEqual(
            d["basis_note"],
            "Pre-production estimate. Fabric cost is metres per garment × "
            "master cost/metre. Accessories are calculated as a percentage "
            "of fabric cost. CMT is derived from start/stop time × "
            "cost-per-minute rate with a ×1.40 efficiency factor. Defect "
            "allowance is a percentage of fabric cost. Retail price is a "
            "target to achieve 70% margin ex-VAT.")

    def test_custom_notes_get_provenance_appended(self):
        s = _base_sheet(notes="Hand-written basis note.",
                        stage="pre_production",
                        accessories_pct=8.981039134139472,
                        accessories_pct_meta=_acc_meta())
        d = fr._costing_to_build_data(s)
        self.assertTrue(d["basis_note"].startswith("Hand-written basis note."))
        self.assertIn("Jul 2026 Done-DPS average (75 DPS)", d["basis_note"])

    def test_custom_notes_without_meta_untouched(self):
        s = _base_sheet(notes="Hand-written basis note.",
                        stage="pre_production")
        d = fr._costing_to_build_data(s)
        self.assertEqual(d["basis_note"], "Hand-written basis note.")

    def test_pdf_renders_with_provenance_meta(self):
        s = _base_sheet(notes="", stage="pre_production",
                        selling_price=3900.0,
                        accessories_pct=8.981039134139472,
                        accessories_pct_meta=_acc_meta())
        pdf = fr._costing_build_pdf(s)
        self.assertTrue(pdf.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
