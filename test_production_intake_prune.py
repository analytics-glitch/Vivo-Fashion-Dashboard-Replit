"""Regression tests for sync_production_tracker.sync_intake (WS4 T406).

Odoo occasionally RENAMES a buying order's variant SKUs between syncs
(e.g. BO00336 V0526052* -> V0526032*). The per-(sku,size) intake delta then
treated every renamed SKU as brand-new and appended a FULL second intake,
doubling the order's buying_order stage balance (429 ordered / 858 staged).

These tests drive the REAL ``sync_intake`` against a small stateful in-memory
fake of the ``stage_movements`` table and assert:

1. A plain re-run is a no-op (idempotency, pre-existing contract).
2. A full SKU rename PRUNES the stale intake rows so total intake stays equal
   to the order quantity (the T406 fix).
3. A variant whose qty shrinks is rewritten down, never left over-counted.
4. Legacy whole-order (sku IS NULL) intake is still migrated when variants
   appear.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_production_intake_prune
"""
import unittest
from datetime import date

from sync_production_tracker import sync_intake, _valid_expected


class _FakeCursor:
    """Covers exactly the SQL shapes sync_intake issues against
    stage_movements: the legacy-row DELETE, the DISTINCT sku/size SELECT,
    the per-(sku,size) DELETE, the SUM(qty) SELECTs and the INSERTs."""

    def __init__(self):
        # each row: dict(order_ref, from_stage, to_stage, qty, sku, size, note)
        self.rows = []
        self._result = None
        self.rowcount = 0

    # -- helpers -----------------------------------------------------------
    def _intake(self, ref):
        return [r for r in self.rows
                if r["order_ref"] == ref and r["from_stage"] is None]

    def total_intake(self, ref):
        return sum(r["qty"] for r in self._intake(ref))

    # -- cursor protocol ----------------------------------------------------
    def execute(self, query, params=None):
        q = " ".join(query.split())
        self._result = None
        self.rowcount = 0
        if q.startswith("DELETE FROM stage_movements") and "sku IS NULL" in q:
            (ref,) = params
            before = len(self.rows)
            self.rows = [r for r in self.rows
                         if not (r["order_ref"] == ref
                                 and r["from_stage"] is None
                                 and r["sku"] is None)]
            self.rowcount = before - len(self.rows)
        elif q.startswith("SELECT DISTINCT sku, size FROM stage_movements"):
            (ref,) = params
            seen = []
            for r in self._intake(ref):
                if r["sku"] is not None and (r["sku"], r["size"]) not in seen:
                    seen.append((r["sku"], r["size"]))
            self._result = seen
        elif q.startswith("DELETE FROM stage_movements") and "sku = %s" in q:
            ref, sku, size = params
            before = len(self.rows)
            self.rows = [r for r in self.rows
                         if not (r["order_ref"] == ref
                                 and r["from_stage"] is None
                                 and r["sku"] == sku and r["size"] == size)]
            self.rowcount = before - len(self.rows)
        elif (q.startswith("DELETE FROM stage_movements")
              and "sku IS NOT DISTINCT FROM %s" in q):
            ref, sku, size = params
            before = len(self.rows)
            self.rows = [r for r in self.rows
                         if not (r["order_ref"] == ref
                                 and r["from_stage"] is None
                                 and r["sku"] == sku and r["size"] == size)]
            self.rowcount = before - len(self.rows)
        elif q.startswith("SELECT COALESCE(SUM(qty), 0)"):
            if "sku IS NOT DISTINCT FROM" in q:
                ref, sku, size = params
                total = sum(r["qty"] for r in self._intake(ref)
                            if r["sku"] == sku and r["size"] == size)
            else:
                (ref,) = params
                total = self.total_intake(ref)
            self._result = [(total,)]
        elif q.startswith("INSERT INTO stage_movements"):
            if "sku, size" in q:
                ref, qty, sku, size = params
            else:
                ref, qty = params
                sku = size = None
            self.rows.append({
                "order_ref": ref, "from_stage": None,
                "to_stage": "buying_order", "qty": float(qty),
                "sku": sku, "size": size,
            })
            self.rowcount = 1
        else:  # pragma: no cover
            raise AssertionError("unexpected SQL: " + q[:120])

    def fetchone(self):
        return self._result[0]

    def fetchall(self):
        return list(self._result or [])


def _variants(ref, skus, qty=10.0):
    return [{"order_ref": ref, "product_sku": s, "size": "M", "qty": qty}
            for s in skus]


class IntakePruneTests(unittest.TestCase):
    def test_rerun_is_noop(self):
        cur = _FakeCursor()
        orders = [{"order_ref": "BO1", "order_qty": 30.0}]
        variants = _variants("BO1", ["A", "B", "C"])
        sync_intake(cur, orders, variants)
        self.assertEqual(cur.total_intake("BO1"), 30.0)
        sync_intake(cur, orders, variants)
        self.assertEqual(cur.total_intake("BO1"), 30.0)
        self.assertEqual(len(cur._intake("BO1")), 3)

    def test_sku_rename_prunes_stale_rows(self):
        """The BO00336 shape: all variant SKUs renamed between syncs."""
        cur = _FakeCursor()
        orders = [{"order_ref": "BO1", "order_qty": 30.0}]
        sync_intake(cur, orders, _variants("BO1", ["OLD1", "OLD2", "OLD3"]))
        self.assertEqual(cur.total_intake("BO1"), 30.0)
        # Renamed SKUs — pre-fix this doubled intake to 60.
        sync_intake(cur, orders, _variants("BO1", ["NEW1", "NEW2", "NEW3"]))
        self.assertEqual(cur.total_intake("BO1"), 30.0)
        self.assertEqual(
            sorted(r["sku"] for r in cur._intake("BO1")),
            ["NEW1", "NEW2", "NEW3"],
        )

    def test_variant_qty_shrink_rewrites_down(self):
        cur = _FakeCursor()
        orders = [{"order_ref": "BO1", "order_qty": 20.0}]
        sync_intake(cur, orders, _variants("BO1", ["A", "B"], qty=10.0))
        self.assertEqual(cur.total_intake("BO1"), 20.0)
        sync_intake(cur, orders, _variants("BO1", ["A", "B"], qty=6.0))
        self.assertEqual(cur.total_intake("BO1"), 12.0)

    def test_legacy_whole_order_row_migrated(self):
        cur = _FakeCursor()
        cur.rows.append({"order_ref": "BO1", "from_stage": None,
                         "to_stage": "buying_order", "qty": 30.0,
                         "sku": None, "size": None})
        orders = [{"order_ref": "BO1", "order_qty": 30.0}]
        sync_intake(cur, orders, _variants("BO1", ["A", "B", "C"]))
        self.assertEqual(cur.total_intake("BO1"), 30.0)
        self.assertTrue(all(r["sku"] for r in cur._intake("BO1")))


class ValidExpectedTests(unittest.TestCase):
    """WS4 T404 — _valid_expected drops impossible ETAs (bulk-defaulted Odoo
    studio field predating the order date) and passes legit ones through."""

    def test_none_or_empty_expected(self):
        self.assertIsNone(_valid_expected(None, date(2026, 1, 1)))
        self.assertIsNone(_valid_expected("", date(2026, 1, 1)))

    def test_expected_before_ordered_is_dropped(self):
        self.assertIsNone(
            _valid_expected(date(2026, 5, 7), date(2026, 6, 1)))

    def test_expected_equal_ordered_is_kept(self):
        d = date(2026, 5, 7)
        self.assertEqual(_valid_expected(d, d), d)

    def test_expected_after_ordered_is_kept(self):
        self.assertEqual(
            _valid_expected(date(2026, 7, 1), date(2026, 6, 1)),
            date(2026, 7, 1))

    def test_missing_ordered_keeps_expected(self):
        self.assertEqual(
            _valid_expected(date(2026, 7, 1), None), date(2026, 7, 1))


if __name__ == "__main__":
    unittest.main()
