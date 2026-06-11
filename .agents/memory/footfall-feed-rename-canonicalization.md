---
name: Footfall feed store-rename canonicalization
description: Why footfall→sales joins must canonicalize store names through an alias map, and the data event that made it necessary.
---

# Footfall feed store renames break conversion

The footfall sensor feed (footfallcam) silently **renamed every store on 2026-06-07**:
old canonical names stop at 2026-06-06, new spellings begin 06-07, with **no
time overlap**. Footfall is joined to sales on `pos_location_name`, so after the
rename only a subset of footfall names matched sales names. Unmatched footfall
rows joined to zero orders, collapsing Conversion Rate (it read ~1.16% instead
of the true ~11–13%).

**Fix pattern:** keep a static `FOOTFALL_LOCATION_ALIASES` dict (footfall spelling
→ canonical sales `pos_location_name`) + a `ff_canon_sql(col)` helper that emits a
`CASE` mapping, and apply it at **every** site that joins/filters/groups footfall
on store name (currently `/api/footfall`, `/api/footfall/weekday-pattern`,
`_es_footfall_by_country`, store-potential `ff` CTE). When canonicalizing inside
a GROUP BY, any channel/store filter must move to `HAVING` on the canonical name,
not `WHERE` on the raw name.

**Why:** the feed owner controls the spellings and changes them without notice;
joining on raw names is fragile. Alias keys/values are static code with no
single-quotes, so static interpolation is injection-safe.

**How to apply:** if conversion/footfall numbers drop suddenly, first check for
new unmatched footfall store names (post-canonicalization) before touching the
math. Add the new spelling to the alias map. Two aliases mapping to the same
canonical name only overcounts if old+new names co-exist for the same store/day;
this feed migrates with no overlap, so it's safe.

**Tooltip consistency:** the web Overview conversion KPI (`aggFootfall`) DOES
exclude stores with conversion_rate > 50 (data-quality rule); the **Footfall
page** conversion KPI does NOT (outliers included per user request). Any
formula/tooltip text must match the page it's on — do not claim a >50% exclusion
on the Footfall page.
