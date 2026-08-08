"""Targeted tests for the Pre-production default costing lines contract.

The logic under test lives in fabric_dashboard_live.html (browser JS): the
four default Pre-production rows (Fabric, Accessories %, CMT, Defect
Allowance %), the all-fabric-lines percentage basis, legacy-line adoption,
reopen re-sync, and the locked-sheet freeze. Rather than duplicating the
formulas here, the EXACT production source block (COST_PP_AUTO_PREFIX
through costPreProdCalc) is extracted from the HTML and executed under
node with a stubbed DOM, so these tests exercise the shipped code and fail
if someone edits it incompatibly.

Covers, per scenario:
  seed_new        — seeding order/labels/AUTO state + idempotency
  worked_example  — 2.5 mtrs x 363.24 = 908.10 -> Trim 118.05, Defect 90.81,
                    CMT (08:00-08:30, KES 5/min x1.40) = 210.00; main fabric
                    qty mirrors Mtrs per Garment (no multiplier field in the
                    DOM -> default 1.40 keeps legacy figures)
  second_fabric   — an additional fabric row keeps its own qty, rolls into
                    the 13%/10% basis, and removal restores the base figures
  adopt_legacy    — reopen re-sync path: manual-flipped machine-labelled rows
                    are ADOPTED in place (duplicates folded, never appended),
                    user-added extra lines untouched
  custom_mult     — Production Multiplier 1.55 drives the adjusted minutes,
                    CMT line label (x1.55) and helper text
  mult_fallback   — blank / non-positive multiplier input falls back to 1.40
  adopt_custom    — saved sheet with multiplier 1.55 + HH:MM:SS times: fill
                    normalizes pickers to HH:MM, x1.55 label is adopted (not
                    duplicated) and re-synced figures use the sheet's value
  mult_helpers    — costPPMultNorm/costPPMultFmt edge cases; the generalized
                    CMT label matcher takes x1.40 AND xN.NN labels
  mult_last       — last-used multiplier remembered only on valid typed input
  locked          — seed + calc are no-ops on a locked sheet
  main_prod_guard — calc no-ops outside pre_production; derived-kind
                    detection is stage-gated
"""
import json
import os
import re
import subprocess
import tempfile
import unittest

HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "fabric_dashboard_live.html")

START_ANCHOR = "const COST_PP_AUTO_PREFIX="
END_ANCHOR = "function costNewSheet(){"

STUBS = r"""
'use strict';
let costEdit = null;
const dom = {};                       // id -> {value: ...}
const document = { getElementById: (id) => dom[id] || null };
const fmtKES2 = (v) => String(v);
const costBadge = () => '';
const esc = (s) => s;
let renderCalls = 0, totalsCalls = 0;
function costRenderLines(){ renderCalls++; }
function costRenderTotals(){ totalsCalls++; }
const _lsStore = {};                  // browser localStorage stand-in
const localStorage = {
  getItem: (k) => (k in _lsStore ? _lsStore[k] : null),
  setItem: (k, v) => { _lsStore[k] = String(v); },
  removeItem: (k) => { delete _lsStore[k]; },
};
function setDom(vals){ for (const k of Object.keys(dom)) delete dom[k];
  for (const [k, v] of Object.entries(vals)) dom[k] = { value: v }; }
function snap(){ return JSON.parse(JSON.stringify(costEdit.lines)); }
"""

DRIVER = r"""
const results = {};

// ── seed_new ────────────────────────────────────────────────────────────────
costEdit = { stage: 'pre_production', locked: false, lines: [],
  mtrs_per_garment: null, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: null, cmt_start_time: null, cmt_stop_time: null };
setDom({});
costPreProdSeedLines();
const seeded = snap();
costPreProdSeedLines();               // idempotent
results.seed_new = {
  first: seeded.map(l => ({ kind: l.kind, label: l.label, qty: l.qty,
    is_auto: l.is_auto, pp: costIsPPAuto(l) })),
  second_len: costEdit.lines.length,
};

// ── worked_example ──────────────────────────────────────────────────────────
costEdit = { stage: 'pre_production', locked: false,
  mtrs_per_garment: null, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: null, cmt_start_time: null, cmt_stop_time: null,
  lines: [{ kind: 'fabric', label: 'Test Fabric', qty: null,
            unit_cost: 363.24, is_auto: false, source: null,
            component_id: null, barcode: null }] };
setDom({ 'cost-pp-mpg': '2.5', 'cost-pp-acc-pct': '13',
         'cost-pp-def-pct': '10', 'cost-pp-cpm': '5',
         'cost-pp-cmt-start': '08:00', 'cost-pp-cmt-stop': '08:30' });
costPreProdSeedLines();
costPreProdCalc();
const we = snap();
const byKind = (k) => we.find(l => costPreProdMatchDefault(l, k));
results.worked_example = {
  kinds: we.map(l => l.kind),
  fabric_qty: we[0].qty,
  fabric_total: Math.round(we[0].qty * we[0].unit_cost * 100) / 100,
  trim: { label: byKind('trim').label, unit_cost: byKind('trim').unit_cost,
          qty: byKind('trim').qty, auto: costIsPPAuto(byKind('trim')) },
  cmt: { label: byKind('cmt').label, unit_cost: byKind('cmt').unit_cost,
         auto: costIsPPAuto(byKind('cmt')) },
  overhead: { label: byKind('overhead').label,
              unit_cost: byKind('overhead').unit_cost,
              auto: costIsPPAuto(byKind('overhead')) },
  header_synced: { mpg: costEdit.mtrs_per_garment,
                   cpm: costEdit.cost_per_minute,
                   start: costEdit.cmt_start_time,
                   stop: costEdit.cmt_stop_time },
};

// ── second_fabric (same sheet: add, recalc, remove, recalc) ────────────────
costEdit.lines.push({ kind: 'fabric', label: 'Lining', qty: 1,
  unit_cost: 451, is_auto: true, source: 'fabric master', component_id: 7,
  barcode: null });
costPreProdCalc();
const withExtra = snap();
const extraRow = withExtra.find(l => l.label === 'Lining');
const trimExtra = withExtra.find(l => costPreProdMatchDefault(l, 'trim'));
const defExtra = withExtra.find(l => costPreProdMatchDefault(l, 'overhead'));
const extraIdx = costEdit.lines.findIndex(l => l.label === 'Lining');
costEdit.lines.splice(extraIdx, 1);   // costDelLine's array op
costPreProdCalc();
const afterDel = snap();
results.second_fabric = {
  extra_qty_kept: extraRow.qty, extra_auto_kept: extraRow.is_auto,
  main_qty: withExtra[0].qty,
  trim_with_extra: trimExtra.unit_cost, def_with_extra: defExtra.unit_cost,
  trim_after_del: afterDel.find(l => costPreProdMatchDefault(l, 'trim')).unit_cost,
  def_after_del: afterDel.find(l => costPreProdMatchDefault(l, 'overhead')).unit_cost,
  count_after_del: afterDel.length,
};

// ── adopt_legacy (reopen re-sync of a stale saved sheet) ────────────────────
costEdit = { stage: 'pre_production', locked: false,
  mtrs_per_garment: 2.5, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: 5, cmt_start_time: '08:00', cmt_stop_time: '08:30',
  lines: [
    { kind: 'fabric', label: 'Test Fabric (manual cost)', qty: 1,
      unit_cost: 363.24, is_auto: false, source: null, component_id: null },
    { kind: 'trim', label: 'Accessories (13% of fabric cost)', qty: 1,
      unit_cost: 0, is_auto: false, source: null, component_id: null },
    { kind: 'cmt', label: 'CMT (08:00\u201308:30, KES 5/min \u00d71.40)',
      qty: 1, unit_cost: 0, is_auto: false, source: null, component_id: null },
    { kind: 'overhead', label: 'Defect Allowance (10% of fabric cost)',
      qty: 1, unit_cost: 55, is_auto: false, source: null, component_id: null },
    { kind: 'trim', label: 'Special buttons', qty: 2, unit_cost: 10,
      is_auto: false, source: null, component_id: null },
    // duplicate left behind by the old flip bug — must be FOLDED, not kept
    { kind: 'trim', label: 'Accessories (13% of fabric cost)', qty: 1,
      unit_cost: 99, is_auto: false, source: null, component_id: null },
  ] };
// costOpenSheet's re-sync path: fill header inputs from the SHEET, seed, calc
costPreProdFillInputs();
const domAfterFill = { mpg: dom['cost-pp-mpg'] ? dom['cost-pp-mpg'].value : null };
setDom({ 'cost-pp-mpg': '2.5', 'cost-pp-acc-pct': '13',
         'cost-pp-def-pct': '10', 'cost-pp-cpm': '5',
         'cost-pp-cmt-start': '08:00', 'cost-pp-cmt-stop': '08:30' });
const lenBeforeSeed = costEdit.lines.length;
costPreProdSeedLines();
const lenAfterSeed = costEdit.lines.length;
costPreProdCalc();
const adopted = snap();
results.adopt_legacy = {
  seed_added_nothing: lenBeforeSeed === lenAfterSeed,
  count: adopted.length,
  kinds: adopted.map(l => l.kind),
  labels: adopted.map(l => l.label),
  fabric_qty: adopted[0].qty,
  trim_default_count: adopted.filter(l => costPreProdMatchDefault(l, 'trim')).length,
  trim_cost: adopted.find(l => costPreProdMatchDefault(l, 'trim')).unit_cost,
  trim_auto: costIsPPAuto(adopted.find(l => costPreProdMatchDefault(l, 'trim'))),
  cmt_cost: adopted.find(l => costPreProdMatchDefault(l, 'cmt')).unit_cost,
  def_cost: adopted.find(l => costPreProdMatchDefault(l, 'overhead')).unit_cost,
  special: adopted.find(l => l.label === 'Special buttons'),
};

// ── custom_mult (Production Multiplier drives calc, label + helper text) ───
costEdit = { stage: 'pre_production', locked: false,
  mtrs_per_garment: null, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: null, cmt_start_time: null, cmt_stop_time: null,
  production_multiplier: null,
  lines: [{ kind: 'fabric', label: 'Test Fabric', qty: null,
            unit_cost: 363.24, is_auto: false, source: null,
            component_id: null, barcode: null }] };
setDom({ 'cost-pp-mpg': '2.5', 'cost-pp-acc-pct': '13',
         'cost-pp-def-pct': '10', 'cost-pp-cpm': '5',
         'cost-pp-cmt-start': '08:00', 'cost-pp-cmt-stop': '08:30',
         'cost-pp-mult': '1.55', 'cost-pp-cmt-info': '' });
costPreProdSeedLines();
costPreProdCalc();
const cmRows = snap();
const cmCmt = cmRows.find(l => costPreProdMatchDefault(l, 'cmt'));
results.custom_mult = {
  cmt_cost: cmCmt.unit_cost, cmt_label: cmCmt.label,
  cmt_auto: costIsPPAuto(cmCmt),
  info: dom['cost-pp-cmt-info'].textContent,
  synced: costEdit.production_multiplier,
  trim_cost: cmRows.find(l => costPreProdMatchDefault(l, 'trim')).unit_cost,
  def_cost: cmRows.find(l => costPreProdMatchDefault(l, 'overhead')).unit_cost,
  count: cmRows.length,
};

// ── mult_fallback (blank / non-positive input -> 1.40) ─────────────────────
costEdit = { stage: 'pre_production', locked: false,
  mtrs_per_garment: null, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: null, cmt_start_time: null, cmt_stop_time: null,
  lines: [{ kind: 'fabric', label: 'Test Fabric', qty: null,
            unit_cost: 363.24, is_auto: false, source: null,
            component_id: null, barcode: null }] };
setDom({ 'cost-pp-mpg': '2.5', 'cost-pp-acc-pct': '13',
         'cost-pp-def-pct': '10', 'cost-pp-cpm': '5',
         'cost-pp-cmt-start': '08:00', 'cost-pp-cmt-stop': '08:30',
         'cost-pp-mult': '', 'cost-pp-cmt-info': '' });
costPreProdSeedLines();
costPreProdCalc();
const fbCmt = costEdit.lines.find(l => costPreProdMatchDefault(l, 'cmt'));
const fbBlank = { cmt: fbCmt.unit_cost, label: fbCmt.label,
  info: dom['cost-pp-cmt-info'].textContent,
  synced: costEdit.production_multiplier };
dom['cost-pp-mult'].value = '0';
costPreProdCalc();
const fbZero = {
  cmt: costEdit.lines.find(l => costPreProdMatchDefault(l, 'cmt')).unit_cost,
  synced: costEdit.production_multiplier };
results.mult_fallback = { blank: fbBlank, zero: fbZero };

// ── adopt_custom (saved sheet: multiplier 1.55 + HH:MM:SS times) ───────────
costEdit = { stage: 'pre_production', locked: false,
  mtrs_per_garment: 2.5, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: 5, cmt_start_time: '08:00:00', cmt_stop_time: '08:30:00',
  production_multiplier: 1.55,
  lines: [
    { kind: 'fabric', label: 'Test Fabric', qty: 1, unit_cost: 363.24,
      is_auto: false, source: null, component_id: null },
    { kind: 'trim', label: 'Accessories (13% of fabric cost)', qty: 1,
      unit_cost: 0, is_auto: false, source: null, component_id: null },
    { kind: 'cmt', label: 'CMT (08:00:00\u201308:30:00, KES 5/min \u00d71.55)',
      qty: 1, unit_cost: 0, is_auto: false, source: null, component_id: null },
    { kind: 'overhead', label: 'Defect Allowance (10% of fabric cost)',
      qty: 1, unit_cost: 0, is_auto: false, source: null, component_id: null },
  ] };
setDom({ 'cost-pp-mpg': '', 'cost-pp-acc-pct': '', 'cost-pp-def-pct': '',
         'cost-pp-cpm': '', 'cost-pp-cmt-start': '', 'cost-pp-cmt-stop': '',
         'cost-pp-mult': '', 'cost-pp-cmt-info': '' });
costPreProdFillInputs();              // costOpenSheet's re-sync path
const acFilled = { start: dom['cost-pp-cmt-start'].value,
                   stop: dom['cost-pp-cmt-stop'].value,
                   mult: dom['cost-pp-mult'].value };
const acLenBefore = costEdit.lines.length;
costPreProdSeedLines();
const acSeedAddedNothing = costEdit.lines.length === acLenBefore;
costPreProdCalc();
const acRows = snap();
const acCmt = acRows.find(l => costPreProdMatchDefault(l, 'cmt'));
results.adopt_custom = {
  filled: acFilled, seed_added_nothing: acSeedAddedNothing,
  count: acRows.length,
  cmt_cost: acCmt.unit_cost, cmt_label: acCmt.label,
  cmt_auto: costIsPPAuto(acCmt),
  cmt_default_count: acRows.filter(l => costPreProdMatchDefault(l, 'cmt')).length,
  synced_mult: costEdit.production_multiplier,
  trim_cost: acRows.find(l => costPreProdMatchDefault(l, 'trim')).unit_cost,
};

// ── mult_helpers (norm/fmt edges + generalized CMT label matcher) ──────────
results.mult_helpers = {
  norm_blank: costPPMultNorm(''), norm_zero: costPPMultNorm('0'),
  norm_neg: costPPMultNorm('-2'), norm_txt: costPPMultNorm('abc'),
  norm_missing: costPPMultNorm(undefined),
  norm_low: costPPMultNorm('0.9'), norm_ok: costPPMultNorm('1.55'),
  fmt_140: costPPMultFmt(1.4), fmt_155: costPPMultFmt(1.55),
  fmt_090: costPPMultFmt(0.9), fmt_1375: costPPMultFmt(1.375),
  fmt_2: costPPMultFmt(2),
  matcher_legacy: costPreProdMatchDefault(
    { kind: 'cmt', label: 'CMT (08:00\u201308:30, KES 5/min \u00d71.40)',
      is_auto: false }, 'cmt'),
  matcher_new: costPreProdMatchDefault(
    { kind: 'cmt', label: 'CMT (08:00\u201308:30, KES 5/min \u00d71.55)',
      is_auto: false }, 'cmt'),
  matcher_seed: costPreProdMatchDefault(
    { kind: 'cmt', label: 'CMT (?\u2013?, KES 0/min \u00d70.90)',
      is_auto: false }, 'cmt'),
  matcher_not_cmt: costPreProdMatchDefault(
    { kind: 'cmt', label: 'Special CMT work', is_auto: false }, 'cmt'),
};

// ── mult_last (remember last TYPED value; blank/invalid never overwrite) ───
costEdit = { stage: 'main_production', locked: false, lines: [] };  // calc no-ops
const mlDefault = costPPMultLast();
costPPMultInput({ value: '1.62' });
const mlAfter = costPPMultLast();
costPPMultInput({ value: '' });       // blank must NOT overwrite
costPPMultInput({ value: '-3' });     // invalid must NOT overwrite
results.mult_last = { default_val: mlDefault, after: mlAfter,
                      after_bad: costPPMultLast() };

// ── locked (seed + calc must both be no-ops) ───────────────────────────────
costEdit = { stage: 'pre_production', locked: true,
  mtrs_per_garment: 2.5, accessories_pct: 13, defect_allowance_pct: 10,
  cost_per_minute: 5, cmt_start_time: '08:00', cmt_stop_time: '08:30',
  lines: [
    { kind: 'fabric', label: 'F', qty: 1, unit_cost: 363.24, is_auto: false },
    { kind: 'trim', label: 'Accessories (13% of fabric cost)', qty: 1,
      unit_cost: 0, is_auto: false },
  ] };
setDom({ 'cost-pp-mpg': '2.5', 'cost-pp-acc-pct': '13',
         'cost-pp-def-pct': '10', 'cost-pp-cpm': '5',
         'cost-pp-cmt-start': '08:00', 'cost-pp-cmt-stop': '08:30' });
const lockedBefore = JSON.stringify(costEdit.lines);
costPreProdSeedLines();
costPreProdCalc();
results.locked = { unchanged: JSON.stringify(costEdit.lines) === lockedBefore,
                   count: costEdit.lines.length };

// ── main_prod_guard ────────────────────────────────────────────────────────
costEdit = { stage: 'main_production', locked: false,
  lines: [{ kind: 'trim', label: 'Accessories (13% of fabric cost)', qty: 1,
            unit_cost: 5, is_auto: false }] };
setDom({ 'cost-pp-mpg': '9' });
const mpBefore = JSON.stringify(costEdit.lines);
costPreProdCalc();
results.main_prod_guard = {
  unchanged: JSON.stringify(costEdit.lines) === mpBefore,
  derived_kind_gated: costPPDerivedKind(costEdit.lines[0]) === null,
  matches_stage_independent: costPreProdMatchDefault(costEdit.lines[0], 'trim'),
};

console.log(JSON.stringify(results));
"""


def _extract_block():
    with open(HTML_PATH, encoding="utf-8") as fh:
        html = fh.read()
    start = html.index(START_ANCHOR)
    end = html.index(END_ANCHOR, start)
    if html.count(START_ANCHOR) != 1:
        raise AssertionError("COST_PP_AUTO_PREFIX anchor is not unique")
    return html[start:end]


class PreProdCostingLinesTest(unittest.TestCase):
    """Runs the extracted production JS once; each test asserts one slice."""

    results = None

    @classmethod
    def setUpClass(cls):
        block = _extract_block()
        for fn in ("costPreProdSeedLines", "costPreProdUpsert",
                   "costPreProdCalc", "costPreProdFillInputs",
                   "costPreProdMatchDefault", "costPPDerivedKind",
                   "costPPMultNorm", "costPPMultFmt", "costPPMultLast",
                   "costPPMultInput"):
            if ("function %s(" % fn) not in block:
                raise AssertionError("expected %s in extracted block" % fn)
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False,
                                         encoding="utf-8") as fh:
            fh.write(STUBS + block + DRIVER)
            path = fh.name
        try:
            proc = subprocess.run(["node", path], capture_output=True,
                                  text=True, timeout=60)
        finally:
            os.unlink(path)
        if proc.returncode != 0:
            raise AssertionError("node harness failed:\n" + proc.stderr[-2000:])
        cls.results = json.loads(proc.stdout.strip().splitlines()[-1])

    # ── seeding ────────────────────────────────────────────────────────────
    def test_seed_order_labels_and_auto(self):
        first = self.results["seed_new"]["first"]
        self.assertEqual([l["kind"] for l in first],
                         ["fabric", "trim", "cmt", "overhead"])
        self.assertEqual(first[1]["label"], "Accessories (13% of fabric cost)")
        self.assertTrue(first[2]["label"].startswith("CMT ("))
        self.assertEqual(first[3]["label"],
                         "Defect Allowance (10% of fabric cost)")
        self.assertTrue(all(l["is_auto"] and l["pp"] for l in first),
                        "all four seeded rows must be pre-production AUTO")
        self.assertIsNone(first[0]["qty"], "main fabric seeds with blank qty")
        self.assertEqual([l["qty"] for l in first[1:]], [1, 1, 1])

    def test_seed_is_idempotent(self):
        self.assertEqual(self.results["seed_new"]["second_len"], 4)

    # ── worked example / basis ─────────────────────────────────────────────
    def test_worked_example_figures(self):
        we = self.results["worked_example"]
        self.assertEqual(we["kinds"], ["fabric", "trim", "cmt", "overhead"])
        self.assertEqual(we["fabric_qty"], 2.5,
                         "main fabric qty mirrors Mtrs per Garment")
        self.assertEqual(we["fabric_total"], 908.10)
        self.assertEqual(we["trim"]["unit_cost"], 118.05)
        self.assertEqual(we["trim"]["qty"], 1)
        self.assertEqual(we["trim"]["label"], "Accessories (13% of fabric cost)")
        self.assertEqual(we["overhead"]["unit_cost"], 90.81)
        self.assertEqual(we["overhead"]["label"],
                         "Defect Allowance (10% of fabric cost)")
        self.assertEqual(we["cmt"]["unit_cost"], 210.00,
                         "30 min x 1.40 = 42 adj min x KES 5/min")
        self.assertIn("08:00", we["cmt"]["label"])
        self.assertIn("\u00d71.40", we["cmt"]["label"])
        self.assertTrue(we["trim"]["auto"] and we["cmt"]["auto"]
                        and we["overhead"]["auto"])

    def test_calc_syncs_header_inputs_onto_sheet(self):
        hs = self.results["worked_example"]["header_synced"]
        self.assertEqual(hs, {"mpg": 2.5, "cpm": 5,
                              "start": "08:00", "stop": "08:30"})

    def test_second_fabric_row_feeds_basis_and_keeps_own_qty(self):
        sf = self.results["second_fabric"]
        self.assertEqual(sf["extra_qty_kept"], 1,
                         "additional fabric rows keep hand-typed qty")
        self.assertTrue(sf["extra_auto_kept"],
                        "qty edit must not strip AUTO from a fabric row")
        self.assertEqual(sf["main_qty"], 2.5)
        # basis 908.10 + 451.00 = 1359.10
        self.assertEqual(sf["trim_with_extra"], 176.68)
        self.assertEqual(sf["def_with_extra"], 135.91)

    def test_deleting_extra_fabric_restores_basis(self):
        sf = self.results["second_fabric"]
        self.assertEqual(sf["trim_after_del"], 118.05)
        self.assertEqual(sf["def_after_del"], 90.81)
        self.assertEqual(sf["count_after_del"], 4)

    # ── reopen re-sync / adoption ──────────────────────────────────────────
    def test_reopen_adopts_legacy_lines_without_duplicating(self):
        al = self.results["adopt_legacy"]
        self.assertTrue(al["seed_added_nothing"],
                        "legacy machine-labelled rows satisfy seeding")
        self.assertEqual(al["trim_default_count"], 1,
                         "old-flip-bug duplicate must be folded")
        self.assertEqual(al["count"], 5,
                         "fabric + 3 derived + user extra (dup folded)")
        self.assertEqual(al["kinds"],
                         ["fabric", "trim", "cmt", "overhead", "trim"],
                         "adoption replaces in place, preserving order")
        self.assertEqual(al["fabric_qty"], 2.5,
                         "stale saved qty re-synced from stored header")
        self.assertEqual(al["trim_cost"], 118.05)
        self.assertTrue(al["trim_auto"],
                        "manual-flipped default row must be re-adopted AUTO")
        self.assertEqual(al["cmt_cost"], 210.00)
        self.assertEqual(al["def_cost"], 90.81)

    def test_reopen_leaves_user_extra_lines_alone(self):
        sp = self.results["adopt_legacy"]["special"]
        self.assertEqual((sp["qty"], sp["unit_cost"], sp["is_auto"]),
                         (2, 10, False))

    # ── Production Multiplier ──────────────────────────────────────────────
    def test_custom_multiplier_drives_calc_label_and_info(self):
        cm = self.results["custom_mult"]
        self.assertEqual(cm["cmt_cost"], 232.5,
                         "30 min x 1.55 = 46.5 adj min x KES 5/min")
        self.assertIn("\u00d71.55", cm["cmt_label"])
        self.assertNotIn("1.40", cm["cmt_label"],
                         "label must quote the sheet's actual multiplier")
        self.assertEqual(cm["info"],
                         "30 min \u00d7 1.55 = 46.5 adj min/gmt \u00d7 "
                         "KES 5/min = KES 232.5")
        self.assertEqual(cm["synced"], 1.55,
                         "calc must sync the multiplier onto the sheet")
        self.assertTrue(cm["cmt_auto"])
        self.assertEqual(cm["count"], 4)
        self.assertEqual(cm["trim_cost"], 118.05,
                         "multiplier must not touch the percentage lines")
        self.assertEqual(cm["def_cost"], 90.81)

    def test_blank_or_nonpositive_multiplier_falls_back_to_140(self):
        fb = self.results["mult_fallback"]
        self.assertEqual(fb["blank"]["cmt"], 210.00)
        self.assertIn("\u00d71.40", fb["blank"]["label"])
        self.assertEqual(fb["blank"]["synced"], 1.40)
        self.assertEqual(fb["blank"]["info"],
                         "30 min \u00d7 1.40 = 42 adj min/gmt \u00d7 "
                         "KES 5/min = KES 210")
        self.assertEqual(fb["zero"]["cmt"], 210.00)
        self.assertEqual(fb["zero"]["synced"], 1.40)

    def test_saved_multiplier_reopen_resync(self):
        ac = self.results["adopt_custom"]
        self.assertEqual(ac["filled"]["start"], "08:00",
                         "HH:MM:SS start time must fill the picker as HH:MM")
        self.assertEqual(ac["filled"]["stop"], "08:30")
        self.assertEqual(ac["filled"]["mult"], 1.55,
                         "stored multiplier must prefill the field")
        self.assertTrue(ac["seed_added_nothing"],
                        "the x1.55-labelled row satisfies seeding")
        self.assertEqual(ac["count"], 4)
        self.assertEqual(ac["cmt_default_count"], 1,
                         "custom-multiplier label adopted, never duplicated")
        self.assertEqual(ac["cmt_cost"], 232.5,
                         "same 30 minutes as before: figures unchanged")
        self.assertIn("08:00\u201308:30", ac["cmt_label"],
                      "re-synced label drops the legacy seconds")
        self.assertIn("\u00d71.55", ac["cmt_label"])
        self.assertTrue(ac["cmt_auto"],
                        "manual-flipped custom-label row re-adopted AUTO")
        self.assertEqual(ac["synced_mult"], 1.55)
        self.assertEqual(ac["trim_cost"], 118.05)

    def test_multiplier_norm_and_fmt_helpers(self):
        h = self.results["mult_helpers"]
        for k in ("norm_blank", "norm_zero", "norm_neg", "norm_txt",
                  "norm_missing"):
            self.assertEqual(h[k], 1.40, k + " must fall back to 1.40")
        self.assertEqual(h["norm_low"], 0.9,
                         "positive values below 1 are allowed")
        self.assertEqual(h["norm_ok"], 1.55)
        self.assertEqual(h["fmt_140"], "1.40")
        self.assertEqual(h["fmt_155"], "1.55")
        self.assertEqual(h["fmt_090"], "0.90")
        self.assertEqual(h["fmt_1375"], "1.375",
                         "extra precision is kept as typed")
        self.assertEqual(h["fmt_2"], "2.00")

    def test_cmt_matcher_adopts_legacy_and_custom_labels(self):
        h = self.results["mult_helpers"]
        self.assertTrue(h["matcher_legacy"], "x1.40 legacy label must match")
        self.assertTrue(h["matcher_new"], "xN.NN labels must match")
        self.assertTrue(h["matcher_seed"], "seed placeholder label must match")
        self.assertFalse(h["matcher_not_cmt"],
                         "user-added CMT lines must never be adopted")

    def test_last_used_multiplier_remembered_only_on_valid_input(self):
        ml = self.results["mult_last"]
        self.assertEqual(ml["default_val"], 1.40,
                         "no remembered value -> 1.40")
        self.assertEqual(ml["after"], 1.62)
        self.assertEqual(ml["after_bad"], 1.62,
                         "blank/invalid input must not overwrite last-used")

    # ── locked / stage guards ──────────────────────────────────────────────
    def test_locked_sheet_is_never_mutated(self):
        self.assertTrue(self.results["locked"]["unchanged"])
        self.assertEqual(self.results["locked"]["count"], 2,
                         "no seeding on a locked sheet")

    def test_calc_noops_outside_pre_production(self):
        mp = self.results["main_prod_guard"]
        self.assertTrue(mp["unchanged"])
        self.assertTrue(mp["derived_kind_gated"],
                        "derived-kind detection is stage-gated")
        self.assertTrue(mp["matches_stage_independent"],
                        "matcher itself stays stage-independent for pruning")


if __name__ == "__main__":
    unittest.main()
