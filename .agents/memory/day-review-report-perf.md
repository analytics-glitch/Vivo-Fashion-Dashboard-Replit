---
name: Day in Review conventions
description: Baseline + access-model decisions for the Day in Review report, and the shared-PG concurrency rule multi-section reports must follow.
---

**Norm convention:** a day's "norm" = average of the prior 4 same weekdays, **always ÷ 4** even when a store traded zero on one of them.
**Why:** this is the convention that reproduced the 2026-08-11 manual leadership analysis exactly; changing it silently changes every mover/callout.
**How to apply:** any new day-review measure (or a rebuilt baseline) must keep the ÷4 rule, and its headline must come from the canonical KPI function so it stays byte-identical to Overview.

**Access model:** Day in Review is leadership + admin ONLY — excluded from SMT like finance/margin. The API gate, `DEFAULT_ROLE_PAGES["smt"]` filter, and the permissions.js SMT filter must move in lockstep or SMT sees a nav entry that 403s.
**Why:** SMT's page set derives from LEADERSHIP-minus-exclusions, so a leadership-gated API without the SMT exclusion produces a visible-but-broken page (completion review rejected exactly this).

**Concurrency rule:** don't fan a multi-section report out wide — the shared Postgres serializes under ~6+ concurrent heavy scans and every section gets slower than running fewer at once (a 1.4 s scan degraded ~6×).
**Why:** small shared instance + constant background sync load; parallelism beyond ~4 workers is negative-sum.
**How to apply:** keep a low-worker section executor, one bounded grouped query per section (never N per-date endpoint calls), slice one cached wide-window scan per request, and prewarm only the default (yesterday) view.
