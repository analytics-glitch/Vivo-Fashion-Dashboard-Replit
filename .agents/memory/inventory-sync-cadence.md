---
name: Inventory sync cadence (fast poll)
description: Why all_inventory is refreshed on a short interval, not nightly, and the knob that controls it.
---

# Inventory sync is a FAST POLL, not nightly

The Odoo/Shopify/Shop Zetu inventory extracts (feeding `all_inventory`) run on a
short interval in `sync_incremental.py` (default 5 min, env `INVENTORY_SYNC_INTERVAL_SEC`),
gated by a module-level `_LAST_INVENTORY_SYNC` guard, NOT the old once-a-day
21:00-UTC hour window.

**Why:** with nightly-only inventory, shelf stock was up to ~24h stale, so the
replenishment engine could recommend moving a unit that had already sold earlier
that day ("stock already gone"). Sales already sync every minute; inventory was
the lagging side. User explicitly chose fast polling (over webhooks) to close this
gap with zero new credentials/infra.

**How to apply:** if tuning sync load, this cadence is deliberate — don't revert
it to nightly. The guard stamps `_LAST_INVENTORY_SYNC` up front so a transient
extract failure waits the full interval instead of hammering Odoo/Shopify every
60s. Raise `INVENTORY_SYNC_INTERVAL_SEC` if the three extracts get heavy rather
than re-windowing. Webhooks (true event-driven, needs Shopify admin access) were
the deferred alternative.
