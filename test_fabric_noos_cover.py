"""Regression coverage for the Odoo-backed NOOS fabric cover universe."""
import datetime
import inspect
import unittest
from contextlib import contextmanager
from unittest import mock

import fabric_router as fr


class NoosUniverseTests(unittest.TestCase):
    def test_resolver_filters_to_active_yes_fabric_products(self):
        captured = {}

        def fake_q(_conn, sql, params=None):
            captured["sql"] = " ".join(sql.split())
            captured["params"] = params
            return [{"id": 8}, {"id": 12}]

        with mock.patch.object(fr, "q", fake_q):
            self.assertEqual(fr._resolve_basic_fabrics(object()), [8, 12])

        sql = captured["sql"]
        self.assertIn("category = 'Fabric'", sql)
        self.assertIn("active IS TRUE", sql)
        self.assertIn("noos_fabric IS TRUE", sql)
        self.assertIsNone(captured["params"])

    def test_empty_universe_is_safe(self):
        with mock.patch.object(fr, "q", return_value=[]):
            self.assertEqual(fr._resolve_basic_fabrics(object()), [])

    def test_card_snapshot_and_export_use_the_same_resolver(self):
        router_source = inspect.getsource(fr)
        self.assertNotIn("BASIC_FABRICS =", router_source)
        self.assertIn(
            "basic_ids = _resolve_basic_fabrics(conn)",
            inspect.getsource(fr._compute_cover_snapshot),
        )
        self.assertIn(
            "basic_ids = _resolve_basic_fabrics(conn)",
            inspect.getsource(fr.basic_fabrics_cover_xlsx),
        )
        # The summary card is the third production call site; there must be no
        # alternate supplier/code resolver left to drift from the export.
        self.assertEqual(
            router_source.count("basic_ids = _resolve_basic_fabrics(conn)"), 3
        )


class NoosSnapshotVersionTests(unittest.TestCase):
    @staticmethod
    @contextmanager
    def _conn():
        yield object()

    def test_legacy_snapshot_is_not_compared_to_new_odoo_snapshot(self):
        legacy = {
            "capture_date": datetime.date(2026, 9, 1),
            "noos_universe_version": fr._LEGACY_NOOS_SNAPSHOT_UNIVERSE,
        }
        current = {
            "capture_date": datetime.date(2026, 9, 2),
            "noos_universe_version": fr._NOOS_SNAPSHOT_UNIVERSE,
        }
        seen = {}

        def fake_q(_conn, sql, params=None):
            seen["sql"] = " ".join(sql.split())
            seen["params"] = params
            rows = [current, legacy]
            return [
                row for row in rows
                if row["noos_universe_version"] == params[0]
            ][:2]

        with (
            mock.patch.object(fr, "_get_conn", self._conn),
            mock.patch.object(fr, "_ensure_cover_snapshot_table"),
            mock.patch.object(fr, "q", fake_q),
        ):
            result = fr.cover_snapshot_delta()

        self.assertEqual(result["status"], "no_prior")
        self.assertEqual(result["capture_date"], "2026-09-02")
        self.assertIn("WHERE noos_universe_version = %s", seen["sql"])
        self.assertEqual(seen["params"], (fr._NOOS_SNAPSHOT_UNIVERSE,))

    def test_legacy_snapshot_is_not_returned_as_noos_history(self):
        current_date = datetime.date(2026, 9, 2)
        calls = []

        def fake_q(_conn, sql, params=None):
            calls.append((" ".join(sql.split()), params))
            return [{"d": current_date}]

        with (
            mock.patch.object(fr, "_get_conn", self._conn),
            mock.patch.object(fr, "_ensure_cover_snapshot_table"),
            mock.patch.object(fr, "q", fake_q),
        ):
            result = fr.cover_snapshot_lookup("2026-09-01")

        self.assertEqual(result["status"], "before_earliest")
        self.assertEqual(result["earliest_date"], "2026-09-02")
        self.assertIn("WHERE noos_universe_version = %s", calls[0][0])
        self.assertEqual(calls[0][1], (fr._NOOS_SNAPSHOT_UNIVERSE,))

    def test_snapshot_writer_persists_current_universe_version(self):
        source = inspect.getsource(fr.write_cover_snapshot)
        self.assertIn("_NOOS_SNAPSHOT_UNIVERSE", source)
        self.assertIn("noos_universe_version", source)


if __name__ == "__main__":
    unittest.main()
