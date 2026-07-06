---
name: Mobile Targets quarter snapshot QTD basis
description: Why the mobile Targets quarter view must aggregate/measure on QTD target, not full-quarter target.
---

The mobile Targets screen (`artifacts/vivo-mobile/app/targets.tsx`) builds its quarter
snapshot client-side by calling `/analytics/monthly-targets?month=…` for each of the 3
months in the selected quarter and summing per store.

**Rule:** aggregate and compute attainment on **QTD** figures — sum `mtd_target` → `qtd_target`
and `mtd_actual` → `qtd_actual`, and show attainment = `qtd_actual / qtd_target`. Do NOT
mix a full-quarter target denominator with a to-date actual.

**Why:** for the *current* quarter, future months return `mtd_target = 0` and
`mtd_actual = 0` from the backend but their **full-month `sales_target` is still non-zero**
(manual or prior-year-derived fallback). Dividing to-date actual by the full-quarter
target silently understates in-quarter attainment and contradicts a "quarter-to-date" label.

**How to apply:** when editing this screen (or porting the pattern elsewhere), keep the
target column and the attainment denominator on the summed `mtd_target`, and label it QTD.
