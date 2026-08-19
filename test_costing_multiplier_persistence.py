"""Persistence tests for the per-sheet Production Multiplier (pre-production
costing).

The browser-side calculation/label/fallback rules are covered by
``test_preprod_costing_lines.py`` and the PDF wording by
``test_costing_pdf_export.py`` — but the SERVER persistence path (create
endpoint INSERT, update endpoint UPDATE, ``_sheet_payload`` read, NULL-legacy
handling) had no automated coverage. A future refactor of the costing
endpoints could drop or misorder the ``production_multiplier`` column and
every sheet would silently reopen at 1.40, changing CMT totals without anyone
noticing.

Following the project convention (see ``test_costing_signoff_rules.py``),
these tests call the REAL endpoint functions (``costing_sheet_create`` /
``costing_sheet_update`` / ``_sheet_payload``) against an in-memory fake of
the costing tables — no live Postgres, no HTTP server. The fake cursor
parses the actual SQL the endpoints run and stores values BY COLUMN NAME
parsed from the statement, so a dropped column, a column/params count
mismatch, or a misordered parameter (the multiplier landing in the wrong
column) all surface as test failures.

Covers:
* create with multiplier 1.55 → INSERT persists it → ``_sheet_payload``
  returns 1.55 (as a float);
* update to 1.62 → UPDATE persists it → read-back intact;
* update with blank ("") multiplier → stored/returned as NULL;
* non-positive multiplier (0 / negative) normalised to NULL on both
  create and update;
* legacy sheet with NULL multiplier → API payload carries
  ``production_multiplier: None`` and the PDF/display fallbacks
  (``_costing_mult_fmt``, ``_costing_to_build_data`` basis note) read 1.40;
* schema guard: ``_ensure_costing_tables`` still declares the column.

Also covers the server-picked Accessories % (previous-calendar-month Done-DPS
average): the pure month picker (previous-month pick, walk-back fallback,
no-data 13% default, current month never used), read-only enforcement on
create/update (client percentages ignored, derived line re-stamped with
provenance, meta persisted as JSONB and normalised by ``_sheet_payload``),
legacy sheets keeping their saved % with bare labels, and the preview
endpoint shape.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_costing_multiplier_persistence
"""
import datetime
import inspect
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr


# ─────────────────────────────────────────────────────────────────────────────
# In-memory fake of the costing tables + connection plumbing
# ─────────────────────────────────────────────────────────────────────────────

_INSERT_SHEET_RE = re.compile(
    r"INSERT\s+INTO\s+fabric_costing_sheets\s*\((.*?)\)\s*VALUES",
    re.IGNORECASE | re.DOTALL)
_INSERT_LINE_RE = re.compile(
    r"INSERT\s+INTO\s+fabric_costing_lines\s*\((.*?)\)\s*VALUES",
    re.IGNORECASE | re.DOTALL)
_SET_COL_RE = re.compile(r"(\w+)\s*=\s*%s")

# Columns _sheet_payload expects on a sheet row even when the INSERT/legacy
# row never set them.
_SHEET_ROW_DEFAULTS = {
    "selling_price": None, "selling_price_is_auto": False, "notes": None,
    "dps_ref": None, "color": None, "embroidery_data": None,
    "stage": "main_production", "accessories_pct": None,
    "defect_allowance_pct": None, "mtrs_per_garment": None,
    "cost_per_minute": None, "cmt_start_time": None, "cmt_stop_time": None,
    "production_multiplier": None, "accessories_pct_meta": None,
    "created_by": None, "created_by_name": None, "created_at": None,
    "updated_by": None, "updated_by_name": None, "updated_at": None,
    "style_name": None, "style_number": None,
}


class FakeStore:
    def __init__(self):
        self.sheets = {}        # id -> row dict
        self.lines = []         # list of row dicts (with sheet_id)
        self.history = []
        self._next_sheet_id = 1
        self._next_line_id = 1

    def seed_sheet(self, **cols):
        """Insert a sheet row directly (legacy-row fixture path)."""
        row = dict(_SHEET_ROW_DEFAULTS)
        row.update(cols)
        row["id"] = self._next_sheet_id
        self._next_sheet_id += 1
        self.sheets[row["id"]] = row
        return row["id"]


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._result = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=()):
        st = self.store
        m = _INSERT_SHEET_RE.search(sql)
        if m:
            cols = [c.strip() for c in m.group(1).split(",")]
            assert len(cols) == len(params), (
                f"sheet INSERT column/param count mismatch: "
                f"{len(cols)} cols vs {len(params)} params")
            row = dict(_SHEET_ROW_DEFAULTS)
            row.update(dict(zip(cols, params)))
            row["id"] = st._next_sheet_id
            st._next_sheet_id += 1
            st.sheets[row["id"]] = row
            self._result = [(row["id"],)]
            return
        m = _INSERT_LINE_RE.search(sql)
        if m:
            cols = [c.strip() for c in m.group(1).split(",")]
            assert len(cols) == len(params), "line INSERT count mismatch"
            row = dict(zip(cols, params))
            row["id"] = st._next_line_id
            st._next_line_id += 1
            st.lines.append(row)
            return
        if re.search(r"UPDATE\s+fabric_costing_sheets\s+SET", sql,
                     re.IGNORECASE):
            names = _SET_COL_RE.findall(sql)   # SET cols + the WHERE id
            assert len(names) == len(params), (
                f"sheet UPDATE column/param count mismatch: "
                f"{len(names)} placeholders vs {len(params)} params")
            mapping = dict(zip(names, params))
            sheet_id = mapping.pop("id")
            assert sheet_id in st.sheets, "UPDATE of unknown sheet"
            st.sheets[sheet_id].update(mapping)
            return
        if re.search(r"DELETE\s+FROM\s+fabric_costing_lines", sql,
                     re.IGNORECASE):
            st.lines = [l for l in st.lines if l["sheet_id"] != params[0]]
            return
        if "INSERT INTO" in sql and "fabric_costing_history" in sql:
            st.history.append(params)
            return
        raise AssertionError("FakeCursor got unexpected SQL:\n" + sql)

    def fetchone(self):
        return self._result[0] if self._result else None


class FakeConn:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self, *a, **k):
        return FakeCursor(self.store)

    def commit(self):
        pass

    def rollback(self):
        pass


def _fake_q(store):
    """A stand-in for fabric_router.q handling the SELECTs the costing
    create/update/read paths run."""
    def q(conn, sql, params=()):
        if "FROM fabric_costing_sheets WHERE id" in sql:
            r = store.sheets.get(params[0])
            return [dict(r)] if r else []
        if "lower(style_name)=lower(" in sql:
            want = str(params[0]).lower()
            return [{"id": r["id"]} for r in store.sheets.values()
                    if str(r.get("style_name") or "").lower() == want]
        if "FROM fabric_costing_lines l" in sql:      # _sheet_payload read
            rows = sorted(
                (l for l in store.lines if l["sheet_id"] == params[0]),
                key=lambda l: (l["kind"] != "fabric", l["position"], l["id"]))
            return [dict(l, barcode=None, _in_master=False, _kg_eff=None,
                         _std_price=None, _current_cpm=None) for l in rows]
        if "FROM fabric_costing_lines WHERE sheet_id" in sql:  # old lines
            return [dict(l) for l in store.lines
                    if l["sheet_id"] == params[0]]
        if "FROM fabric_costing_signoffs" in sql:
            return []
        if "FROM fabric_costing_history" in sql:
            return []
        raise AssertionError("fake q got unexpected SQL:\n" + sql)
    return q


def _request(email="tester@vivo.co.ke"):
    return SimpleNamespace(state=SimpleNamespace(
        user={"user_id": "u-test", "name": "Test User", "email": email}))


def _preprod_body(**over):
    body = {
        "style_name": "Test Style PM",
        "stage": "pre_production",
        "selling_price": None,
        "notes": "",
        "color": "Navy Blue",
        "mtrs_per_garment": 2.5,
        "accessories_pct": 13,
        "defect_allowance_pct": 10,
        "cost_per_minute": 5,
        "cmt_start_time": "08:00",
        "cmt_stop_time": "08:30",
        "production_multiplier": 1.55,
        "lines": [
            {"kind": "fabric", "label": "Test Fabric", "qty": 2.5,
             "unit_cost": 363.24, "is_auto": True, "source": None},
            {"kind": "cmt", "label": "CMT (08:00–08:30, KES 5/min ×1.55)",
             "qty": 1, "unit_cost": 232.5, "is_auto": True, "source": None},
        ],
    }
    body.update(over)
    return body


# ── Accessories % fixtures ───────────────────────────────────────────────────
# The real picker, captured BEFORE the harness patches it with a pinned
# "today" (tests must not drift when the wall-clock month changes).
_REAL_ACC_PICK = fr._preprod_accessories_pick
_ACC_TODAY = datetime.date(2026, 8, 8)          # sheets "created" in Aug 2026
_ACC_PRECISE = 898.1039134139472 / 10000.0 * 100.0   # Jul 2026 pooled ratio
_ACC_MONTH_ROWS = [
    # current month — must NEVER be picked for an Aug-created sheet
    {"month": "2026-08", "dps_count": 19, "trims_total": 1233.0,
     "fabric_total": 10000.0},
    {"month": "2026-07", "dps_count": 75, "trims_total": 898.1039134139472,
     "fabric_total": 10000.0},
    {"month": "2026-06", "dps_count": 45, "trims_total": 1152.0,
     "fabric_total": 10000.0},
]


def _acc_body(**over):
    """Pre-production body with a machine Accessories line and a client-sent
    % that the server must IGNORE."""
    body = _preprod_body(
        accessories_pct=50,
        lines=[
            {"kind": "fabric", "label": "Test Fabric", "qty": 2.5,
             "unit_cost": 363.24, "is_auto": True, "source": None},
            {"kind": "trim", "label": "Accessories (13% of fabric cost)",
             "qty": 1, "unit_cost": 118.05, "is_auto": True,
             "source": "pre-production auto: 13% of fabric cost"},
            {"kind": "cmt", "label": "CMT (08:00–08:30, KES 5/min ×1.55)",
             "qty": 1, "unit_cost": 232.5, "is_auto": True, "source": None},
        ])
    body.update(over)
    return body


class _Harness(unittest.TestCase):
    """Patches fabric_router's DB plumbing onto the in-memory fake."""

    def setUp(self):
        self.store = FakeStore()
        # Canned Done-DPS month history for the Accessories % pick; tests
        # reassign self.month_rows to exercise fallback / no-data paths.
        self.month_rows = [dict(r) for r in _ACC_MONTH_ROWS]
        patches = [
            mock.patch.object(fr, "q", _fake_q(self.store)),
            mock.patch.object(fr, "_get_conn",
                              lambda: FakeConn(self.store)),
            mock.patch.object(fr, "_ensure_costing_tables", lambda conn: None),
            mock.patch.object(fr, "_costing_require_editor", lambda req: None),
            mock.patch.object(fr, "_match_style",
                              lambda name: {"style_name": name,
                                            "style_number": "V999001"}),
            mock.patch.object(fr, "_require_style_dps",
                              lambda *a, **k: None),
            mock.patch.object(fr, "_preprod_acc_month_rows",
                              lambda conn: [dict(r) for r in self.month_rows]),
            # Pin "today" so the previous-month pick is deterministic.
            mock.patch.object(fr, "_preprod_accessories_pick",
                              lambda conn, today=None: _REAL_ACC_PICK(
                                  conn, today=_ACC_TODAY)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────

class CreateRoundTrip(_Harness):
    """Create a pre-production sheet with a custom multiplier → read intact."""

    def test_create_persists_custom_multiplier(self):
        payload = fr.costing_sheet_create(_request(), _preprod_body())
        self.assertEqual(payload["production_multiplier"], 1.55)
        self.assertIsInstance(payload["production_multiplier"], float)
        # The value must be stored in the RIGHT column — a misordered
        # param list would land it somewhere else.
        row = self.store.sheets[payload["id"]]
        self.assertEqual(float(row["production_multiplier"]), 1.55)
        self.assertEqual(row["cmt_start_time"], "08:00")
        self.assertEqual(row["cmt_stop_time"], "08:30")
        self.assertEqual(float(row["cost_per_minute"]), 5.0)

    def test_create_without_multiplier_stores_null(self):
        body = _preprod_body()
        del body["production_multiplier"]
        payload = fr.costing_sheet_create(_request(), body)
        self.assertIsNone(payload["production_multiplier"])

    def test_create_nonpositive_multiplier_normalised_to_null(self):
        payload = fr.costing_sheet_create(
            _request(), _preprod_body(production_multiplier=0))
        self.assertIsNone(payload["production_multiplier"])
        payload2 = fr.costing_sheet_create(
            _request(), _preprod_body(style_name="Other Style PM",
                                      production_multiplier=-2))
        self.assertIsNone(payload2["production_multiplier"])

    def test_create_non_numeric_multiplier_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            fr.costing_sheet_create(
                _request(), _preprod_body(production_multiplier="abc"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_preprod_create_uses_new_defaults_and_preserves_explicit_zeroes(self):
        body = _preprod_body()
        body.pop("defect_allowance_pct")
        body.pop("cost_per_minute")
        defaulted = fr.costing_sheet_create(_request(), body)
        self.assertEqual(defaulted["defect_allowance_pct"], 4.0)
        self.assertEqual(defaulted["cost_per_minute"], 22.71)

        zeroed = fr.costing_sheet_create(
            _request(), _preprod_body(style_name="Zero Inputs",
                                      defect_allowance_pct=0,
                                      cost_per_minute=0))
        self.assertEqual(zeroed["defect_allowance_pct"], 0.0)
        self.assertEqual(zeroed["cost_per_minute"], 0.0)

    def test_main_production_keeps_its_existing_input_defaults(self):
        body = _preprod_body(stage="main_production", dps_ref="DPS-MAIN")
        body.pop("defect_allowance_pct")
        body.pop("cost_per_minute")
        payload = fr.costing_sheet_create(_request(), body)
        self.assertEqual(payload["stage"], "main_production")
        self.assertEqual(payload["defect_allowance_pct"], 10.0)
        self.assertIsNone(payload["cost_per_minute"])

    def test_schema_defaults_remain_safe_for_direct_main_production_inserts(self):
        schema = Path(fr.__file__).read_text()
        self.assertIn("ALTER COLUMN defect_allowance_pct\n                SET DEFAULT 10", schema)
        self.assertIn("ALTER COLUMN cost_per_minute\n                DROP DEFAULT", schema)


class UpdateRoundTrip(_Harness):
    """Update path: the multiplier survives an edit-save cycle."""

    def _create(self):
        return fr.costing_sheet_create(_request(), _preprod_body())["id"]

    def test_update_keeps_and_changes_multiplier(self):
        sid = self._create()
        # Save again with the same multiplier — must stay intact.
        p1 = fr.costing_sheet_update(sid, _request(), _preprod_body())
        self.assertEqual(p1["production_multiplier"], 1.55)
        # Change it — new value must round-trip.
        p2 = fr.costing_sheet_update(
            sid, _request(), _preprod_body(production_multiplier=1.62))
        self.assertEqual(p2["production_multiplier"], 1.62)
        self.assertEqual(
            float(self.store.sheets[sid]["production_multiplier"]), 1.62)

    def test_update_blank_multiplier_clears_to_null(self):
        sid = self._create()
        p = fr.costing_sheet_update(
            sid, _request(), _preprod_body(production_multiplier=""))
        self.assertIsNone(p["production_multiplier"])

    def test_update_nonpositive_multiplier_clears_to_null(self):
        sid = self._create()
        p = fr.costing_sheet_update(
            sid, _request(), _preprod_body(production_multiplier=0))
        self.assertIsNone(p["production_multiplier"])

    def test_preprod_update_uses_new_defaults_and_preserves_explicit_zeroes(self):
        sid = self._create()
        defaulted = fr.costing_sheet_update(
            sid, _request(), _preprod_body(defect_allowance_pct="",
                                            cost_per_minute=""))
        self.assertEqual(defaulted["defect_allowance_pct"], 4.0)
        self.assertEqual(defaulted["cost_per_minute"], 22.71)
        zeroed = fr.costing_sheet_update(
            sid, _request(), _preprod_body(defect_allowance_pct=0,
                                            cost_per_minute=0))
        self.assertEqual(zeroed["defect_allowance_pct"], 0.0)
        self.assertEqual(zeroed["cost_per_minute"], 0.0)


class LegacyNullSheet(_Harness):
    """A sheet saved before the field existed: NULL through the API, and the
    display/PDF fallbacks read 1.40."""

    def _legacy_id(self):
        sid = self.store.seed_sheet(
            style_name="Legacy Style", style_number="V888001",
            stage="pre_production", selling_price=3900.0,
            accessories_pct=13, defect_allowance_pct=10,
            mtrs_per_garment=2.5, cost_per_minute=5,
            cmt_start_time="08:00", cmt_stop_time="08:30",
            production_multiplier=None)
        self.store.lines.append({
            "id": 1, "sheet_id": sid, "kind": "fabric", "label": "F",
            "qty": 2.5, "unit_cost": 363.24, "total": 908.10,
            "is_auto": True, "source": None, "position": 0,
            "component_id": None})
        return sid

    def test_payload_returns_null_for_legacy_sheet(self):
        sid = self._legacy_id()
        payload = fr._sheet_payload(FakeConn(self.store), sid)
        self.assertIn("production_multiplier", payload,
                      "payload must carry the field even when NULL")
        self.assertIsNone(payload["production_multiplier"])

    def test_payload_falls_back_to_new_preprod_input_defaults(self):
        sid = self._legacy_id()
        self.store.sheets[sid]["defect_allowance_pct"] = None
        self.store.sheets[sid]["cost_per_minute"] = None
        payload = fr._sheet_payload(FakeConn(self.store), sid)
        self.assertEqual(payload["defect_allowance_pct"], 4.0)
        self.assertEqual(payload["cost_per_minute"], 22.71)

    def test_display_fmt_falls_back_to_140(self):
        self.assertEqual(fr._costing_mult_fmt(None), "1.40")
        self.assertEqual(fr._costing_mult_fmt(0), "1.40")
        self.assertEqual(fr._costing_mult_fmt(1.55), "1.55")

    def test_pdf_basis_note_falls_back_to_140(self):
        sid = self._legacy_id()
        payload = fr._sheet_payload(FakeConn(self.store), sid)
        payload["notes"] = None
        d = fr._costing_to_build_data(payload)
        self.assertIn("\u00d71.40 efficiency factor", d["basis_note"])


class SchemaGuard(unittest.TestCase):
    """The lazy DDL must keep declaring the column, or a fresh/prod DB would
    have no production_multiplier at all and every write would 500."""

    def test_ensure_costing_tables_declares_column(self):
        src = inspect.getsource(fr._ensure_costing_tables)
        self.assertRegex(
            src, r"ADD COLUMN IF NOT EXISTS production_multiplier NUMERIC")

    def test_insert_and_update_statements_carry_column(self):
        for fn in (fr.costing_sheet_create, fr.costing_sheet_update):
            src = inspect.getsource(fn)
            self.assertIn("production_multiplier", src,
                          f"{fn.__name__} must persist production_multiplier")


# ─────────────────────────────────────────────────────────────────────────────
# Accessories % — previous-month Done-DPS average (picked once, read-only)
# ─────────────────────────────────────────────────────────────────────────────

class AccessoriesPickPure(unittest.TestCase):
    """The pure month picker: previous calendar month, walk-back fallback,
    labelled 13% default, current month never considered."""

    TODAY = datetime.date(2026, 8, 8)

    def test_previous_month_pick(self):
        out = fr._preprod_acc_pick_from_months(
            [dict(r) for r in _ACC_MONTH_ROWS], self.TODAY)
        self.assertAlmostEqual(out["pct"], _ACC_PRECISE, places=9)
        m = out["meta"]
        self.assertEqual(m["source_month"], "2026-07")
        self.assertEqual(m["month_label"], "Jul 2026")
        self.assertEqual(m["dps_count"], 75)
        self.assertFalse(m["fallback"])
        self.assertFalse(m["is_default"])
        self.assertEqual(m["requested_month"], "2026-07")
        self.assertAlmostEqual(m["pct"], out["pct"])

    def test_current_month_never_picked(self):
        rows = [r for r in _ACC_MONTH_ROWS if r["month"] == "2026-08"]
        out = fr._preprod_acc_pick_from_months(rows, self.TODAY)
        self.assertTrue(out["meta"]["is_default"],
                        "the in-progress month must never supply the %")
        self.assertEqual(out["pct"], 13.0)

    def test_walk_back_sets_fallback_flag(self):
        rows = [r for r in _ACC_MONTH_ROWS if r["month"] != "2026-07"]
        out = fr._preprod_acc_pick_from_months(rows, self.TODAY)
        self.assertAlmostEqual(out["pct"], 11.52, places=9)
        m = out["meta"]
        self.assertTrue(m["fallback"])
        self.assertFalse(m["is_default"])
        self.assertEqual(m["source_month"], "2026-06")
        self.assertEqual(m["requested_month_label"], "Jul 2026")

    def test_zero_fabric_month_skipped(self):
        rows = [dict(r) for r in _ACC_MONTH_ROWS]
        for r in rows:
            if r["month"] == "2026-07":
                r["fabric_total"] = 0
        out = fr._preprod_acc_pick_from_months(rows, self.TODAY)
        self.assertEqual(out["meta"]["source_month"], "2026-06")
        self.assertTrue(out["meta"]["fallback"])

    def test_no_data_default(self):
        out = fr._preprod_acc_pick_from_months([], self.TODAY)
        self.assertEqual(out["pct"], 13.0)
        m = out["meta"]
        self.assertTrue(m["is_default"])
        self.assertFalse(m["fallback"])
        self.assertEqual(m["dps_count"], 0)
        self.assertEqual(m["requested_month"], "2026-07")

    def test_display_helpers(self):
        self.assertEqual(fr._preprod_month_label("2026-07"), "Jul 2026")
        self.assertEqual(fr._preprod_month_label("2026-01"), "Jan 2026")
        self.assertEqual(fr._preprod_acc_pct_fmt(8.981039134139472), "8.98")
        self.assertEqual(fr._preprod_acc_pct_fmt(13), "13")
        self.assertEqual(fr._preprod_acc_pct_fmt(12.3), "12.3")

    def test_provenance_suffix(self):
        self.assertEqual(fr._preprod_acc_provenance_suffix(None), "",
                         "legacy sheets keep their exact saved labels")
        self.assertEqual(
            fr._preprod_acc_provenance_suffix(
                {"month_label": "Jul 2026", "dps_count": 75}),
            " — Jul 2026 Done-DPS avg, 75 DPS")
        self.assertEqual(
            fr._preprod_acc_provenance_suffix(
                {"month_label": "Jun 2026", "dps_count": 45,
                 "fallback": True}),
            " — Jun 2026 Done-DPS avg, 45 DPS (fallback)")
        self.assertEqual(
            fr._preprod_acc_provenance_suffix({"is_default": True}),
            " — default (no Done-DPS history)")
        self.assertEqual(
            fr._preprod_acc_provenance_suffix(
                {"retrofit_status": "retained_no_history"}),
            " — retained (no qualifying Done-DPS history)")


class AccessoriesCreateReadOnly(_Harness):
    """Create endpoint: client % ignored, precise pick persisted with meta,
    derived line re-stamped with provenance."""

    def test_client_pct_ignored_and_precise_pick_persisted(self):
        payload = fr.costing_sheet_create(_request(), _acc_body())
        self.assertAlmostEqual(payload["accessories_pct"], _ACC_PRECISE,
                               places=9)
        self.assertNotEqual(payload["accessories_pct"], 50,
                            "client-sent % must never be accepted")
        row = self.store.sheets[payload["id"]]
        self.assertAlmostEqual(float(row["accessories_pct"]), _ACC_PRECISE,
                               places=9)
        meta_raw = row["accessories_pct_meta"]
        self.assertIsInstance(meta_raw, str,
                              "meta is persisted as a JSON string")
        meta = json.loads(meta_raw)
        self.assertEqual(meta["source_month"], "2026-07")
        self.assertEqual(meta["dps_count"], 75)
        self.assertFalse(meta["fallback"])
        # _sheet_payload must hand the editor a parsed dict.
        self.assertIsInstance(payload["accessories_pct_meta"], dict)
        self.assertEqual(payload["accessories_pct_meta"]["month_label"],
                         "Jul 2026")

    def test_derived_line_restamped_with_provenance(self):
        fr.costing_sheet_create(_request(), _acc_body())
        trims = [l for l in self.store.lines if l["kind"] == "trim"]
        self.assertEqual(len(trims), 1)
        self.assertEqual(trims[0]["label"],
                         "Accessories (8.98% of fabric cost — "
                         "Jul 2026 Done-DPS avg, 75 DPS)")
        self.assertEqual(trims[0]["source"],
                         "pre-production auto: 8.98% of fabric cost — "
                         "Jul 2026 Done-DPS avg, 75 DPS")
        # 8.981039…% of 908.10 = 81.5568… → 81.56 (half-up, 2 dp)
        self.assertEqual(float(trims[0]["unit_cost"]), 81.56)

    def test_duplicate_machine_lines_folded(self):
        body = _acc_body()
        body["lines"] = body["lines"] + [
            {"kind": "trim", "label": "Accessories (13% of fabric cost)",
             "qty": 1, "unit_cost": 99, "is_auto": False, "source": None}]
        fr.costing_sheet_create(_request(), body)
        trims = [l for l in self.store.lines if l["kind"] == "trim"]
        self.assertEqual(len(trims), 1,
                         "duplicate machine-labelled rows must be folded")

    def test_walk_back_fallback_month_labelled(self):
        self.month_rows = [r for r in self.month_rows
                           if r["month"] != "2026-07"]
        payload = fr.costing_sheet_create(_request(), _acc_body())
        self.assertAlmostEqual(payload["accessories_pct"], 11.52, places=9)
        meta = payload["accessories_pct_meta"]
        self.assertTrue(meta["fallback"])
        self.assertEqual(meta["source_month"], "2026-06")
        self.assertEqual(meta["requested_month_label"], "Jul 2026")
        trims = [l for l in self.store.lines if l["kind"] == "trim"]
        self.assertEqual(trims[0]["label"],
                         "Accessories (11.52% of fabric cost — "
                         "Jun 2026 Done-DPS avg, 45 DPS (fallback))")

    def test_no_history_labelled_default(self):
        self.month_rows = []
        payload = fr.costing_sheet_create(_request(), _acc_body())
        self.assertEqual(payload["accessories_pct"], 13.0)
        self.assertTrue(payload["accessories_pct_meta"]["is_default"])
        trims = [l for l in self.store.lines if l["kind"] == "trim"]
        self.assertEqual(trims[0]["label"],
                         "Accessories (13% of fabric cost — "
                         "default (no Done-DPS history))")

    def test_server_never_injects_a_line(self):
        body = _acc_body()
        body["lines"] = [l for l in body["lines"] if l["kind"] != "trim"]
        fr.costing_sheet_create(_request(), body)
        self.assertEqual(
            [l for l in self.store.lines if l["kind"] == "trim"], [],
            "sheets without a machine Accessories row are left alone")

    def test_main_production_stays_at_legacy_default(self):
        body = _acc_body(stage="main_production", dps_ref="DPS00001",
                         accessories_pct=50)
        body["lines"] = [l for l in body["lines"] if l["kind"] != "trim"]
        payload = fr.costing_sheet_create(_request(), body)
        self.assertEqual(payload["accessories_pct"], 13.0)
        self.assertIsNone(payload["accessories_pct_meta"])
        self.assertIsNone(
            self.store.sheets[payload["id"]]["accessories_pct_meta"])

    def test_preview_endpoint_shape(self):
        out = fr.costing_preprod_accessories_pct()
        self.assertAlmostEqual(out["accessories_pct"], _ACC_PRECISE, places=9)
        self.assertEqual(out["accessories_pct_display"], 8.98)
        self.assertEqual(out["meta"]["month_label"], "Jul 2026")
        self.assertEqual(out["meta"]["dps_count"], 75)


class AccessoriesUpdateReadOnly(_Harness):
    """Update endpoint: stored % + meta always win; never re-picked; legacy
    sheets keep their saved % with the bare label."""

    def test_update_ignores_client_pct_and_keeps_meta(self):
        sid = fr.costing_sheet_create(_request(), _acc_body())["id"]
        body = _acc_body(accessories_pct=99)
        body["lines"][1].update(  # stale editor rewrote the label
            label="Accessories (99% of fabric cost)", source=None,
            is_auto=False)
        p = fr.costing_sheet_update(sid, _request(), body)
        self.assertAlmostEqual(p["accessories_pct"], _ACC_PRECISE, places=9)
        self.assertEqual(p["accessories_pct_meta"]["source_month"], "2026-07")
        trims = [l for l in self.store.lines if l["kind"] == "trim"]
        self.assertEqual(len(trims), 1)
        self.assertEqual(trims[0]["label"],
                         "Accessories (8.98% of fabric cost — "
                         "Jul 2026 Done-DPS avg, 75 DPS)")
        self.assertEqual(float(trims[0]["unit_cost"]), 81.56)

    def test_update_never_repicks_even_when_history_changes(self):
        sid = fr.costing_sheet_create(_request(), _acc_body())["id"]
        self.month_rows = []          # history vanishes — stored % must win
        p = fr.costing_sheet_update(sid, _request(), _acc_body())
        self.assertAlmostEqual(p["accessories_pct"], _ACC_PRECISE, places=9)
        self.assertFalse(p["accessories_pct_meta"]["is_default"])

    def test_legacy_sheet_keeps_saved_pct_and_bare_label(self):
        sid = self.store.seed_sheet(
            style_name="Legacy Acc Style", style_number="V777001",
            stage="pre_production", selling_price=3900.0,
            accessories_pct=15, defect_allowance_pct=10,
            mtrs_per_garment=2.5, cost_per_minute=5,
            cmt_start_time="08:00", cmt_stop_time="08:30")
        p = fr.costing_sheet_update(
            sid, _request(),
            _acc_body(style_name="Legacy Acc Style", accessories_pct=50))
        self.assertEqual(float(p["accessories_pct"]), 15.0)
        self.assertIsNone(p["accessories_pct_meta"])
        trims = [l for l in self.store.lines if l["kind"] == "trim"]
        self.assertEqual(trims[0]["label"],
                         "Accessories (15% of fabric cost)",
                         "no provenance suffix on legacy sheets")
        self.assertEqual(trims[0]["source"],
                         "pre-production auto: 15% of fabric cost")
        # 15% of 908.10 = 136.215 → 136.22 (half-up)
        self.assertEqual(float(trims[0]["unit_cost"]), 136.22)

    def test_update_sql_never_writes_the_pct_or_meta(self):
        src = inspect.getsource(fr.costing_sheet_update)
        self.assertNotRegex(src, r"accessories_pct\s*=\s*%s")
        self.assertNotRegex(src, r"accessories_pct_meta\s*=\s*%s")


class AccessoriesSchemaGuard(unittest.TestCase):
    def test_ddl_declares_meta_column(self):
        src = inspect.getsource(fr._ensure_costing_tables)
        self.assertRegex(
            src, r"ADD COLUMN IF NOT EXISTS accessories_pct_meta JSONB")

    def test_create_insert_carries_meta_column(self):
        self.assertIn("accessories_pct_meta",
                      inspect.getsource(fr.costing_sheet_create))


if __name__ == "__main__":
    unittest.main()
