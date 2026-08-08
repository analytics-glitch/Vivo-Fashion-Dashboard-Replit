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

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_costing_multiplier_persistence
"""
import inspect
import re
import unittest
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
    "production_multiplier": None,
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


class _Harness(unittest.TestCase):
    """Patches fabric_router's DB plumbing onto the in-memory fake."""

    def setUp(self):
        self.store = FakeStore()
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


if __name__ == "__main__":
    unittest.main()
