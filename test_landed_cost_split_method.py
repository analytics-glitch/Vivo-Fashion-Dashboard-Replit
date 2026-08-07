"""Unit tests pinning the Landed Cost Upload split-method rules.

The Landed Cost Upload form lets a buyer choose how each cost line is
distributed across the received products (Equal / By Quantity / By Current
Cost / By Weight / By Volume — or whatever a customised Odoo instance
offers). The rules enforced server-side in ``fabric_router``:

* the choices come LIVE from Odoo (``fields_get`` on
  ``stock.landed.cost.lines``), falling back to the standard five only when
  that call is blocked or malformed;
* the advertised default is ALWAYS one of the returned choices — the
  historical ``by_current_cost_price`` when the instance offers it, else the
  instance's first choice (so a customised selection that drops
  By Current Cost can never be defaulted to an unsupported value);
* on create, an absent/blank ``split_method`` (older or cached forms) takes
  that default, and every resulting value — defaulted or explicit — must be
  in the live allowed set, no exceptions: a bad value is a 400 naming the
  line and nothing is written to Odoo;
* each cost type's own default (product ``split_method_landed_cost``, name
  probed via ``fields_get`` since it varies by Odoo version) is surfaced per
  cost type, and values outside the live selection are dropped to None.

The tests call the REAL endpoint functions (``landed_cost_options`` /
``landed_cost_create``) against a mocked ``_lc_kw`` Odoo transport — no live
Odoo, no Postgres, no HTTP server: connection plumbing, PO lookup, audit and
change-log side effects are stubbed while the validation/default logic runs
unmodified.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_landed_cost_split_method
"""
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr


STD_SELECTION = [
    ["equal", "Equal"],
    ["by_quantity", "By Quantity"],
    ["by_current_cost_price", "By Current Cost"],
    ["by_weight", "By Weight"],
    ["by_volume", "By Volume"],
]
# A customised instance whose selection does NOT include by_current_cost_price.
CUSTOM_SELECTION = [
    ["by_container", "By Container"],
    ["by_carton", "By Carton"],
]

PO = {"po_id": 42, "name": "P0042", "supplier": "ACME", "state": "purchase",
      "date_order": "2026-08-01", "company_id": 1}
PICKINGS = [{"id": 900, "name": "WH/IN/900", "state": "done",
             "type": "Receipts", "date_done": None, "scheduled_date": None,
             "company_id": 1, "usable": True}]

DEFAULT_PRODUCTS = [
    {"id": 11, "display_name": "Freight", "landed_cost_ok": True,
     "split_method_landed_cost": "by_weight"},
    {"id": 12, "display_name": "Duty", "landed_cost_ok": True,
     "split_method_landed_cost": False},          # unset in Odoo
]
DEFAULT_JOURNALS = [
    {"id": 5, "name": "Miscellaneous Operations", "code": "MISC"}]


def make_lc_kw(selection=STD_SELECTION, product_field="split_method_landed_cost",
               products=None, journals=None, existing=None, created_id=777,
               calls=None):
    """Stand-in for fr._lc_kw covering every (model, method) pair the
    landed-cost endpoints use; records calls when given a list."""
    products = DEFAULT_PRODUCTS if products is None else products
    journals = DEFAULT_JOURNALS if journals is None else journals

    def fake(odoo, model, method, args, kw=None):
        if calls is not None:
            calls.append((model, method, args, kw))
        if model == "stock.landed.cost.lines" and method == "fields_get":
            return {"split_method": {"selection": selection}}
        if model == "product.product" and method == "fields_get":
            return ({product_field: {"type": "selection"}}
                    if product_field else {})
        if model == "product.product" and method == "search_read":
            return products
        if model == "account.journal" and method == "search_read":
            return journals
        if model == "stock.landed.cost" and method == "search_read":
            return existing or []
        if model == "stock.landed.cost" and method == "create":
            return created_id
        if model == "stock.landed.cost" and method == "read":
            return [{"name": "LC/TEST", "state": "draft", "amount_total": 0.0}]
        raise AssertionError(f"unexpected Odoo call {model}.{method}")

    return fake


class _FakeCursor:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **k):
        pass


class _FakeConn:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _FakeCursor()

    def commit(self):
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Helper-level rules
# ─────────────────────────────────────────────────────────────────────────────

class SplitMethodHelperTests(unittest.TestCase):

    def test_live_selection_is_used(self):
        with mock.patch.object(fr, "_lc_kw", make_lc_kw(CUSTOM_SELECTION)):
            out = fr._lc_split_methods(("db", 1, "pwd", None))
        self.assertEqual([s["value"] for s in out],
                         ["by_container", "by_carton"])
        self.assertEqual(out[0]["label"], "By Container")

    def test_blocked_fields_get_falls_back_to_standard_five(self):
        def blocked(odoo, model, method, args, kw=None):
            raise HTTPException(status_code=403, detail="no access")
        with mock.patch.object(fr, "_lc_kw", blocked):
            out = fr._lc_split_methods(("db", 1, "pwd", None))
        self.assertEqual([s["value"] for s in out],
                         [v for v, _ in fr._LC_SPLIT_METHODS_FALLBACK])
        self.assertIn("by_current_cost_price", [s["value"] for s in out])

    def test_malformed_selection_falls_back(self):
        with mock.patch.object(fr, "_lc_kw", make_lc_kw(selection=[])):
            out = fr._lc_split_methods(("db", 1, "pwd", None))
        self.assertEqual([s["value"] for s in out],
                         [v for v, _ in fr._LC_SPLIT_METHODS_FALLBACK])

    def test_default_prefers_historical_current_cost(self):
        sm = [{"value": v, "label": l} for v, l in fr._LC_SPLIT_METHODS_FALLBACK]
        self.assertEqual(fr._lc_default_split(sm), "by_current_cost_price")

    def test_default_is_first_choice_when_current_cost_missing(self):
        sm = [{"value": "by_container", "label": "By Container"},
              {"value": "by_carton", "label": "By Carton"}]
        self.assertEqual(fr._lc_default_split(sm), "by_container")


# ─────────────────────────────────────────────────────────────────────────────
# Options endpoint
# ─────────────────────────────────────────────────────────────────────────────

class OptionsEndpointTests(unittest.TestCase):

    def _options(self, **kwargs):
        with mock.patch.object(fr, "_odoo_connect",
                               lambda: ("db", 1, "pwd", None)), \
             mock.patch.object(fr, "_lc_kw", make_lc_kw(**kwargs)):
            return fr.landed_cost_options()

    def test_standard_selection_default_and_cost_type_defaults(self):
        d = self._options()
        vals = [s["value"] for s in d["split_methods"]]
        self.assertEqual(vals, [v for v, _ in STD_SELECTION])
        self.assertEqual(d["default_split_method"], "by_current_cost_price")
        self.assertIn(d["default_split_method"], vals)
        by_id = {c["id"]: c for c in d["cost_types"]}
        self.assertEqual(by_id[11]["default_split_method"], "by_weight")
        self.assertIsNone(by_id[12]["default_split_method"])   # unset → None

    def test_customised_selection_default_is_a_returned_choice(self):
        d = self._options(selection=CUSTOM_SELECTION)
        vals = [s["value"] for s in d["split_methods"]]
        self.assertEqual(vals, ["by_container", "by_carton"])
        # by_current_cost_price is NOT offered → default must be the first
        # live choice, never a value missing from the dropdown.
        self.assertEqual(d["default_split_method"], "by_container")
        self.assertIn(d["default_split_method"], vals)
        # a cost-type default outside the live selection is dropped to None
        by_id = {c["id"]: c for c in d["cost_types"]}
        self.assertIsNone(by_id[11]["default_split_method"])   # by_weight
        self.assertIsNone(by_id[12]["default_split_method"])

    def test_instance_without_product_default_field(self):
        d = self._options(product_field=None)
        self.assertTrue(all(c["default_split_method"] is None
                            for c in d["cost_types"]))
        self.assertEqual(d["default_split_method"], "by_current_cost_price")


# ─────────────────────────────────────────────────────────────────────────────
# Create endpoint
# ─────────────────────────────────────────────────────────────────────────────

class CreateEndpointTests(unittest.TestCase):

    def setUp(self):
        self.audits = []
        self.calls = []
        for target, repl in [
            ("_recv_block_quality_only", lambda request: None),
            ("_fabric_actor", lambda request: ("u1", "Tester")),
            ("_odoo_connect", lambda: ("db", 1, "pwd", None)),
            ("_lc_po_and_pickings", lambda odoo, po_id: (dict(PO),
                                                         [dict(PICKINGS[0])])),
            ("_get_conn", lambda: _FakeConn()),
            ("_ensure_receiving_tables", lambda conn: None),
            ("_recv_audit", lambda cur, po_id, sheet_id, fabric_name, action,
                            details, actor: self.audits.append((action,
                                                                details))),
            ("_log_fabric_change", lambda action, resv, request: None),
        ]:
            p = mock.patch.object(fr, target, repl)
            p.start()
            self.addCleanup(p.stop)

    def _create(self, lines, selection=STD_SELECTION):
        p = mock.patch.object(fr, "_lc_kw",
                              make_lc_kw(selection=selection,
                                         calls=self.calls))
        p.start()
        self.addCleanup(p.stop)
        body = {"po_id": 42, "picking_ids": [900], "date": "2026-08-07",
                "journal_id": 5, "lines": lines}
        return fr.landed_cost_create(SimpleNamespace(), body)

    def _created_vals(self):
        vals = [a[2][0] for a in self.calls
                if a[0] == "stock.landed.cost" and a[1] == "create"]
        self.assertEqual(len(vals), 1, "expected exactly one Odoo create")
        return vals[0]

    def _assert_no_create(self):
        self.assertFalse([a for a in self.calls
                          if a[0] == "stock.landed.cost" and a[1] == "create"],
                         "nothing must be written to Odoo on a 400")

    def test_absent_split_method_defaults_like_legacy_forms(self):
        d = self._create([{"product_id": 11, "amount": 10, "mode": "kes"}])
        self.assertTrue(d["ok"])
        cl = self._created_vals()["cost_lines"]
        self.assertEqual([c[2]["split_method"] for c in cl],
                         ["by_current_cost_price"])
        self.assertEqual(self.audits[0][0], "landed_cost_created")
        self.assertEqual(self.audits[0][1]["lines"][0]["split_method"],
                         "by_current_cost_price")

    def test_blank_split_method_treated_as_absent(self):
        self._create([{"product_id": 11, "amount": 10, "mode": "kes",
                       "split_method": "   "}])
        cl = self._created_vals()["cost_lines"]
        self.assertEqual(cl[0][2]["split_method"], "by_current_cost_price")

    def test_explicit_choice_is_forwarded_per_line(self):
        self._create([
            {"product_id": 11, "amount": 10, "mode": "kes",
             "split_method": "by_quantity"},
            {"product_id": 12, "amount": 5, "mode": "kes"},
        ])
        cl = self._created_vals()["cost_lines"]
        self.assertEqual([c[2]["split_method"] for c in cl],
                         ["by_quantity", "by_current_cost_price"])
        self.assertEqual(
            [l["split_method"] for l in self.audits[0][1]["lines"]],
            ["by_quantity", "by_current_cost_price"])

    def test_invalid_value_is_a_400_naming_the_line(self):
        with self.assertRaises(HTTPException) as ctx:
            self._create([
                {"product_id": 11, "amount": 10, "mode": "kes",
                 "split_method": "by_weight"},
                {"product_id": 12, "amount": 5, "mode": "kes",
                 "split_method": "bogus"},
            ])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Line 2", ctx.exception.detail)
        self.assertIn("split method", ctx.exception.detail)
        self._assert_no_create()

    def test_customised_selection_rejects_unsupported_current_cost(self):
        # An instance whose live selection dropped by_current_cost_price must
        # 400 an explicit request for it — no silent forwarding to Odoo.
        with self.assertRaises(HTTPException) as ctx:
            self._create([{"product_id": 11, "amount": 10, "mode": "kes",
                           "split_method": "by_current_cost_price"}],
                         selection=CUSTOM_SELECTION)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Line 1", ctx.exception.detail)
        self._assert_no_create()

    def test_customised_selection_absent_gets_first_live_choice(self):
        d = self._create([{"product_id": 11, "amount": 10, "mode": "kes"}],
                         selection=CUSTOM_SELECTION)
        self.assertTrue(d["ok"])
        cl = self._created_vals()["cost_lines"]
        self.assertEqual(cl[0][2]["split_method"], "by_container")


if __name__ == "__main__":
    unittest.main()
