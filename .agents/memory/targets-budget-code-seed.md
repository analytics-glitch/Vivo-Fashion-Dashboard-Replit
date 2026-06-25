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

# Other tables in this same "hand-entered, empty in prod" class

`finance_account_map` (account_code → pl_group/pl_section, feeds the Finance/P&L
page) had the identical problem: no external source, AND no CREATE TABLE in code
either — it was hand-created in dev, so a fresh prod DB had the table (from
schema migration) but zero rows, silently breaking the P&L matrix. Fixed the
SAME way: ship the DDL (`_ensure_finance_account_map`) + a guarded, advisory-
locked, completeness-checked, ON CONFLICT DO NOTHING seed (`_seed_finance_account_map`)
called from the `_targets_startup` hook. No PII, so a code seed is acceptable.

**Contrast — when NOT to use a code seed:** `hr_employees` (the staff roster) is
also empty in prod, but it (a) contains PII (names, staff numbers) and (b) HAS an
external source (a Google Sheet, one tab per entity). For that class, build a
sheet-backed bootstrap that re-reads the source on an empty prod table (like
`_sync_training` / the fabric & production-tracker sync-loop bootstraps), then
run `_hr_rematch` — do NOT hardcode the roster into source (PII + goes stale).
The general rule: no external source → code seed; external source or PII →
re-read the source via a bootstrap.
