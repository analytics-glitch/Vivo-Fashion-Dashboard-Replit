---
name: BI reporting period
description: Derive the current/prior reporting year from data, never hardcode
---

For YoY dashboards backed by a fact table, compute the "current year" as `MAX(EXTRACT(YEAR FROM date))` from the data and set prior = current − 1. Cache it per process. Fall back to `new Date().getFullYear()` only if the table is empty.

**Why:** Hardcoded years silently degrade to zeros/stale comparisons once data moves past the seed range. A code reviewer flagged this as the highest-impact robustness risk in the Vivo BI build.

**How to apply:** Use a cached async helper (e.g. `getReportingYears()`) at the top of each route handler. Restart the server after reseeding if the year range changes, since the cache is per-process.
