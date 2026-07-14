---
name: Overview New/Returning revenue identity
description: New + Returning customer revenue cards must sum EXACTLY to the /api/kpis Total Sales headline
---

Rule: the Overview page's New / Returning customer revenue cards read `/api/kpis/customer-type-split`, never `/api/customer-type-spend` (Customers-page basis: gross order rows, separate Walk-in bucket — cannot reconcile to the headline).

**Why:** user mandated New + Returning == Total Sales exactly. The split endpoint guarantees it by construction: same WHERE as /api/kpis (build_filters incl. BASE_FILTERS), same signed per-row measure (sale/order + total_sales_kes, return − returns_kes), and every row lands in exactly ONE bucket ("New" = first-ever purchase in window via the unified-identity CTEs; everything else, including walk-in/anonymous and returns, is "Returning").

**How to apply:**
- Never re-round per bucket in SQL — per-bucket ROUND drifts ±1 KES from ROUND(total). Return unrounded sums; round ONCE in Python (Decimal ROUND_HALF_UP = Postgres ROUND) and derive Returning = rounded total − rounded New.
- Any future segment breakdown that must reconcile to a headline KPI should follow the same pattern: share the headline's WHERE + measure, exhaustive mutually-exclusive buckets, round once.
- `/api/customer-type-spend` keeps its own semantics (locked by xsurf_cust_* cross-surface checks); it gained an optional `channel` param but its default universe must not change.
