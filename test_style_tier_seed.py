"""Tests for the bundled style_tier_overrides seed (style_tier_seed.py).

The committed snapshot in seed_data/ is how the curated Product Status tiers
reach production: publish ships code + schema but never data rows, so without
it prod's style_tier_overrides stays empty and every surface falls back to
the computed lifecycle model (the 346-vs-920 active-styles divergence).

Two halves are protected here:

1. Snapshot integrity + LIVE parity — the committed file is well-formed and
   matches the live dev table exactly.  A hand-edit to style_tier_overrides
   that was never re-exported (run ``python3 style_tier_seed.py export`` or
   re-run ``import_tier_overrides.py``) fails this loudly — that is precisely
   the dev/prod drift the seed exists to prevent, because the boot seed
   compares version stamps, not contents.

2. apply_seed() semantics against a scratch TEMP table (never the real one):
   empty table -> applied; same version -> no-op; older contents -> replaced
   wholesale; newer contents -> left alone.

Run with::

    python -m unittest test_style_tier_seed
"""
import os
import unittest

import style_tier_seed

DB_URL = os.environ.get("DATABASE_URL")

_ALLOWED_TIERS = {"Tier 1", "Tier 2", "Tier 3", "Tier 4", "Retired", "Archived"}
_ALLOWED_STATUSES = {"Active", "Retired", "Archived"}

# Session-local scratch table (TEMP: auto-dropped, invisible to publish's
# schema diff, and can never collide with the real style_tier_overrides).
_SCRATCH = "tmp_style_tier_seed_scratch"


class TestSnapshotFile(unittest.TestCase):
    """The committed snapshot itself — no database required."""

    @classmethod
    def setUpClass(cls):
        cls.snap = style_tier_seed.load_snapshot()

    def test_snapshot_exists_and_is_well_formed(self):
        self.assertIsNotNone(
            self.snap,
            "seed_data/style_tier_overrides.json is missing — run "
            "'python3 style_tier_seed.py export' after importing the sheet")
        self.assertGreater(self.snap["row_count"], 1000)
        self.assertTrue(str(self.snap["version"]).strip())

    def test_style_numbers_unique(self):
        nums = [r[0] for r in self.snap["rows"]]
        self.assertEqual(len(nums), len(set(nums)),
                         "duplicate style_number in snapshot")

    def test_tier_and_status_vocabulary(self):
        self.assertLessEqual({r[1] for r in self.snap["rows"]}, _ALLOWED_TIERS)
        self.assertLessEqual({r[2] for r in self.snap["rows"]},
                             _ALLOWED_STATUSES)


@unittest.skipUnless(DB_URL, "DATABASE_URL not set")
class TestLiveParity(unittest.TestCase):
    """Committed snapshot must equal the live dev table (content + version)."""

    def test_snapshot_matches_live_table(self):
        import psycopg2
        snap = style_tier_seed.load_snapshot()
        self.assertIsNotNone(snap)
        conn = psycopg2.connect(DB_URL)
        try:
            cur = conn.cursor()
            cur.execute("SELECT style_number, tier, status "
                        "FROM style_tier_overrides")
            live = {(r[0], r[1], r[2]) for r in cur.fetchall()}
            cur.execute("SELECT MAX(imported_at)::text "
                        "FROM style_tier_overrides")
            live_version = cur.fetchone()[0]
            cur.close()
        finally:
            conn.close()
        snap_set = {tuple(r) for r in snap["rows"]}
        self.assertEqual(
            snap_set, live,
            "seed_data/style_tier_overrides.json no longer matches the live "
            "style_tier_overrides table — re-run import_tier_overrides.py or "
            "'python3 style_tier_seed.py export' so the change ships to "
            "production on the next publish")
        self.assertEqual(
            snap["version"], live_version,
            "snapshot version stamp != live MAX(imported_at) — re-export")


@unittest.skipUnless(DB_URL, "DATABASE_URL not set")
class TestApplySeed(unittest.TestCase):
    """apply_seed() lifecycle against a scratch TEMP table."""

    def setUp(self):
        import psycopg2
        self.conn = psycopg2.connect(DB_URL)
        self.conn.autocommit = True
        cur = self.conn.cursor()
        # Same shape as style_tier_seed.DDL, but TEMP and under a scratch name.
        cur.execute(f"""
            CREATE TEMP TABLE {_SCRATCH} (
                style_number  TEXT PRIMARY KEY,
                tier          TEXT NOT NULL,
                status        TEXT NOT NULL,
                imported_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.close()
        self.snap = style_tier_seed.load_snapshot()
        self.assertIsNotNone(self.snap)

    def tearDown(self):
        self.conn.close()  # TEMP table dies with the session

    def _exec(self, sql, params=None):
        self.conn.autocommit = True
        cur = self.conn.cursor()
        cur.execute(sql, params or ())
        out = cur.fetchall() if cur.description else None
        cur.close()
        return out

    def test_apply_seed_lifecycle(self):
        n = self.snap["row_count"]
        version = self.snap["version"]

        # 1) Empty table (production's state) -> seed applies everything.
        res = style_tier_seed.apply_seed(self.conn, self.snap, table=_SCRATCH)
        self.assertEqual(res["action"], "applied")
        self.assertEqual(res["rows"], n)
        self.assertEqual(
            self._exec(f"SELECT COUNT(*), MAX(imported_at)::text "
                       f"FROM {_SCRATCH}")[0], (n, version))

        # 2) Same version already present (dev's state) -> strict no-op.
        res = style_tier_seed.apply_seed(self.conn, self.snap, table=_SCRATCH)
        self.assertEqual(res["action"], "noop")

        # 3) Older import + a stray row -> replaced wholesale (sheet is
        #    authoritative), stray row gone, stamped with snapshot version.
        self._exec(f"UPDATE {_SCRATCH} "
                   f"SET imported_at = imported_at - INTERVAL '1 day'")
        self._exec(f"INSERT INTO {_SCRATCH} (style_number, tier, status, "
                   f"imported_at) VALUES ('ZZZ_STALE_TEST', 'Tier 1', "
                   f"'Active', %s::timestamptz - INTERVAL '1 hour')",
                   (version,))
        res = style_tier_seed.apply_seed(self.conn, self.snap, table=_SCRATCH)
        self.assertEqual(res["action"], "applied")
        self.assertEqual(res["replaced"], n + 1)
        self.assertEqual(res["rows"], n)
        self.assertEqual(
            self._exec(f"SELECT COUNT(*) FROM {_SCRATCH} "
                       f"WHERE style_number = 'ZZZ_STALE_TEST'")[0][0], 0)

        # 4) DB holds a NEWER import than the bundled snapshot (e.g. rolled-
        #    back code against a refreshed prod DB) -> left untouched.
        self._exec(f"UPDATE {_SCRATCH} "
                   f"SET imported_at = %s::timestamptz + INTERVAL '1 day' "
                   f"WHERE style_number = (SELECT MIN(style_number) "
                   f"FROM {_SCRATCH})", (version,))
        res = style_tier_seed.apply_seed(self.conn, self.snap, table=_SCRATCH)
        self.assertEqual(res["action"], "noop")

        # 5) Round-trip parity: scratch table contents == snapshot contents.
        self._exec(f"UPDATE {_SCRATCH} SET imported_at = %s::timestamptz",
                   (version,))
        live = {tuple(r) for r in self._exec(
            f"SELECT style_number, tier, status FROM {_SCRATCH}")}
        self.assertEqual(live, {tuple(r) for r in self.snap["rows"]})


if __name__ == "__main__":
    unittest.main()
