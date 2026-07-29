#!/usr/bin/env python3
"""
Idempotent migration runner. Applies numbered .sql files in migrations/ that
haven't yet been recorded in schema_migrations, against $DATABASE_URL.
Safe to run repeatedly and on every deploy. Each migration runs in its own
transaction; a failure rolls back that migration and stops the run.
"""
import os, sys, glob, hashlib, psycopg2, logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("migrate")
DB = os.environ["DATABASE_URL"]
MIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")

def ensure_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     TEXT PRIMARY KEY,
            filename    TEXT NOT NULL,
            checksum    TEXT NOT NULL,
            applied_at  TIMESTAMP DEFAULT now()
        )
    """)

def applied_set(cur):
    cur.execute("SELECT version FROM schema_migrations")
    return {r[0] for r in cur.fetchall()}

def main():
    files = sorted(glob.glob(os.path.join(MIG_DIR, "*.sql")))
    if not files:
        log.info("No migration files found in %s", MIG_DIR); return
    conn = psycopg2.connect(DB); conn.autocommit = False
    cur = conn.cursor()
    ensure_table(cur); conn.commit()
    done = applied_set(cur)
    log.info("%d migrations on disk, %d already applied", len(files), len(done))
    applied_now = 0
    for path in files:
        fn = os.path.basename(path)
        version = fn.split("_")[0]  # e.g. 001_xxx.sql -> 001
        if version in done:
            continue
        sql = open(path).read()
        checksum = hashlib.sha256(sql.encode()).hexdigest()[:16]
        log.info("Applying %s ...", fn)
        try:
            # Cap lock-wait so a migration that needs AccessExclusiveLock on a
            # table the running sync-loop holds never hangs the watchdog
            # indefinitely (which would keep uvicorn from starting and cause
            # the deployment health check to time out).  30 s is generous enough
            # for any DDL on our tables but well under the 8-minute promote
            # window, so a failed migration surfaces quickly and the watchdog
            # can still boot the API.
            cur.execute("SET LOCAL lock_timeout = '30s'")
            cur.execute(sql)
            cur.execute(
                "INSERT INTO schema_migrations (version, filename, checksum) VALUES (%s,%s,%s)",
                (version, fn, checksum))
            conn.commit()
            applied_now += 1
            log.info("  ✅ %s applied", fn)
        except Exception as e:
            conn.rollback()
            log.error("  ❌ %s FAILED: %s", fn, e)
            log.error("Stopping. Fix the migration and re-run.")
            sys.exit(1)
    log.info("Done. %d new migration(s) applied.", applied_now)
    conn.close()

if __name__ == "__main__":
    main()
