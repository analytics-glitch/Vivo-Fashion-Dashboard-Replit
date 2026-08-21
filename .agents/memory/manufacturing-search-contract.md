---
name: Manufacturing live search contract
description: State and freshness rules for Fabric manufacturing availability
---

Manufacturing availability is scoped to Odoo `mrp.production` records with DPS references and states `confirmed` or `progress`; other lifecycle states must be excluded server-side. Search terms across the five report fields are ORed, while availability status remains an additional aggregate filter. Live Odoo suggestions may fail independently because the report uses the last synced demand and stock snapshots.

**Why:** The report combines current Odoo order identity with a synced inventory snapshot, so treating the snapshot as live Odoo data or filtering state client-side creates misleading results.

**How to apply:** Keep the target-state mapping and the separate Odoo/stock freshness signals in any future manufacturing endpoint, export, or UI change.