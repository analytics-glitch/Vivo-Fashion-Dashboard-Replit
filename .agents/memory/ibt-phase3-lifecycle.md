---
name: IBT Phase 3 lifecycle (Flow & Proof)
description: How the IBT two-sided scan lifecycle, hub ownership, soft-reservations and projection calibration fit together — and the invariants that must never be broken.
---

# IBT Phase 3 — Flow & Proof

The IBT tool moves a SKU donor→receiver. Phase 3 added the dispatch lifecycle and a
realisation feedback loop on top of the Phase-1 global solve.

## Invariants (never break these)

- **Canonical SOR is sacred:** `units_sold*100/(units_sold+store_stock)`, warehouse
  EXCLUDED from the denominator. Phase 3 must never touch this formula.
- **In-transit ownership = the HUB.** A unit that has been scanned out but not yet
  scanned in belongs to neither store, so it sits in NEITHER store's SOR while on the
  road. (Replenishment keeps its own separate in-transit quarantine.)
- **Calibration scales the PROJECTION only.** Realised÷dispatched for the latest
  landed run feeds a rolling-median factor (clamp 0.25–2.0, `app_config` key
  `ibt_proj_calibration`) that tempers the FORWARD-projected `sor_uplift_pp` /
  net-CCC. Raw values are preserved alongside as `*_raw`. The factor never alters any
  realised/canonical figure.

## Shape

- **Ledger `ibt_transfer`** (consignment_id PK): immutable at-calc snapshot captured at
  SCAN-OUT commit time (source on-hand, dest gap, net-CCC, value, curve_complete) — NOT
  written on every GET solve (the suggestions endpoint is HTTP-cached and frequently
  polled; writing there would bloat the ledger). status in_transit→received|discrepancy.
- **Shared `transfer_reservations`** (source ibt|replenishment): scan-out writes the
  donor hold as `consumed` immediately. It's the coordination point so a reserved donor
  unit is netted out of the next solve.
- **Action-time donor re-validation:** scan-out re-checks live on-hand − in-flight
  reservations; if a POS sale took the stock it returns **409 donor_stock_unavailable**
  (the SALE WINS). A lookup failure (-1 sentinel) is treated as unknown and allowed with
  a flag — never block a real move on an infra blip.
- **Reservation status counts BOTH `active` AND `consumed` (gotcha):** scan-out writes
  the donor hold as `consumed` immediately, so `_ibt_reserved_units` MUST subtract
  `active`+`consumed` (not just `active`) — otherwise the hold gives zero protection
  during the Odoo stock-extract lag and a second scan-out double-dispatches the same
  unit. Each `consumed` hold carries a bounded `expires_at` (`_IBT_INFLIGHT_HOLD_HOURS`,
  ~36h) so it stops being subtracted once all_inventory has caught up (no double-penalty)
  and the nightly sweep releases it; scan-in releases it explicitly on receipt.
- **Hub routing:** cross-store moves route donor→warehouse hub→dest BY DEFAULT and are
  charged the HONEST two-leg transit in net-CCC. Exception: a named same-mall pair
  (`IBT_SAME_MALL_PAIRS`) ships direct. Bundle carries `via_hub` + a human `route`.

## Nightly reconcile

`POST /api/ibt/nightly-reconcile` (internal-only, `_AUTH_INTERNAL_TOKEN_PATHS`,
X-Internal-Token == SESSION_SECRET) is the self-heal: ensure tables, release EXPIRED
ACTIVE reservations (stale holds that never converted to a scan-out), count overdue
in_transit (>7d, never auto-received — operator resolves via scan-in), refresh observed
corridor lead times (`_ibt_refresh_corridor_observed`, idempotent upsert, >=3 obs to
overwrite a default), and record the calibration sample.

**Why it's safe to fire every cycle in the 21:00-UTC window** (the sync hook does NOT
guard with a `_LAST_*` like the per-30min hooks): the endpoint is fully idempotent —
calibration is once-per-run_id, the upserts are idempotent, the reservation release is a
bounded UPDATE. This matches the other three 21:00 hooks (stockout snapshot,
data-quality log, replen SOR snapshot) which deliberately rely on endpoint idempotency.

## Honest scope (real vs aspirational — documented in Catalogue)

REAL: near-live read (~5min refresh) + action-time re-validation catching event lag +
nightly self-heal/corridor refresh + freshness pill from the sync heartbeat.
NOT feasible here: full Odoo event-stream / incremental partition re-solve, and
automated write-back into Odoo (the Odoo transfer ref is operator-entered, not pushed).
