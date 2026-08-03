---
name: Publish blocked by poisoned rollup table names
description: Why the velocity rollup tables are named rollup_sku_velocity2 / rollup_style_velocity2 and why the old names must never be reintroduced.
---

Publish migrations repeatedly failed with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` when trying to `CREATE TABLE rollup_sku_velocity` in production — even though the prod read replica showed no such table or pg_type. Something is lodged in the prod primary's catalog under those names (orphaned type or replica-invisible state), and prod is read-only to the agent, so it can't be cleaned.

**Rule:** the SKU/style velocity rollup caches are named `rollup_sku_velocity2` and `rollup_style_velocity2`. Never rename them back to the un-suffixed names — the publish migration will deterministically fail again.

**Why:** renaming a rebuildable cache table sidesteps the poisoned catalog entry entirely; the app recreates and refills it on both sides (dev `_ensure_rollup_tables` + sync-loop refresh, prod boot + sync loop).

**How to apply:** if a publish migration ever hits `pg_type_typname_nsp_index` on a rebuildable/app-managed table, rename the table in code (all references), drop the old one in dev, refresh, and republish. Don't retry the same name and don't use the "copy dev data to prod" overwrite. Also: the sku_velocity rollup SELECT must keep `variant_sku IS NOT NULL` (null-SKU sales rows exist and violate the PK).
