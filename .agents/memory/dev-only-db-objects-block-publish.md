---
name: Hand-made dev-only DB objects become publish-blocking migrations
description: Why an index/constraint created manually in the dev DB (not in code) can fail a publish on prod data, and how to keep publishes clean.
---

# Dev-only DB objects (created by hand, not in code) break publish

Replit's publish flow diffs the **dev DB schema vs the prod DB schema** and
auto-generates migration SQL to make prod match dev. So ANY index/constraint/
column that exists in the dev database but not in code will still be shipped to
prod as an auto-migration — and if prod's existing data can't satisfy it (e.g. a
UNIQUE index over rows that have duplicates), the publish fails validation
("could not create unique index").

**Why:** the diff is computed from the live databases, not from the repo. A
unique index someone created manually in dev during a debug/rebuild session is
invisible to grep but very visible to the publisher.

**How to apply:**
- If a publish fails on a `CREATE UNIQUE INDEX`/constraint you can't find in any
  DDL, check `pg_indexes`/`pg_constraint` in BOTH dev and prod. A dev-only object
  is the usual cause.
- Don't reach for the Publish UI's "Copy development database schema & data to
  production" to fix it — that overwrites ALL prod tables wholesale (users,
  sessions, loyalty, CRM), so any prod-only rows (e.g. real staff logins that
  only exist in prod) are wiped.
- Don't write prod DDL / migration scripts / startup-time DDL to force it (see
  database-migrations-on-publish skill).
- Cleanest unblock when prod data can't satisfy the constraint: remove the hard
  dependency. If app code relied on it (e.g. an `INSERT ... ON CONFLICT (<grain>)`
  whose arbiter was that unique index), move the de-dup into application code
  (dedup the batch before insert) and drop the dev-only object so the schema diff
  is clean. Prod that never had the object keeps behaving exactly as before.
- Want the DB-level guard back? First clean prod's duplicate data deliberately
  (off-peak rebuild via the REBUILD_ON_BOOT gate), THEN add the constraint via a
  normal publish once prod can satisfy it.
