---
name: Publish blocked by poisoned rollup table names
description: Why the velocity rollup tables are named rollup_sku_velocity2 / rollup_style_velocity2 and why the old names must never be reintroduced.
---

Publish migrations repeatedly failed with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` when trying to `CREATE TABLE rollup_sku_velocity` in production — even though the prod read replica showed no such table or pg_type. Something is lodged in the prod primary's catalog under those names (orphaned type or replica-invisible state), and prod is read-only to the agent, so it can't be cleaned.

**Rule:** `rollup_sku_velocity2` and `rollup_style_velocity2` must NOT be created at app startup (`_ensure_rollup_tables`). They are created lazily inside `run_sales_rollup_refresh` on the first refresh cycle. This prevents Replit's publish migration from ever seeing them as "missing from prod" and generating a `CREATE TABLE` that races the live app.

**Why:** Replit generates `CREATE TABLE` (no IF NOT EXISTS) for every table present in dev but absent in prod. If the app also runs `CREATE TABLE IF NOT EXISTS` at startup, the two operations race on pg_type and one leaves an orphaned catalog entry. The fix is: don't create these tables at startup — let the refresh cycle own their lifecycle.

**How to apply (general rule for any app-managed cache table):** if a publish migration hits `pg_type_typname_nsp_index` on a rebuildable table, move that table's DDL out of startup hooks and into the function that populates it. Drop it from dev so the migration diff is empty. Do NOT use "copy dev data to prod" and do NOT retry the same migration. Also: the sku_velocity rollup SELECT must keep `variant_sku IS NOT NULL` (null-SKU sales rows exist and violate the PK). Also never have hand-crafted columns (e.g. generated columns added ad-hoc in dev) that are not in migrations/ — they appear in the diff and can't be applied to a large prod table without a proper migration.
