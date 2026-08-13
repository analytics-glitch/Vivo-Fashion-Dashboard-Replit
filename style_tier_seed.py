"""Bundled seed snapshot for the curated ``style_tier_overrides`` table.

Why this exists
---------------
The curated "Product Status" sheet is imported into the DEV database by
``import_tier_overrides.py`` (TRUNCATE + re-insert).  Publishing ships code and
schema but NEVER data rows, so production's ``style_tier_overrides`` stayed
empty and every surface there (Merchandising hub, Range Management, Product
Analysis) silently fell back to the computed lifecycle model — preview and
production disagreed on the curated range (346 vs 920 active styles).

The fix has two halves, both in this module so they cannot drift:

* ``write_snapshot`` — export the table into a committed JSON file
  (``seed_data/style_tier_overrides.json``).  ``import_tier_overrides.py``
  calls it in the same run as every sheet import, so the bundled snapshot
  always matches what dev holds.
* ``apply_seed`` — applied at boot by api_pg through the deferred-startup
  path.  It runs in ONE advisory-locked transaction and applies ONLY when the
  bundled snapshot is strictly newer than what the database holds (snapshot
  version stamp vs stored ``MAX(imported_at)``).  When it applies it REPLACES
  the table contents — the curated sheet is authoritative — and stamps every
  row with the snapshot version so the next boot compares equal and no-ops.
  Where the DB already holds the same or newer import (dev right after an
  import, or prod after the seed ran once) it is a strict no-op.

CLI (operator convenience)::

    python3 style_tier_seed.py export   # dump current table -> snapshot file
    python3 style_tier_seed.py apply    # apply bundled snapshot (guarded)
    python3 style_tier_seed.py status   # show snapshot vs DB version stamps
"""
import json
import os
import sys

import psycopg2
import psycopg2.extras

_HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT_PATH = os.path.join(_HERE, "seed_data", "style_tier_overrides.json")

TABLE = "style_tier_overrides"

# Must stay byte-compatible with the table the import script creates; the boot
# ensure step executes this so a fresh database self-creates the table.
DDL = """
CREATE TABLE IF NOT EXISTS style_tier_overrides (
    style_number  TEXT PRIMARY KEY,
    tier          TEXT NOT NULL,
    status        TEXT NOT NULL,
    imported_at   TIMESTAMPTZ DEFAULT NOW()
)
"""

# Distinct advisory-lock key (targets seed = 822026, finance map = 920122,
# style tracker seed = 733026).  Transaction-scoped locks are pooler-safe.
LOCK_KEY = 812260


def write_snapshot(conn, path=SNAPSHOT_PATH):
    """Export the current ``style_tier_overrides`` contents to the snapshot.

    Called by ``import_tier_overrides.py`` after every sheet import (and by
    the ``export`` CLI) so the committed snapshot always matches dev.  The
    version stamp is the table's ``MAX(imported_at)`` — exactly what
    ``apply_seed`` compares against — so a freshly exported snapshot is a
    guaranteed no-op on the database it came from.

    Refuses to write an empty snapshot: a broken import must never turn into
    a production wipe on the next publish.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT style_number, tier, status FROM style_tier_overrides "
        "ORDER BY style_number")
    rows = [[r[0], r[1], r[2]] for r in cur.fetchall()]
    cur.execute("SELECT MAX(imported_at)::text FROM style_tier_overrides")
    version = (cur.fetchone() or [None])[0]
    cur.close()
    if not rows or not version:
        raise RuntimeError(
            "style_tier_overrides is empty — refusing to write an empty "
            "snapshot (run import_tier_overrides.py first)")
    payload = {
        "table": TABLE,
        "version": version,  # == MAX(imported_at); apply_seed compares this
        "row_count": len(rows),
        "columns": ["style_number", "tier", "status"],
        "rows": rows,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)  # atomic — never leave a truncated snapshot
    return {"path": path, "version": version, "rows": len(rows)}


def load_snapshot(path=SNAPSHOT_PATH):
    """Read the bundled snapshot.

    Returns ``None`` when the file does not exist (a checkout from before the
    first export); raises on a malformed file so boot logs show the real
    problem instead of silently skipping the seed.
    """
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        snap = json.load(f)
    version = (snap.get("version") or "").strip()
    rows = snap.get("rows") or []
    if not version:
        raise ValueError(f"snapshot {path} has no version stamp")
    if not rows:
        raise ValueError(f"snapshot {path} has no rows")
    if len(rows) != int(snap.get("row_count") or 0):
        raise ValueError(
            f"snapshot {path} row_count={snap.get('row_count')!r} does not "
            f"match len(rows)={len(rows)} — file corrupt?")
    for r in rows:
        if not isinstance(r, (list, tuple)) or len(r) != 3 or not r[0]:
            raise ValueError(f"snapshot {path} has a malformed row: {r!r}")
    return snap


def apply_seed(conn, snapshot=None, table=TABLE):
    """Apply the bundled snapshot when it is strictly newer than the DB.

    One advisory-locked transaction (the same boot-safe pattern as api_pg's
    targets/finance seeds): concurrent boots serialize on the xact lock and a
    crash rolls back atomically — the next boot heals it.  Unlike those
    additive seeds this one REPLACES the table contents when it applies,
    because the curated sheet is authoritative for the whole table; but it
    never touches a database that already holds the same or newer import
    (``MAX(imported_at) >= snapshot version``), so dev right after an import
    is a no-op and newer production data is never clobbered by older code.

    ``table`` exists ONLY so tests can exercise the seed against a scratch /
    TEMP table — never pass untrusted input (it is interpolated as an
    identifier).
    """
    if snapshot is None:
        snapshot = load_snapshot()
    if snapshot is None:
        return {"action": "skipped", "reason": "no bundled snapshot"}
    version = snapshot["version"]
    rows = snapshot["rows"]
    if not rows:  # defensive — load_snapshot already rejects this
        return {"action": "skipped", "reason": "snapshot has no rows"}
    conn.autocommit = False
    cur = conn.cursor()
    try:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        # NULL-safe: empty table -> MAX is NULL -> COALESCE(..., FALSE) -> apply.
        cur.execute(
            "SELECT COALESCE(MAX(imported_at) >= %s::timestamptz, FALSE) "
            "FROM " + table, (version,))
        up_to_date = bool((cur.fetchone() or [False])[0])
        if up_to_date:
            conn.rollback()  # nothing to do (releases the advisory lock)
            return {"action": "noop",
                    "reason": "DB holds the same or newer import",
                    "version": version}
        cur.execute("SELECT COUNT(*) FROM " + table)
        had = (cur.fetchone() or [0])[0]
        cur.execute("DELETE FROM " + table)  # DELETE (not TRUNCATE): MVCC-safe
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO " + table +
            " (style_number, tier, status, imported_at) VALUES %s",
            [(r[0], r[1], r[2], version) for r in rows],
            template="(%s, %s, %s, %s::timestamptz)")
        cur.execute("SELECT COUNT(*) FROM " + table)
        now_have = (cur.fetchone() or [0])[0]
        conn.commit()
        return {"action": "applied", "version": version,
                "replaced": had, "rows": now_have}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _connect():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")
    return psycopg2.connect(db_url)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    conn = _connect()
    try:
        if cmd == "export":
            info = write_snapshot(conn)
            print(f"Snapshot written: {info['path']}\n"
                  f"  version: {info['version']}\n"
                  f"  rows:    {info['rows']}")
        elif cmd == "apply":
            cur = conn.cursor()
            conn.autocommit = True
            cur.execute(DDL)
            cur.close()
            res = apply_seed(conn)
            print(f"apply_seed: {res}")
        elif cmd == "status":
            snap = load_snapshot()
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*), MAX(imported_at)::text "
                        "FROM style_tier_overrides")
            n, db_ver = cur.fetchone()
            cur.close()
            print(f"snapshot: "
                  + (f"version {snap['version']}, {snap['row_count']} rows"
                     if snap else "MISSING"))
            print(f"database: version {db_ver}, {n} rows")
        else:
            sys.exit(f"unknown command {cmd!r} (use export | apply | status)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
