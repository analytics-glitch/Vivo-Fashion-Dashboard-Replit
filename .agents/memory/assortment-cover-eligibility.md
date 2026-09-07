---
name: Assortment cover eligibility
description: Business rule for when Assortment Plan and Merch Deep Dive may show or use weeks of cover
---

Weeks of cover is available only when a style has at least six completed selling weeks and at least six units sold in the trailing six-month source window. Until both thresholds are met, preserve the WOC response field but return it as unavailable with an explicit reason.

Unavailable cover must not trigger any cover-based reorder, overstock, clearance, or Tier 4 week-six recommendation. Tier 4 age bands are mutually exclusive: weeks 2–5 use only the week-2 read, weeks 6–11 only week 6, weeks 12–15 only week 12, and week 16 onward only week 16. A failed later-band gate must never fall back to an earlier rule.

**Why:** Very young or extremely low-volume styles produce mathematically valid but operationally misleading cover values; one new style showed roughly 691 weeks from less than one completed week of history.

**How to apply:** Keep the eligibility metadata in the shared BI merchandising source and let every consuming surface use that same decision. Never reconstruct a cover value from stock and weekly average after the source marks it unavailable. Select the Tier 4 age band first, then evaluate only that band's lifecycle rules.