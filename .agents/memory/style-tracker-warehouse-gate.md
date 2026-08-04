---
name: Style Tracker warehouse 90% gate toggle
description: The ≥90%-transferred gate on moving a style to Warehouse status is toggleable; currently OFF pending user cleanup — must be restored
---

# Style Tracker warehouse gate toggle

**Rule:** The Style Tracker's "move to Warehouse" 90% gate is controlled by the single module-level flag `_ST_WAREHOUSE_GATE_ENABLED` in the API backend (guards both the 422 enforcement in the style-update endpoint and the `meets_threshold` flag the UI pre-checks). Frontend needs no changes when toggling — it trusts `meets_threshold`.

**Status: DISABLED on 2026-08-04 at the user's request** so they can clean up legacy styles that already went warehouse→stores (their stock is no longer in Warehouse Finished Goods, so they can never satisfy the 90% check). The user said they will ask to restore it after cleanup — **if a later session touches Style Tracker, check this flag and remind the user if it is still False.**

**Why:** `_style_warehouse_pct` measures *current* stock in the warehouse location vs order qty; styles whose production already flowed through to stores read near 0% forever, permanently stuck below Warehouse status.

**How to apply:** Restore = set the flag back to `True` (comment above it says the same), compile, restart api-server, and republish (the gate matters on prod where the team works).
