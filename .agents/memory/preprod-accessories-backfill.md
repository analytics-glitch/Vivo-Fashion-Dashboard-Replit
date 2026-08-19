---
name: Pre-production Accessories % retrofit
description: One-time migration contract for legacy Pre-production Accessories percentages and retained no-history snapshots.
---

# Pre-production Accessories % retrofit

**Rule:** The controlled retrofit selects one qualifying Done-DPS month once and
applies that same precise pooled percentage to every legacy Pre-production
sheet. Sheets with no qualifying history keep their existing percentage and
Accessories amount, with explicit retained/no-history provenance. The
retrofit marker makes reruns no-ops; future sheets continue using the normal
qualifying-month picker.

**Why:** Legacy sheets must become auditable without silently changing
approved costs, while newly created sheets should follow the current
Done-DPS-based rule.

**How to apply:** Keep the maintenance operation admin-only, lock the parent
sheet row during ordinary saves, preserve retained amounts from the saved row
server-side, and surface the persisted provenance consistently in payloads,
lists, editor labels, and PDF text.