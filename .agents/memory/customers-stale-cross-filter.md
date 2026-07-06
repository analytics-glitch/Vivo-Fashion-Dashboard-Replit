---
name: Customers page stale cross-filter KPIs
description: Why the Customers page could show a previous country's KPIs after a filter change, and the fix pattern.
---

# Stale cross-filter KPIs on filter change

Symptom: switching the global filter (e.g. All → Uganda) left the primary KPI
tiles (Total/New/Returning/AvgSpend) showing the PREVIOUS scope, while
walk-in / incomplete-profile tiles switched correctly.

**Root cause:** the primary `/customers` endpoint is behind an upstream
circuit-breaker and is the heaviest customer query, so a filter-change re-fetch
can fail fast. The fetch effect used `isFirstLoad = !cust` (false on a filter
change), so no skeleton was shown, and the `catch` set an error banner but
never cleared/updated `cust` — leaving the old scope's numbers on screen. The
walk-in tiles read from a separate, breaker-free `/customers/walk-ins` endpoint
so they switched, making the divergence look like a country-filter bug.

**Fix pattern:** compute a `filterSig` of the inputs that change what a payload
MEANS (date range, countries, channels, compareMode) and keep it in a ref. In
the effect, treat a signature change as first-load: show the skeleton and reset
the primary payloads (`cust`/`custPrev` → null) BEFORE re-fetching, so a failed
re-fetch shows loading/error, never stale cross-filter data. Keep the
no-blink auto-refresh by NOT resetting when the signature is unchanged (the 30s
tick / dataVersion bump don't change the signature).

**Why:** any page that keeps a prior payload visible across a scope change must
gate that payload by the scope it was fetched under, or a fail-fast/slow
re-fetch silently misrepresents one scope's data as another's.

**Related:** the `Delta` growth pill must guard a tiny/zero comparison base
(prev==0 → "new"; clamp |pct|>=1000 to ">999%") or a near-empty prior-year
window renders absurd four-digit YoY percentages.
