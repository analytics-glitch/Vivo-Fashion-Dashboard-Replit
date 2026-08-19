---
name: Style Launch Planner % Recv contract
description: One receipts-first warehouse-received calculation shared by the board column, live endpoint, and ≥90% Warehouse gate.
---

The Style Launch Planner "% Recv" value comes from ONE shared calculation — the per-style helper delegates to the batch helper, so the board column, the live per-style endpoint, and the Warehouse status gate cannot drift.

**Contract:**
1. Receipts first for every style: completed finishing→warehouse transfer units, tolerantly matched on style name including colourway/variant suffixes and rows missing from the product master; each transfer row counts exactly once.
2. Re-Order/Replenishment with a parseable order date: only receipts on/after that EAT day, and NEVER a stock fallback (pre-existing stock must not satisfy the gate). Unparseable dates degrade to undated semantics.
3. New/undated styles with zero receipt evidence fall back to current Warehouse Finished Goods stock.
4. Displayed pct is capped at 100; the units value stays the true uncapped count. The frontend renders both verbatim — never add a second frontend formula.
5. The gate must evaluate the EFFECTIVE row being saved: a single update can change quantity or style name together with status, and gating on the stored row lets an invalid transition through.

**Why:** rows previously showed depleted warehouse stock (2–16%) while receipts proved 86–100%+, contradicting transfer evidence and blocking valid Warehouse transitions; a review also caught the gate passing against stale quantity during combined edits.

**How to apply:** any warehouse-received change goes into the shared batch helper only; match names at the DISTINCT-name grain (per-transfer-row tolerant matching against the full product master was ~9× slower); gate/API tests should create throwaway tracker rows or TEMP shadow tables — status updates on legacy rows without an order type 400 before reaching the gate.
