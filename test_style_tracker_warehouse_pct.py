"""Regression tests for the Style Launch Planner "% Recv" calculation.

Task 1478: the displayed percentage must reconcile to warehouse-receipt
evidence. One shared contract (api_pg._st_batch_warehouse_pct, which
_style_warehouse_pct delegates to) now feeds the board column, the live
/warehouse-pct endpoint and the ≥90% Warehouse status gate:

  1. Receipts first — completed finishing→warehouse transfer units for ALL
     matching product/SKU rows and style-name variants (product-master name
     via unique SKU, plus the transfer's own product_name), each transfer row
     counted exactly once.
  2. Re-Order/Replenishment with an order_date only counts receipts whose EAT
     day is on/after that date, and never falls back to stock.
  3. New/undated styles with zero receipt evidence fall back to current
     Warehouse Finished Goods stock (original behaviour).
  4. pct = min(units/quantity*100, 100); wh_units is the true non-negative
     receipt count (may exceed quantity — UI caps the badge, tooltip shows
     real units).

Three suites:

* TestWarehousePctDbSemantics — runs the REAL SQL against session-local TEMP
  tables that shadow stock_transfers / all_products_clean / all_inventory
  (pg_temp precedes public in the search path, so the production tables are
  never read or written). Requires DATABASE_URL; skipped otherwise.
* TestWarehouseGateEffectiveValues — API-level: the status→Warehouse gate in
  style_tracker_update must evaluate the EFFECTIVE row being saved (a request
  can change quantity/style_name together with status), staying in lockstep
  with the shared calculation. Requires DATABASE_URL; skipped otherwise.
* TestBoardResponseConsistency — no DB; fakes _users_exec and asserts the
  board response carries numerically consistent warehouse_pct / wh_units
  for every row (the badge, tooltip and XLSX export all read these fields
  verbatim — there is no second frontend formula).

Run::

    python -m unittest test_style_tracker_warehouse_pct
"""
import copy
import os
import unittest
from datetime import date, datetime
from unittest import mock

import api_pg

DB_URL = os.environ.get("DATABASE_URL")

EAT = "Warehouse Finished Goods"


def _seed_shadow_tables(conn):
    """Create session-local TEMP shadows of the three source tables and seed
    the shared fixture data (see TestWarehousePctDbSemantics docstring)."""
    cur = conn.cursor()
    cur.execute("""
        CREATE TEMP TABLE all_products_clean (
            sku text PRIMARY KEY, style_name text);
        CREATE TEMP TABLE stock_transfers (
            move_id bigint PRIMARY KEY, picking_id bigint, sku text,
            product_name text, qty_done numeric, transfer_type text,
            state text, date_done timestamp);
        CREATE TEMP TABLE all_inventory (
            sku text, available numeric, pos_location_name text);
    """)
    cur.executemany(
        "INSERT INTO all_products_clean (sku, style_name) VALUES (%s, %s)",
        [
            ("SKU-A1", "Vivo Test Amai Kaftan in Satin"),
            ("SKU-A2", "Vivo Test Amai Kaftan in Satin"),
            ("SKU-A3", "Vivo Test Amai Kaftan in Satin"),
            ("SKU-B1", "Vivo Test Wrap Dress in Crepe - Print"),
            ("SKU-B2", "Vivo Test Wrap Dress in Crepe - Solid"),
            ("SKU-C1", "Vivo Test Lounge Pants in Rib"),
            ("SKU-D1", "Vivo Test Tent Dress in Cotton"),
            ("SKU-E1", "Vivo Test Scoop Top in Jersey"),
        ])
    f2w = "finishing_to_warehouse"
    cur.executemany(
        "INSERT INTO stock_transfers (move_id, picking_id, sku, product_name,"
        " qty_done, transfer_type, state, date_done)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        [
            # Style A — ONE big picking (60001), three size/colour SKU rows.
            (1, 60001, "SKU-A1", "Vivo Test Amai Kaftan in Satin", 140, f2w, "done", datetime(2026, 7, 10, 9, 0)),
            (2, 60001, "SKU-A2", "Vivo Test Amai Kaftan in Satin", 130, f2w, "done", datetime(2026, 7, 10, 9, 0)),
            (3, 60001, "SKU-A3", "Vivo Test Amai Kaftan in Satin", 80, f2w, "done", datetime(2026, 7, 10, 9, 0)),
            # Non-qualifying rows for style A: wrong state / wrong lane.
            (4, 60002, "SKU-A1", "Vivo Test Amai Kaftan in Satin", 500, f2w, "assigned", datetime(2026, 7, 11, 9, 0)),
            (5, 60003, "SKU-A1", "Vivo Test Amai Kaftan in Satin", 999, "warehouse_to_store", "done", datetime(2026, 7, 12, 9, 0)),
            # Style B — colourway-variant master names + a SKU missing
            # from the master that matches via the transfer product_name.
            (6, 60010, "SKU-B1", "Vivo Test Wrap Dress in Crepe - Print", 90, f2w, "done", datetime(2026, 7, 15, 9, 0)),
            (7, 60010, "SKU-B2", "Vivo Test Wrap Dress in Crepe - Solid", 60, f2w, "done", datetime(2026, 7, 15, 9, 0)),
            (8, 60011, "SKU-B9", "Vivo Test Wrap Dress in Crepe - New Colour", 50, f2w, "done", datetime(2026, 7, 16, 9, 0)),
            # Style C — EAT order-date boundary (order_date 2026-08-01).
            # 20:59 UTC Jul 31 = 23:59 EAT Jul 31 → EXCLUDED.
            (9, 60020, "SKU-C1", "Vivo Test Lounge Pants in Rib", 120, f2w, "done", datetime(2026, 7, 31, 20, 59)),
            # 21:30 UTC Jul 31 = 00:30 EAT Aug 1 → INCLUDED.
            (10, 60021, "SKU-C1", "Vivo Test Lounge Pants in Rib", 150, f2w, "done", datetime(2026, 7, 31, 21, 30)),
            # Style E — receipts exceed the ordered quantity (120 vs 80).
            (11, 60030, "SKU-E1", "Vivo Test Scoop Top in Jersey", 120, f2w, "done", datetime(2026, 7, 20, 9, 0)),
        ])
    cur.executemany(
        "INSERT INTO all_inventory (sku, available, pos_location_name)"
        " VALUES (%s, %s, %s)",
        [
            # Residual warehouse stock for style A — must NOT be shown
            # (receipts win for undated styles with receipt evidence).
            ("SKU-A1", 5, EAT),
            # Style C has plenty of warehouse stock — must NOT satisfy the
            # dated Re-Order path (ids 3 and 6).
            ("SKU-C1", 400, EAT),
            # Style D fallback: 60 valid + negative row clamped to 0 +
            # a non-warehouse location that must be excluded.
            ("SKU-D1", 60, EAT),
            ("SKU-D1", -10, EAT),
            ("SKU-D1", 500, "Nairobi Store"),
        ])
    cur.close()


def _session_exec_factory(conn):
    """A _users_exec stand-in bound to one session (temp schema shadows
    public, so the real tables are never touched)."""
    import psycopg2.extras

    def _exec(query, params=None, fetch=False):
        c = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        c.execute(query, params)
        rows = [dict(r) for r in c.fetchall()] if fetch else None
        c.close()
        return rows

    return _exec


# ---------------------------------------------------------------------------
# Suite 1 — real SQL semantics against TEMP shadow tables
# ---------------------------------------------------------------------------

@unittest.skipUnless(DB_URL, "DATABASE_URL not set")
class TestWarehousePctDbSemantics(unittest.TestCase):
    """Exercises the actual queries on controlled fixtures.

    Fixture styles (tracked rows passed straight to the helpers):
      id 1 "Vivo Test Amai Kaftan in Satin"  qty 400, undated
           — ONE picking moves 350 units (87.5% — the reported ">86% in a
             single transfer" shape) across three SKUs; warehouse stock is a
             residual 5 units which must NOT be what's shown.
      id 2 "Vivo Test Wrap Dress in Crepe"   qty 300, undated
           — receipts spread over colourway-variant master names
             (" - Print", " - Solid") plus one transfer whose SKU is missing
             from the product master and only matches via the transfer's own
             product_name (style-name variant routes).
      id 3 "Vivo Test Lounge Pants in Rib"   qty 200, Re-Order 2026-08-01
           — EAT boundary: 20:59 UTC Jul 31 (= 23:59 EAT Jul 31) excluded,
             21:30 UTC Jul 31 (= 00:30 EAT Aug 1) included; big warehouse
             stock must NOT satisfy the dated path.
      id 4 "Vivo Test Tent Dress in Cotton"  qty 100, "New", undated
           — no receipts at all → warehouse-stock fallback (negative rows
             clamped, non-warehouse locations excluded).
      id 5 "Vivo Test Scoop Top in Jersey"   qty 80, undated
           — receipts 120 > ordered 80 → pct capped at 100, true units kept.
      id 6 same style as id 3 but order_date 2030-01-01
           — dated with zero matching receipts → (0.0, 0) even though the
             style has warehouse stock (no fallback for dated rows).
    """

    STYLES = [
        {"id": 1, "style_name": "Vivo Test Amai Kaftan in Satin", "quantity": 400,
         "order_type": None, "order_date": None},
        {"id": 2, "style_name": "Vivo Test Wrap Dress in Crepe", "quantity": 300,
         "order_type": None, "order_date": None},
        {"id": 3, "style_name": "Vivo Test Lounge Pants in Rib", "quantity": 200,
         "order_type": "Re-Order", "order_date": date(2026, 8, 1)},
        {"id": 4, "style_name": "Vivo Test Tent Dress in Cotton", "quantity": 100,
         "order_type": "New", "order_date": None},
        {"id": 5, "style_name": "Vivo Test Scoop Top in Jersey", "quantity": 80,
         "order_type": None, "order_date": None},
        {"id": 6, "style_name": "Vivo Test Lounge Pants in Rib", "quantity": 200,
         "order_type": "Re-Order", "order_date": date(2030, 1, 1)},
    ]

    EXPECTED = {
        1: (87.5, 350),
        2: (200 / 300 * 100.0, 200),
        3: (75.0, 150),
        4: (60.0, 60),
        5: (100.0, 120),
        6: (0.0, 0),
    }

    @classmethod
    def setUpClass(cls):
        import psycopg2
        cls.conn = psycopg2.connect(DB_URL)
        cls.conn.autocommit = True
        _seed_shadow_tables(cls.conn)
        cls._patcher = mock.patch.object(
            api_pg, "_users_exec", side_effect=_session_exec_factory(cls.conn))
        cls._patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._patcher.stop()
        cls.conn.close()  # TEMP tables die with the session

    # -- batch --------------------------------------------------------------

    def test_batch_matches_expected_units_and_pct(self):
        got = api_pg._st_batch_warehouse_pct(self.STYLES)
        for sid, (exp_pct, exp_units) in self.EXPECTED.items():
            pct, units = got[sid]
            self.assertEqual(units, exp_units,
                             f"style {sid}: wh_units {units} != {exp_units}")
            self.assertAlmostEqual(pct, exp_pct, places=6,
                                   msg=f"style {sid}: pct {pct} != {exp_pct}")

    def test_single_large_transfer_fully_included(self):
        """The reported bug: one picking holding >86% of the ordered units
        must be fully reflected — not the residual warehouse stock."""
        pct, units = api_pg._st_batch_warehouse_pct(self.STYLES)[1]
        self.assertEqual(units, 350)          # 140+130+80, one picking
        self.assertGreater(pct, 86.0)
        self.assertNotEqual(units, 5, "residual stock must not be the value")

    def test_variant_and_missing_sku_rows_all_counted(self):
        """Colourway-variant master names AND a product_name-only match (SKU
        absent from the master) all contribute; nothing double-counts."""
        pct, units = api_pg._st_batch_warehouse_pct(self.STYLES)[2]
        self.assertEqual(units, 90 + 60 + 50)

    def test_reorder_eat_date_boundary(self):
        """EAT (UTC+3) day boundary: 23:59 EAT the day before is out,
        00:30 EAT on the order date is in."""
        pct, units = api_pg._st_batch_warehouse_pct(self.STYLES)[3]
        self.assertEqual(units, 150)
        self.assertAlmostEqual(pct, 75.0, places=6)

    def test_dated_style_never_falls_back_to_stock(self):
        """A Re-Order style with no qualifying receipts shows (0.0, 0) even
        when the warehouse holds plenty of stock for that style."""
        self.assertEqual(api_pg._st_batch_warehouse_pct(self.STYLES)[6], (0.0, 0))

    def test_new_style_stock_fallback(self):
        """No receipt evidence → Warehouse Finished Goods stock, negatives
        clamped per row, other locations excluded."""
        pct, units = api_pg._st_batch_warehouse_pct(self.STYLES)[4]
        self.assertEqual(units, 60)
        self.assertAlmostEqual(pct, 60.0, places=6)

    def test_over_100_capped_pct_true_units(self):
        pct, units = api_pg._st_batch_warehouse_pct(self.STYLES)[5]
        self.assertEqual(units, 120)     # true receipt count survives
        self.assertEqual(pct, 100.0)     # badge value is capped

    def test_pct_units_invariant(self):
        """pct must equal min(units/qty*100, 100) and both must be >= 0."""
        got = api_pg._st_batch_warehouse_pct(self.STYLES)
        qty = {s["id"]: s["quantity"] for s in self.STYLES}
        for sid, (pct, units) in got.items():
            self.assertGreaterEqual(units, 0)
            self.assertGreaterEqual(pct, 0.0)
            self.assertAlmostEqual(
                pct, min(units / qty[sid] * 100.0, 100.0), places=9,
                msg=f"style {sid}: pct does not correspond to units/qty")

    # -- per-style delegation / parity ---------------------------------------

    def test_per_style_parity_with_batch(self):
        """_style_warehouse_pct (gate + live endpoint) must agree with the
        board batch for every fixture style."""
        batch = api_pg._st_batch_warehouse_pct(self.STYLES)
        for s in self.STYLES:
            per = api_pg._style_warehouse_pct(
                s["style_name"], s["quantity"],
                order_type=s["order_type"], order_date=s["order_date"])
            self.assertEqual(per, batch[s["id"]],
                             f"per-style != batch for style {s['id']}")

    def test_per_style_accepts_string_order_date(self):
        """The PATCH gate can pass order_date as a JSON string."""
        per = api_pg._style_warehouse_pct(
            "Vivo Test Lounge Pants in Rib", 200,
            order_type="Re-Order", order_date="2026-08-01")
        self.assertEqual(per, (75.0, 150))

    def test_gate_threshold_semantics(self):
        """The ≥90% Warehouse gate reads this exact value: style 1 (87.5%)
        stays blocked, a 350-qty order of the same receipts passes."""
        pct_blocked, _ = api_pg._style_warehouse_pct(
            "Vivo Test Amai Kaftan in Satin", 400)
        self.assertLess(pct_blocked, 90.0)
        pct_pass, _ = api_pg._style_warehouse_pct(
            "Vivo Test Amai Kaftan in Satin", 350)   # 350/350 = 100%
        self.assertGreaterEqual(pct_pass, 90.0)

    def test_invalid_inputs_zero(self):
        self.assertEqual(api_pg._style_warehouse_pct("", 100), (0.0, 0))
        self.assertEqual(api_pg._style_warehouse_pct(None, 100), (0.0, 0))
        self.assertEqual(api_pg._style_warehouse_pct("Vivo Test Scoop Top in Jersey", 0), (0.0, 0))
        self.assertEqual(api_pg._style_warehouse_pct("Vivo Test Scoop Top in Jersey", None), (0.0, 0))


# ---------------------------------------------------------------------------
# Suite 2 — the Warehouse status gate uses the EFFECTIVE row being saved
# ---------------------------------------------------------------------------

class _StubRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


@unittest.skipUnless(DB_URL, "DATABASE_URL not set")
class TestWarehouseGateEffectiveValues(unittest.TestCase):
    """API-level: a single update may change quantity/style_name TOGETHER
    with status → Warehouse. The gate must evaluate the row being SAVED, so
    its decision always agrees with the board/endpoint value computed for
    that saved row afterwards.

    Fixture: style "Vivo Test Amai Kaftan in Satin" has 350 receipt units
    (shared shadow tables); tracker row starts at quantity 350 (100%).
    """

    BASE = {
        "style_name": "Vivo Test Amai Kaftan in Satin", "brand": "VIVO",
        "category": "WOVEN", "quantity": 350, "order_type": "New",
        "order_date": None, "status": "Cutting",
        "deliver_by": date(2026, 9, 30), "iso_year": 2026, "iso_week": 40,
    }

    @classmethod
    def setUpClass(cls):
        import psycopg2
        cls.conn = psycopg2.connect(DB_URL)
        cls.conn.autocommit = True
        _seed_shadow_tables(cls.conn)
        cur = cls.conn.cursor()
        cur.execute("""
            CREATE TEMP TABLE style_tracker_styles (
                id bigint PRIMARY KEY, style_name text, brand text,
                category text, quantity int, order_date date, order_type text,
                status text, deliver_by date, deliver_by_auto date,
                iso_year int, iso_week int,
                completed boolean NOT NULL DEFAULT false,
                archived boolean NOT NULL DEFAULT false,
                archived_at timestamptz, created_by text,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now());
        """)
        cur.close()
        cls._patchers = [
            mock.patch.object(api_pg, "_users_exec",
                              side_effect=_session_exec_factory(cls.conn)),
            mock.patch.object(api_pg, "_ensure_style_tracker_tables",
                              return_value=None),
            mock.patch.object(api_pg, "_st_get_finishing_options",
                              return_value=["Cutting", "Warehouse"]),
        ]
        for p in cls._patchers:
            p.start()
        if not api_pg._ST_WAREHOUSE_GATE_ENABLED:
            raise unittest.SkipTest("warehouse gate disabled")

    @classmethod
    def tearDownClass(cls):
        for p in cls._patchers:
            p.stop()
        cls.conn.close()

    def setUp(self):
        cur = self.conn.cursor()
        cur.execute("DELETE FROM style_tracker_styles")
        cur.execute(
            "INSERT INTO style_tracker_styles (id, style_name, brand, category,"
            " quantity, order_date, order_type, status, deliver_by, iso_year,"
            " iso_week, created_by) VALUES (101, %(style_name)s, %(brand)s,"
            " %(category)s, %(quantity)s, %(order_date)s, %(order_type)s,"
            " %(status)s, %(deliver_by)s, %(iso_year)s, %(iso_week)s, 'test')",
            self.BASE)
        cur.close()

    # -- helpers -------------------------------------------------------------

    def _call(self, body, style_id=101):
        import asyncio
        import json as _json
        resp = asyncio.run(api_pg.style_tracker_update(style_id, _StubRequest(body)))
        if isinstance(resp, dict):
            return 200, resp
        return resp.status_code, _json.loads(resp.body.decode())

    def _saved(self):
        cur = self.conn.cursor()
        cur.execute("SELECT style_name, quantity, status, order_type, order_date"
                    " FROM style_tracker_styles WHERE id = 101")
        name, qty, status, otype, odate = cur.fetchone()
        cur.close()
        return {"style_name": name, "quantity": qty, "status": status,
                "order_type": otype, "order_date": odate}

    def _assert_gate_agrees_with_calc(self, effective_row, gate_passed):
        """Lockstep: gate decision == (shared calc for the effective row ≥90)."""
        pct, _units = api_pg._style_warehouse_pct(
            effective_row["style_name"], effective_row["quantity"],
            order_type=effective_row["order_type"],
            order_date=effective_row["order_date"])
        self.assertEqual(pct >= 90.0, gate_passed,
                         f"gate decision disagrees with calc ({pct}%)")

    # -- tests ---------------------------------------------------------------

    def test_status_plus_quantity_gates_on_effective_quantity(self):
        """350 receipts / OLD qty 350 = 100%, but the request saves qty 5000
        (7%) — the gate must block using the effective quantity."""
        st, resp = self._call({"status": "Warehouse", "quantity": 5000})
        self.assertEqual(st, 422, resp)
        self.assertIn("of 5000 units", resp["detail"])
        saved = self._saved()
        self.assertEqual((saved["status"], saved["quantity"]), ("Cutting", 350),
                         "blocked update must not persist anything")
        self._assert_gate_agrees_with_calc({**saved, "quantity": 5000}, False)

    def test_status_plus_style_name_gates_on_effective_name(self):
        """Renaming to a style with no receipts (stock fallback 60/350 = 17%)
        in the same request must block, even though the old name is 100%."""
        st, resp = self._call({"status": "Warehouse",
                               "style_name": "Vivo Test Tent Dress in Cotton"})
        self.assertEqual(st, 422, resp)
        saved = self._saved()
        self.assertEqual((saved["status"], saved["style_name"]),
                         ("Cutting", self.BASE["style_name"]))
        self._assert_gate_agrees_with_calc(
            {**saved, "style_name": "Vivo Test Tent Dress in Cotton"}, False)

    def test_status_only_transition_passes_and_saves(self):
        st, resp = self._call({"status": "Warehouse"})
        self.assertEqual(st, 200, resp)
        self.assertEqual(resp["style"]["status"], "Warehouse")
        saved = self._saved()
        self.assertEqual(saved["status"], "Warehouse")
        self._assert_gate_agrees_with_calc(saved, True)

    def test_simultaneous_quantity_edit_agrees_both_sides_of_threshold(self):
        """qty 400 → 350/400 = 87.5% blocks; qty 388 → 90.2% passes, and the
        board calc for the SAVED row agrees with the gate decision."""
        st, resp = self._call({"status": "Warehouse", "quantity": 400})
        self.assertEqual(st, 422, resp)
        self.assertEqual(resp["wh_units"], 350)
        self.assertAlmostEqual(resp["warehouse_pct"], 87.5, places=1)
        self._assert_gate_agrees_with_calc({**self._saved(), "quantity": 400}, False)

        st, resp = self._call({"status": "Warehouse", "quantity": 388})
        self.assertEqual(st, 200, resp)
        saved = self._saved()
        self.assertEqual((saved["status"], saved["quantity"]), ("Warehouse", 388))
        self._assert_gate_agrees_with_calc(saved, True)
        # And the board batch value for the saved row agrees numerically.
        (pct, units) = api_pg._st_batch_warehouse_pct(
            [{"id": 101, **saved}])[101]
        self.assertEqual(units, 350)
        self.assertGreaterEqual(pct, 90.0)


# ---------------------------------------------------------------------------
# Suite 3 — board response carries consistent warehouse_pct / wh_units
# ---------------------------------------------------------------------------

def _board_style(id, style_name, quantity, iso_year, iso_week,
                 order_type=None, order_date=None):
    return {
        "id": id, "style_name": style_name, "brand": "VIVO",
        "category": "WOVEN", "quantity": quantity, "order_date": order_date,
        "order_type": order_type, "status": "Finishing", "deliver_by": None,
        "deliver_by_auto": None, "iso_year": iso_year, "iso_week": iso_week,
        "completed": False, "archived": False, "archived_at": None,
        "created_by": "test", "created_at": None, "updated_at": None,
    }


class _FakeBoardDB:
    """Routes the board's queries, including the warehouse batch queries."""

    def __init__(self, styles_rows, receipt_rows=None, stock_rows=None):
        self._styles = styles_rows
        self._receipts = receipt_rows
        self._stock = stock_rows
        self.receipt_calls = 0
        self.stock_calls = 0

    def exec(self, query, params=None, fetch=False):
        q = query.strip().lower()
        if ("style_tracker_styles" in q and "style_tracker_notes" not in q
                and "style_tracker_finishing" not in q):
            return copy.deepcopy(self._styles)
        if "style_tracker_notes" in q:
            return []
        if "style_tracker_finishing_options" in q:
            return [{"id": 1, "label": "Cutting", "sort_order": 1},
                    {"id": 2, "label": "Warehouse", "sort_order": 2}]
        if "stock_transfers" in q:
            self.receipt_calls += 1
            return copy.deepcopy(self._receipts)
        if "all_inventory" in q:
            self.stock_calls += 1
            return copy.deepcopy(self._stock)
        return None


class TestBoardResponseConsistency(unittest.TestCase):
    """Response-level: warehouse_pct and wh_units in every board row must
    correspond to the same ordered quantity (this is what the % Recv badge,
    its tooltip and the XLSX export render verbatim)."""

    TODAY = date(2026, 7, 20)  # ISO week 29

    def _run_board(self, db):
        with (
            mock.patch.object(api_pg, "_users_exec", side_effect=db.exec),
            mock.patch.object(api_pg, "_ensure_style_tracker_tables", return_value=None),
            mock.patch.object(api_pg, "_st_today_eat", return_value=self.TODAY),
        ):
            return api_pg.style_tracker_board()

    def test_board_rows_consistent_including_over_100(self):
        styles = [
            _board_style(1, "Style Over", 500, 2026, 29),                 # 650 recv
            _board_style(2, "Style Part", 200, 2026, 29,
                         order_type="Re-Order", order_date=date(2026, 7, 1)),  # 90 recv
            _board_style(3, "Style None", 300, 2026, 30),                 # no evidence
        ]
        db = _FakeBoardDB(
            styles,
            receipt_rows=[{"sid": 1, "wh_units": 650}, {"sid": 2, "wh_units": 90}],
            stock_rows=[],  # style 3 falls back and finds nothing
        )
        board = self._run_board(db)
        rows = {s["id"]: s for w in board["weeks"] for s in w["styles"]}
        self.assertEqual(set(rows), {1, 2, 3})

        # Over-100%: badge value capped, true units preserved.
        self.assertEqual(rows[1]["warehouse_pct"], 100.0)
        self.assertEqual(rows[1]["wh_units"], 650)
        # Dated partial receipt.
        self.assertEqual(rows[2]["warehouse_pct"], 45.0)
        self.assertEqual(rows[2]["wh_units"], 90)
        # No evidence at all.
        self.assertEqual(rows[3]["warehouse_pct"], 0.0)
        self.assertEqual(rows[3]["wh_units"], 0)

        # The response-level invariant the UI relies on: pct, units and the
        # row's own ordered quantity always agree.
        for sid, r in rows.items():
            self.assertIsInstance(r["wh_units"], int)
            self.assertGreaterEqual(r["wh_units"], 0)
            self.assertGreaterEqual(r["warehouse_pct"], 0.0)
            self.assertLessEqual(r["warehouse_pct"], 100.0)
            self.assertAlmostEqual(
                r["warehouse_pct"],
                round(min(r["wh_units"] / r["quantity"] * 100.0, 100.0), 1),
                places=6,
                msg=f"row {sid}: warehouse_pct disagrees with wh_units/quantity")

        # Dated style must not trigger the stock fallback; style 3 must.
        self.assertEqual(db.receipt_calls, 1)
        self.assertEqual(db.stock_calls, 1)

    def test_board_rows_default_zero_when_queries_fail(self):
        """If the warehouse queries return nothing, every row still carries
        consistent zero values (keys always present)."""
        styles = [_board_style(1, "Any Style", 100, 2026, 29)]
        db = _FakeBoardDB(styles, receipt_rows=None, stock_rows=None)
        board = self._run_board(db)
        row = [s for w in board["weeks"] for s in w["styles"]][0]
        self.assertEqual(row["warehouse_pct"], 0.0)
        self.assertEqual(row["wh_units"], 0)


if __name__ == "__main__":
    unittest.main()
