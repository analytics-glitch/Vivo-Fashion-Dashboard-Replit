---
name: Assortment pipeline current-stage source
description: Why assortment planning must use Production Tracker stage balances rather than buying-order quantities.
---

Assortment pipeline is the sum of current, non-terminal Production Tracker balances: ledger-owned Buying Order, Cutting, Washing, Repairs, and Defects plus live Odoo Waiting Sewing, Sewing, and Finishing. Warehouse is sellable stock and must be excluded.

**Why:** A raised buying order is not outstanding WIP after partial or near-complete production. Ledger Waiting Sewing/Sewing/Finishing can also be stale because the tracker deliberately replaces those stages with physical Odoo-location balances. Using the order quantity or both sources inflates cover and suppresses valid reorder signals.

**How to apply:** Reuse the tracker’s newest-order-first, per-SKU capped attribution for live locations and subtract Washing/Repairs/Defects overlap from live Finishing. Count Buying Order balances and include all resulting pipeline units in planning cover.