---
name: Targets budget needs a code-level seed for prod
description: Why targets_monthly (leadership budget) must be bootstrapped from code, and the safe seed pattern.
---

# targets_monthly is hand-entered leadership data with no external source

`targets_monthly` (scope='region', source='budget') holds the annual leadership
budget that the Targets page (`/api/analytics/annual-targets`) measures against.
Unlike sales/fabric/production-tracker tables, it is **not** re-derived from any
external source, and there is **no targets write endpoint or admin UI** — it was
originally populated by a one-off manual import in dev.

**Why this bites:** prod is a separate DB and publish ships code+schema, not data
rows. So a fresh/empty prod `targets_monthly` makes the Targets page silently
fall back to **prior-year actuals × 1.15**. The tell-tale symptom is one market
reading absurdly high (e.g. Uganda 159% / +152% YoY) because its fallback target
(derived from last year's sales) is far below its real budget.

**Fix pattern (in `_seed_targets_budget_2026` / `_targets_startup`):** bootstrap
the budget from a code-level constant on app startup so the deployed app
self-populates prod on first boot. The seed must be:
- **Atomic + advisory-locked**: count-check and insert in ONE transaction under a
  dedicated `pg_advisory_xact_lock` so concurrent boots serialize and a crash
  can't leave a permanently partial budget (next boot heals it).
- **Completeness-based guard** (expect N rows), not a bare `COUNT>0` — a
  `COUNT>0` early-return permanently freezes a half-written partial seed.
- **ON CONFLICT (scope,name,month,source) DO NOTHING** — only ADDS missing
  rows, NEVER overwrites a value edited directly in prod.

**Why:** a startup seed is the only reliable way to get this hand-entered data
into prod given the agent can't write prod and there's no in-app entry path.
**How to apply:** each new fiscal year's budget needs either a new code seed
constant or (better) a real Targets admin write path so leadership enters it in
the app instead of re-coding it. A standalone `prod_load_targets_2026.sql` loader
also exists as a manual one-time option.
