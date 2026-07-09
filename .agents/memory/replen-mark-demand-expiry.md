---
name: Replenishment done-mark demand-aware expiry
description: Done marks must not suppress a (store,sku) forever; they expire when post-mark sales exceed store SOH. Day-grain is the data limit.
---

# Replenishment done-mark demand-aware expiry

**Rule:** A `rec_type='replenish'` `status='done'` mark is NOT a permanent hide. At read time, every surface that applies marks must resurface the line (flip `replenished` back to false) once the store has sold more units strictly AFTER the mark's calendar day than it currently holds — a genuine new gap after the transfer. The main pick list also restates the suggestion to the post-mark gap (sold_since − soh_store, per-line capped) so pre-transfer sales already covered aren't double-counted.

**Why:** Marks had no recency logic — one done mark hid an actively-selling (store,sku) forever, so stores stopped receiving items they kept selling while warehouse stock sat idle (the user's "delays" complaint; the V0526015DOLS/M case).

**How to apply:**
- Central helper does the batched sold-since lookup and mutates rows in place; it must be called on EVERY surface that copies mark fields onto rows (main report before the warehouse-cap allocation; by-item/gaps/SOR engine flag-only). A new mark-consuming surface must call it too or surfaces disagree.
- Granularity is intentionally DAY-level: `all_sales.sale_date` is date-only, so same-day post-mark sales can't be split from the pre-transfer sales that prompted the mark. `>=` would instantly resurface fresh marks — keep strictly `>`. Worst-case latency = 1 day; do not "fix" this to timestamps (no timestamp exists).
- Re-marking done upserts `acted_at=now()`, which resets the clock — coherent with distribution batches (ledger `acted_at>=batch.created_at`).
- Helper never raises; on lookup failure marks behave as before (suppress).
