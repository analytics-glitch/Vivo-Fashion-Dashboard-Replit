---
name: IBT donor receipt cooldown
description: Stores that received a SKU within 21 days must not be asked to send it back out — the rule and where it is enforced.
---

# IBT donor receipt cooldown (21 days)

**Rule:** never RECOMMEND moving a SKU out of a store that itself received that
SKU (warehouse replen, IBT-in, or supplier drop per `stock_transfers` inbound
types) within the cooldown window (`IBT_RECEIPT_COOLDOWN_DAYS`, 21). New stock
gets a selling chance before relocation.

**Why:** explicit user business rule (Aug 2026). Recommendations-only —
operator-initiated scan-outs are deliberately NOT blocked, so the scan-out
donor re-validation stays ungated.

**How to apply:**
- Enforce at the shared recommendation boundary: the donor-side `NOT EXISTS`
  lives in the edge SQL that feeds the global solve — every live IBT surface
  consumes those edges, and the markdown/stuck-stock fork is auto-excluded
  (a just-landed item is neither movable nor "stuck").
- The SKU-breakdown drilldown must mirror the gate in LOCKSTEP but FLAG
  (`recently_received`, suggested qty forced 0) instead of dropping rows —
  rows still display availability, and the flat operations table shows
  store→store rows with stock even at suggested 0, so the UI must render the
  flag ("just in" badge) and disable actions or pickers ship just-received
  stock.
- Warehouse donors are exempt by construction: inbound-to-STORE transfer
  types never target the warehouse, so warehouse→store flows are unaffected.
