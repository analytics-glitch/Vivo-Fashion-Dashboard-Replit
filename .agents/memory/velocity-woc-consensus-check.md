---
name: Velocity vs weeks-of-cover convergence check
description: Why the cross-surface weekly-velocity check is consensus-based (median gap, 2% tol) and the field-name trap (rate_of_sale vs weekly_units).
---

Both /analytics/velocity and /analytics/weeks-of-cover share the canonical
EWMA weekly rate ((28d×2 + prior-28d)/12, BASE_FILTERS), but they name it
differently: velocity exposes it as `rate_of_sale` (rounded 1dp/row);
weeks-of-cover as `weekly_units` (2dp). Reading `weekly_units` off velocity
silently yields 0.

**Why consensus, not per-style equality:** the universes are NOT
contractually equal per style — weeks-of-cover restricts sales to the
merchandise subcategory whitelist, and velocity groups by style with
MAX(product_type), so mixed-subcat styles hide off-whitelist SKUs and carry
by-design gaps (up to ~13% observed). A real formula drift breaks EVERY
style, so the check fails only when the MEDIAN relative gap across the top-20
styles exceeds 2% (1-dp rounding alone gives ~0.5% median noise; live
baseline 0.48%).

**How to apply:** any new surface reusing the weekly rate should be added to
this consensus pattern, not to a per-style exact-equality check; and when
comparing a computed percentage against an expected 0 via `_cmp`, gate on the
tolerance BEFORE calling `_cmp` (relative-gap vs 0 always reads 100%).
