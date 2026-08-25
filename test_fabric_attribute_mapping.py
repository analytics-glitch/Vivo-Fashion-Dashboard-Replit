"""Regression tests for the Fabric Odoo attribute-mapping layer.

The live catalogue legitimately exposes TWO fields with the display label
"GSM": the dedicated attribute (many2one → vivo.product.attribute.value) and a
plain-text twin. That valid configuration used to make resolve_fabric_fields()
raise "ambiguous", killing every Fabric product sync. These tests pin the
repaired contract:

* the resolver returns ORDERED candidate lists (dedicated attribute first,
  free text last) instead of failing on duplicate labels;
* genuinely indistinguishable primaries (same label AND same type rank) and
  missing conversion-critical concepts still fail safely BEFORE any
  search_read/TRUNCATE — the last known-good master is never blanked;
* the per-product picker uses the attribute value when populated and only
  falls back to usable text values; numeric display values are normalised
  (units, decimal commas, Odoo's False-means-empty) and non-positive or
  unreadable readings are rejected rather than silently derived from;
* a change in the selected sources triggers ONE full product reconciliation
  (via the fabric_sync_state fingerprint) so rows whose Odoo write_date
  predates the fix are repaired without waiting for edits in Odoo;
* the approved conversion stays Width (m) × GSM ÷ 1000 (kg_per_mtr_eff).

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_fabric_attribute_mapping
"""
import os
import unittest
from datetime import datetime
from unittest import mock

import extract_fabric as ef


def _meta(**fields):
    """name -> (label, type) convenience builder for fields_get payloads."""
    return {name: {"string": label, "type": ftype}
            for name, (label, ftype) in fields.items()}


def _required_meta(**extra):
    """Metadata carrying the two conversion-critical concepts + extras."""
    meta = _meta(
        x_width=("Width (m)", "many2one"),
        x_gsm_attr=("GSM", "many2one"),
    )
    meta.update(extra)
    return meta


def _reference_backed_meta(**extra):
    """Live-style metadata: direct fields win, related-reference fields fill gaps."""
    meta = _meta(
        x_width=("Width (m)", "many2one"),
        x_gsm_attr=("GSM", "many2one"),
        x_width_from_ref=("Width (m) - From Fabric Reference", "many2one"),
        x_gsm_from_ref=("GSM - From Fabric Reference", "many2one"),
    )
    meta.update(extra)
    return meta


class ResolverOrderingTests(unittest.TestCase):
    def test_duplicate_gsm_label_orders_attribute_before_text(self):
        # The exact live configuration that used to abort the whole sync.
        meta = _required_meta(x_gsm_text={"string": "GSM", "type": "char"})
        resolved = ef.resolve_fabric_fields(meta)
        self.assertEqual(resolved["gsm"], ["x_gsm_attr", "x_gsm_text"])
        self.assertEqual(resolved["width_m"], ["x_width"])

    def test_type_rank_orders_attribute_float_then_text(self):
        meta = _required_meta(
            x_gsm_text={"string": "GSM", "type": "char"},
            x_gsm_float={"string": "GSM", "type": "float"},
        )
        resolved = ef.resolve_fabric_fields(meta)
        self.assertEqual(resolved["gsm"],
                         ["x_gsm_attr", "x_gsm_float", "x_gsm_text"])

    def test_moved_field_ids_resolve_by_business_label(self):
        # Studio renumbering the x_* ids must not matter — labels drive it.
        meta = _meta(
            x_vivo_attr_250=("Width (m)", "many2one"),
            x_vivo_attr_138=("GSM", "many2one"),
        )
        resolved = ef.resolve_fabric_fields(meta)
        self.assertEqual(resolved["width_m"], ["x_vivo_attr_250"])
        self.assertEqual(resolved["gsm"], ["x_vivo_attr_138"])

    def test_reference_backed_width_and_gsm_are_ordered_fallbacks(self):
        # Odoo also exposes related values with a "From Fabric Reference"
        # suffix. They are a supported fallback when the legacy direct fields
        # are empty, not a competing primary source.
        resolved = ef.resolve_fabric_fields(_reference_backed_meta())
        self.assertEqual(resolved["width_m"],
                         ["x_width", "x_width_from_ref"])
        self.assertEqual(resolved["gsm"],
                         ["x_gsm_attr", "x_gsm_from_ref"])

    def test_direct_field_outranks_a_better_typed_reference_fallback(self):
        # Direct aliases express the business-source precedence; type rank only
        # resolves duplicate fields under one label. A direct char must not be
        # displaced by a reference-backed many2one.
        meta = _reference_backed_meta(
            x_width={"string": "Width (m)", "type": "char"},
            x_gsm_attr={"string": "GSM", "type": "char"},
        )
        resolved = ef.resolve_fabric_fields(meta)
        self.assertEqual(resolved["width_m"],
                         ["x_width", "x_width_from_ref"])
        self.assertEqual(resolved["gsm"],
                         ["x_gsm_attr", "x_gsm_from_ref"])

    def test_two_same_type_primaries_still_fail_safe(self):
        # Two many2one fields labelled GSM are genuinely indistinguishable:
        # picking one would be a guess, so the extract must refuse to run.
        meta = _required_meta(x_gsm_attr2={"string": "GSM", "type": "many2one"})
        with self.assertRaisesRegex(RuntimeError, r"gsm.*ambiguous"):
            ef.resolve_fabric_fields(meta)

    def test_case_variant_width_twins_same_type_still_fail_safe(self):
        # "Width (m)" vs "Width (M)" normalise to one label; same type rank
        # ⇒ still ambiguous (the pre-repair regression case, preserved).
        meta = _meta(
            x_w1=("Width (m)", "many2one"),
            x_w2=("Width (M)", "many2one"),
            x_gsm_attr=("GSM", "many2one"),
        )
        with self.assertRaisesRegex(RuntimeError, r"width_m.*ambiguous"):
            ef.resolve_fabric_fields(meta)

    def test_text_tier_tie_after_clean_primary_keeps_primary(self):
        # An indistinguishable FALLBACK tier must not block the sync — the
        # clean primary is kept and the tied text twins are dropped.
        meta = _required_meta(
            x_t1={"string": "GSM", "type": "char"},
            x_t2={"string": "GSM", "type": "char"},
        )
        resolved = ef.resolve_fabric_fields(meta)
        self.assertEqual(resolved["gsm"], ["x_gsm_attr"])

    def test_missing_required_concept_raises(self):
        meta = _meta(x_width=("Width (m)", "many2one"))
        with self.assertRaisesRegex(RuntimeError, r"gsm.*missing"):
            ef.resolve_fabric_fields(meta)

    def test_optional_duplicate_same_rank_is_skipped_not_fatal(self):
        meta = _required_meta(
            x_p1={"string": "Plain/Print", "type": "char"},
            x_p2={"string": "Plain/Print", "type": "char"},
        )
        resolved = ef.resolve_fabric_fields(meta)  # must not raise
        self.assertNotIn("plain_print", resolved)

    def test_optional_concept_also_gets_ordered_candidates(self):
        meta = _required_meta(
            x_kg_attr={"string": "Kg/Mtr", "type": "many2one"},
            x_kg_text={"string": "Kg/Mtr", "type": "char"},
        )
        resolved = ef.resolve_fabric_fields(meta)
        self.assertEqual(resolved["kg_per_mtr"], ["x_kg_attr", "x_kg_text"])


class NormalizeNumericTests(unittest.TestCase):
    def test_accepted_values(self):
        cases = {
            "157": 157.0,
            "1.70": 1.7,
            " 157 gsm ": 157.0,
            "157GSM": 157.0,
            "1.70 m": 1.7,
            "1,70": 1.7,          # decimal comma
            "1,250": 1250.0,      # thousands separator
            "1,234.5": 1234.5,
        }
        for raw, expected in cases.items():
            self.assertEqual(ef._normalize_numeric(raw), expected, msg=raw)
        self.assertEqual(ef._normalize_numeric(157), 157.0)
        self.assertEqual(ef._normalize_numeric(1.7), 1.7)

    def test_rejected_values_return_none(self):
        rejected = ["abc", "N/A", "", "  ", "0", "0.0", "-3", "150 cm",
                    "1.7.0", "Width TBC", "12%", False, True, None, 0, 0.0,
                    -2, float("nan"), float("inf")]
        for raw in rejected:
            self.assertIsNone(ef._normalize_numeric(raw), msg=repr(raw))

    def test_boolean_false_is_empty_not_zero(self):
        # Odoo marshals empty fields as False; float(False) == 0.0 used to
        # slip through as a real reading. It must be treated as ABSENT.
        self.assertIsNone(ef._fabric_value({"x": False}, "x", numeric=True))
        self.assertIsNone(ef._fabric_value({"x": False}, "x"))


class PickerTests(unittest.TestCase):
    CANDS = ["x_gsm_attr", "x_gsm_text"]

    def test_populated_attribute_wins_over_text(self):
        rec = {"x_gsm_attr": [9, "185"], "x_gsm_text": "157"}
        self.assertEqual(ef._fabric_value_from(rec, self.CANDS, numeric=True),
                         (185.0, "x_gsm_attr"))

    def test_empty_attribute_falls_back_to_text(self):
        rec = {"x_gsm_attr": False, "x_gsm_text": "157"}
        self.assertEqual(ef._fabric_value_from(rec, self.CANDS, numeric=True),
                         (157.0, "x_gsm_text"))

    def test_zero_attribute_display_falls_through(self):
        rec = {"x_gsm_attr": [9, "0"], "x_gsm_text": "157"}
        self.assertEqual(ef._fabric_value_from(rec, self.CANDS, numeric=True),
                         (157.0, "x_gsm_text"))

    def test_unusable_fallback_text_yields_incomplete(self):
        rec = {"x_gsm_attr": False, "x_gsm_text": "tbc"}
        self.assertEqual(ef._fabric_value_from(rec, self.CANDS, numeric=True),
                         (None, None))

    def test_all_sources_empty(self):
        rec = {"x_gsm_attr": False, "x_gsm_text": False}
        self.assertEqual(ef._fabric_value_from(rec, self.CANDS, numeric=True),
                         (None, None))
        self.assertEqual(ef._fabric_value_from(rec, None, numeric=True),
                         (None, None))

    def test_non_numeric_picker_strips_and_falls_back(self):
        rec = {"x_a": False, "x_b": "  Plain  "}
        self.assertEqual(ef._fabric_value_from(rec, ["x_a", "x_b"]),
                         ("Plain", "x_b"))

    def test_reference_backed_values_clear_the_conversion_gap(self):
        # Shape of a variant whose direct fields are blank while Odoo supplies
        # valid values from its Fabric Reference record.
        rec = {
            "x_width": False,
            "x_gsm_attr": False,
            "x_width_from_ref": [64271, "1.70"],
            "x_gsm_from_ref": [64272, "157 GSM"],
        }
        meta = _reference_backed_meta()
        resolved = ef.resolve_fabric_fields(meta)
        width, _ = ef._fabric_value_from(
            rec, resolved["width_m"], numeric=True)
        gsm, _ = ef._fabric_value_from(rec, resolved["gsm"], numeric=True)
        self.assertEqual((width, gsm), (1.7, 157.0))
        self.assertEqual(round(width * gsm / 1000.0, 4), 0.2669)


class SignatureTests(unittest.TestCase):
    def test_signature_stable_across_dict_order(self):
        meta_a = _required_meta(x_gsm_text={"string": "GSM", "type": "char"})
        meta_b = dict(reversed(list(meta_a.items())))
        res_a, res_b = (ef.resolve_fabric_fields(m) for m in (meta_a, meta_b))
        self.assertEqual(ef.mapping_signature(res_a, meta_a),
                         ef.mapping_signature(res_b, meta_b))

    def test_signature_changes_when_a_source_appears(self):
        base = _required_meta()
        with_text = _required_meta(x_gsm_text={"string": "GSM", "type": "char"})
        self.assertNotEqual(
            ef.mapping_signature(ef.resolve_fabric_fields(base), base),
            ef.mapping_signature(ef.resolve_fabric_fields(with_text), with_text))

    def test_signature_changes_when_a_type_changes(self):
        self.assertNotEqual(
            ef.mapping_signature({"gsm": ["x"]}, {"x": {"type": "many2one"}}),
            ef.mapping_signature({"gsm": ["x"]}, {"x": {"type": "char"}}))

    def test_needs_full_reconcile_decision(self):
        self.assertTrue(ef._needs_full_reconcile(None, "sig"))   # first deploy
        self.assertTrue(ef._needs_full_reconcile("old", "new"))  # changed
        self.assertFalse(ef._needs_full_reconcile("sig", "sig"))  # steady state


# ─────────────────────────────────────────────────────────────────────────────
# extract_products() wiring: mapping-change → full reconciliation; unchanged
# mapping → incremental; empty full pull → refuse to truncate. Runs the REAL
# function against a fake cursor/models (no Postgres, no Odoo).
# ─────────────────────────────────────────────────────────────────────────────
class _StateCursor:
    """Records every statement; answers only the fabric_sync_state SELECT."""

    def __init__(self, stored_signature=None, incomplete_ids=(),
                 incomplete_cursor=None):
        self.stored_signature = stored_signature
        self.incomplete_ids = incomplete_ids
        self.incomplete_cursor = incomplete_cursor
        self.executed = []  # (normalised sql, params)
        self._last = None

    def execute(self, sql, params=None):
        norm = " ".join(str(sql).split()).lower()
        self.executed.append((norm, params))
        if norm.startswith("select value from fabric_sync_state"):
            key = (params or (None,))[0]
            value = (self.stored_signature if key == ef._MAPPING_STATE_KEY
                     else self.incomplete_cursor)
            self._last = ((value,) if value is not None else None)
        elif norm.startswith("select id from raw_fabric_products"):
            after_id, limit = params
            if "id > %s" in norm:
                selected = [pid for pid in self.incomplete_ids if pid > after_id]
            else:
                selected = [pid for pid in self.incomplete_ids if pid <= after_id]
            self._last = [(product_id,) for product_id in selected[:limit]]
        else:
            self._last = None

    def fetchone(self):
        return self._last

    def fetchall(self):
        return self._last or []

    def sqls(self):
        return [s for s, _ in self.executed]


class _FakeModels:
    def __init__(self, metadata, records):
        self.metadata = metadata
        self.records = records
        self.search_domains = []
        self.search_fields = []

    def execute_kw(self, db, uid, pwd, model, method, args, kwargs=None):
        if method == "fields_get":
            return self.metadata
        if method == "search_read":
            self.search_domains.append(args[0])
            self.search_fields.append((kwargs or {}).get("fields") or [])
            return self.records if (kwargs or {}).get("offset", 0) == 0 else []
        raise AssertionError(f"unexpected Odoo call {model}.{method}")


def _product_105433_record():
    """Reported barcode shape with reference-backed conversion values."""
    return {
        "id": 682430,
        "name": "AL SAWAE Tiktok Satin - Rose Pink/Brown Print",
        "default_code": False,
        "categ_id": [61, "Raw Materials / Fabric"],
        "uom_id": [5, "m"],
        "standard_price": 1390.1869,
        "active": True,
        "x_width": False,
        "x_gsm_attr": False,
        "x_width_from_ref": [64271, "1.70"],
        "x_gsm_from_ref": [64272, "157"],
        "barcode": "105433",
        "product_properties": [],
        "write_date": "2026-08-19 09:39:48",
    }


class ReconcileWiringTests(unittest.TestCase):
    NOW = datetime(2026, 8, 19, 12, 0, 0)
    SINCE = datetime(2026, 8, 19, 11, 0, 0)
    META = None  # set in setUp

    def setUp(self):
        self.meta = _reference_backed_meta()
        self.current_sig = ef.mapping_signature(
            ef.resolve_fabric_fields(self.meta), self.meta)
        self.captured = []

        def fake_execute_values(cur, sql, rows, page_size=200):
            self.captured.append((" ".join(sql.split()).lower(), list(rows)))

        patcher = mock.patch.object(ef, "execute_values", fake_execute_values)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, cur, records, since):
        models = _FakeModels(self.meta, records)
        ef.extract_products(1, models, cur, self.NOW, since=since)
        return models

    def _domain_has_write_date(self, domain):
        return any(isinstance(c, (list, tuple)) and c and c[0] == "write_date"
                   for c in domain)

    def _state_upserts(self, cur):
        return [(s, p) for s, p in cur.executed
                if s.startswith("insert into fabric_sync_state")]

    def test_mapping_change_promotes_incremental_to_full_reconcile(self):
        # No stored fingerprint (first run after the fix deploys): even though
        # the caller asked for an incremental pull, the extract must pull the
        # FULL catalogue so rows whose write_date predates the change repair.
        cur = _StateCursor(stored_signature=None)
        models = self._run(cur, [_product_105433_record()], since=self.SINCE)

        self.assertFalse(self._domain_has_write_date(models.search_domains[0]))
        self.assertTrue(any(s.startswith("truncate raw_fabric_products")
                            for s in cur.sqls()))
        # Both direct and Fabric-Reference-backed candidates were requested.
        self.assertIn("x_gsm_attr", models.search_fields[0])
        self.assertIn("x_gsm_from_ref", models.search_fields[0])
        # The row carries the repaired values from the reference fields and the
        # standard formula derives 0.2669.
        (_, rows), = self.captured
        row = rows[0]
        self.assertEqual(row[0], 682430)
        self.assertEqual(row[8], 1.7)     # width_m
        self.assertEqual(row[9], 157.0)   # gsm
        self.assertEqual(round(row[8] * row[9] / 1000.0, 4), 0.2669)
        # The new fingerprint is recorded in the SAME transaction as the rows.
        upserts = self._state_upserts(cur)
        self.assertEqual(len(upserts), 1)
        self.assertEqual(upserts[0][1][1], self.current_sig)

    def test_stored_signature_change_also_promotes(self):
        cur = _StateCursor(stored_signature='{"gsm":[["x_old","many2one"]]}')
        models = self._run(cur, [_product_105433_record()], since=self.SINCE)
        self.assertFalse(self._domain_has_write_date(models.search_domains[0]))
        self.assertTrue(any(s.startswith("truncate raw_fabric_products")
                            for s in cur.sqls()))

    def test_unchanged_mapping_stays_incremental(self):
        cur = _StateCursor(stored_signature=self.current_sig)
        models = self._run(cur, [_product_105433_record()], since=self.SINCE)

        self.assertTrue(self._domain_has_write_date(models.search_domains[0]))
        self.assertFalse(any(s.startswith("truncate") for s in cur.sqls()))
        # Freshness clock still advances for the whole table on incremental.
        self.assertTrue(any(
            s.startswith("update raw_fabric_products set _loaded_at")
            for s in cur.sqls()))
        self.assertEqual(len(self._state_upserts(cur)), 1)

    def test_incomplete_row_is_rechecked_without_a_new_write_date(self):
        # A related Fabric Reference edit does not always touch the variant's
        # write_date. The normal fast pull must still retrieve a currently
        # incomplete row and repair it as soon as the related values arrive.
        cur = _StateCursor(
            stored_signature=self.current_sig, incomplete_ids=[682430])
        models = self._run(cur, [_product_105433_record()], since=self.SINCE)

        domain = models.search_domains[0]
        self.assertIn(["id", "in", [682430]], domain)
        self.assertIn(["write_date", ">=", self.SINCE.strftime("%Y-%m-%d %H:%M:%S")],
                      domain)
        self.assertFalse(any(s.startswith("truncate") for s in cur.sqls()))
        (_, rows), = self.captured
        self.assertEqual(rows[0][23], "105433")
        self.assertEqual((rows[0][8], rows[0][9]), (1.7, 157.0))

    def test_incomplete_recheck_rotates_past_the_bounded_batch(self):
        # A Fabric master larger than the cap must not repeatedly starve rows
        # that sort after the oldest incomplete products.
        with mock.patch.object(ef, "_INCOMPLETE_RECHECK_LIMIT", 3):
            first = _StateCursor(
                incomplete_ids=[1, 2, 3, 4, 5, 6, 7],
                incomplete_cursor="3")
            ids, cursor = ef._incomplete_fabric_product_ids(first)
            self.assertEqual((ids, cursor), ([4, 5, 6], 6))

            wrapped = _StateCursor(
                incomplete_ids=[1, 2, 3, 4, 5, 6, 7],
                incomplete_cursor=str(cursor))
            ids, cursor = ef._incomplete_fabric_product_ids(wrapped)
            self.assertEqual((ids, cursor), ([7, 1, 2], 2))

    def test_full_pull_with_zero_records_never_truncates(self):
        cur = _StateCursor()
        with self.assertRaisesRegex(RuntimeError, r"refusing\s+to truncate"):
            self._run(cur, [], since=None)
        self.assertFalse(any(s.startswith("truncate") for s in cur.sqls()))
        self.assertEqual(self.captured, [])          # nothing written
        self.assertEqual(self._state_upserts(cur), [])  # fingerprint kept old

    def test_ambiguous_primary_aborts_before_any_table_write(self):
        self.meta["x_gsm_attr2"] = {"string": "GSM", "type": "many2one"}
        cur = _StateCursor()
        with self.assertRaisesRegex(RuntimeError, r"gsm.*ambiguous"):
            self._run(cur, [_product_105433_record()], since=None)
        self.assertFalse(any(s.startswith("truncate") for s in cur.sqls()))
        self.assertEqual(self.captured, [])
        self.assertEqual(self._state_upserts(cur), [])


class StandardFormulaPinTests(unittest.TestCase):
    """The approved conversion is Width (m) × GSM ÷ 1000 — pinned in the
    generated column DDL (extract) and the migration, and by the reported
    product's expected derived values."""

    EXPR = "width_m * gsm / 1000.0"

    def test_generated_column_expression_in_extract(self):
        with open(ef.__file__, "r") as f:
            self.assertIn(self.EXPR, f.read())

    def test_generated_column_expression_in_migration(self):
        path = os.path.join(os.path.dirname(os.path.abspath(ef.__file__)),
                            "migrations",
                            "004_fabric_kg_per_mtr_standard_formula.sql")
        with open(path, "r") as f:
            self.assertIn(self.EXPR, f.read())

    def test_reported_product_expected_values(self):
        width, gsm, standard_price = 1.70, 157.0, 1390.1869
        eff = round(width * gsm / 1000.0, 4)
        self.assertEqual(eff, 0.2669)
        # Cost per Metre keeps its existing basis: price per kg × kg per metre.
        self.assertAlmostEqual(standard_price * eff, 371.04, places=1)


if __name__ == "__main__":
    unittest.main()
