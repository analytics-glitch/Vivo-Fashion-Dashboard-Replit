---
name: Product master atomic rebuild
description: Transaction and health invariants for rebuilding all_products_clean without exposing partial generations
---

**Rule:** Build and validate the complete product generation before publishing it. The staged build, transaction-scoped single-flight lock, previous-generation backup, live replacement, and stage removal must stay in one PostgreSQL transaction. Keep the live table object and replace its rows rather than renaming tables.

**Why:** Committing a truncate or insertion batches exposed empty and partial product universes to BI readers. Session locks and post-commit stage cleanup are unsafe with transaction pooling and concurrent rebuilds. A single transaction makes readers retain the old generation until they briefly wait for, then see, the complete new generation.

**How to apply:** Reject a staged generation below 80% of the locked live row count or with implausible lifecycle status sets. Publish Active, Retired, and Archived caches from one guarded query result; rejected results retain the last good cache. Track rebuild and status-snapshot health as separate streams so one stream's recovery cannot hide the other's failure.