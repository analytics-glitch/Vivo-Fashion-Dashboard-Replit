---
name: Assortment pipeline and proposal freshness
description: Why assortment planning must use current Production Tracker balances and live BI inputs rather than stale completed results.
---

Assortment pipeline is the sum of current, non-terminal Production Tracker balances: ledger-owned Buying Order, Cutting, Washing, and Repairs plus live Odoo Waiting Sewing, Sewing, and Finishing. Warehouse is sellable stock and must be excluded.

**Why:** A raised buying order is not outstanding WIP after partial or near-complete production. Ledger Waiting Sewing/Sewing/Finishing can also be stale because the tracker deliberately replaces those stages with physical Odoo-location balances. Using the order quantity or both sources inflates cover and suppresses valid reorder signals.

**How to apply:** Reuse the tracker’s newest-order-first, per-SKU capped attribution for live locations and subtract Washing/Repairs overlap from live Finishing. A small residual Buying Order balance may coexist with physical WIP; suppress a non-draft Buying Order balance once physical WIP exists only when it still represents at least 90% of that order’s variant quantity. Include all retained pipeline units in planning cover.

Proposal requests must also read current commercial BI inputs and recalculate current pipeline. They may coalesce only concurrent in-flight work; never retain a completed proposal or pipeline result for reuse.

**Why:** The proposal is an operational decision. Reusing a durable BI snapshot or completed pipeline calculation can leave reorder/retire/graduate actions stale after sales, stock, or production changes.

**How to apply:** Keep historical/reporting snapshots for non-decision views, but bypass them for Assortment proposal generation. If the canonical source is cold, wait for the authoritative response or fail visibly rather than substituting replica tables or stale data.