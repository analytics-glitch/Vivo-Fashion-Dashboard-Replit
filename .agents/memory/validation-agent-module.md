---
name: Data-validation agent module
description: The standalone validation_agent/ package — what it is, the data definitions it resolved, and the non-obvious design constraints.
---

# validation_agent/ — self-contained data-validation agent

A NEW module (`validation_agent/`), deliberately decoupled from the BI dashboard
(hard constraint: it must never modify existing dashboard code). Entry point
`python3 -m validation_agent.run`. Reads Postgres source (`all_sales`, `footfall`) and writes ONLY to its
own three tables: `metric_baselines`, `validation_audit`, `validation_exceptions`.
It never mutates source tables except through `governance.apply_fix()`.

## Five steps
1. consistency (Tier-1 arithmetic identities), 2. learned-range (Tier-2, 90d
rolling baselines, z>3 / p1-p99 / IQR / PoP cap, seasonality by dow+promo),
3. Anthropic `claude-sonnet-4-6` diagnosis (DATA_ERROR vs REAL_BUSINESS_EVENT)
via the managed AI integration proxy, 4. governance fence, 5. GREEN/AMBER/RED
alerting (email + WhatsApp, degrades gracefully when creds/recipients missing).

## Data definitions this agent had to RESOLVE (no pre-aggregated metrics table exists)
- Canonical fact = `all_sales` (1.5M rows); `sale_date` is TEXT (cast `::date`).
- `units_sold` = GROSS `ordered_item_quantity` on sale/order rows; `transactions`
  = COUNT(DISTINCT order_id); money cols are the `*_kes` sums.
- **`total_sales` is VAT-INCLUSIVE**: `total ≈ net × (1+0.16)` (observed group
  ratio 1.1592). So "(total − net) ≈ returns+discounts+tax" from generic retail
  does NOT apply — returns/discounts are already out of `net`.
- **`net = gross − discounts − returns` is OFF by a structural ~−3.55%** at group
  level — a real cross-channel definitional gap, NOT an error. So that identity's
  hard tolerance is widened (`VALIDATION_NET_COMP_TOL`, default 0.06) AND the
  signed residual is tracked as its own learned metric (`net_comp_residual`) so
  genuine drift is still caught without 800+ daily false positives.
- footfall feed's own conversion / transaction-count columns are EMPTY, so
  `conversion_rate` MUST be derived cross-source = transactions / footfall;
  structural check is conversion ≤ 1. Footfall starts 2026-03-28 and only ~29 of
  54 store names match `all_sales.pos_location_name` (known rename issue).

## Non-obvious constraints / gotchas
- **Performance:** baseline history must be loaded ONCE per run into an in-memory
  index (`baselines.load_index`) and inserts batched with `execute_values`;
  per-row history SELECTs + `executemany` made a 90d run hang for minutes against
  the remote DB.
- **Governance invariant (spec + code review):** anything NOT auto-fixable MUST
  escalate — there is no silent "log only" path. Auto-fix requires ALL of:
  reversible (UPDATE only), a registered pattern that allowlists the exact target
  table(s), AND materiality < KES 50,000. Default pattern registry is EMPTY, so
  everything escalates until an operator adds a pattern. `apply_fix` re-validates
  the built SQL against the fence (verb + forbidden-keyword + target allowlist).
- Dry-run (`--dry-run --days 90`) sends no alerts and applies no fixes but DOES
  fold baselines (idempotent upsert) — it bootstraps the agent.
- LLM diagnosis is the slow step (~30s/call serial); bound it with
  `VALIDATION_MAX_DIAGNOSES` (default 20) — a full dry-run with many diagnoses
  exceeds short timeouts. Diagnosis never blocks a run (failures → INSUFFICIENT_DATA).
- **Production scheduling = sync-loop hook, NOT a separate Scheduled Deployment.**
  A single Replit project has one deployment type; the prod app is a Reserved VM,
  which is mutually exclusive with a Scheduled deployment in the same project. So
  (user chose this over a 2nd project) the agent is invoked from inside the existing
  always-on incremental sync loop (`sync_incremental.py main()`): an hourly module
  guard `_LAST_VALIDATION_RUN` (stamp-up-front, ≥3600s, matches the attendance/fabric
  pattern) runs it as a `python3 -m validation_agent.run` subprocess (check=True,
  timeout=900, isolated process so a failure/hung LLM can't crash or stall the loop).
  This is the SOLE allowed edit to existing dashboard code for this feature. The agent
  self-skips outside its 06:00–22:00 Africa/Nairobi window (`config.within_active_hours`
  in `run.main`), so the hourly cadence yields one audit/hour only in-window — no extra
  UTC gate needed in the loop. **Why:** one-deployment-per-project + always-on VM means
  a piggyback hook is the only way to get hourly prod runs without a 2nd project.
- The agent CANNOT write to prod itself; the user supplies alert recipients +
  messaging creds (SendGrid/Twilio). Alerting degrades gracefully without them
  (records audit, no notification) until creds are added — then alerts flow with no
  code change. Recipients are shared env (present in prod).
- **First-run auto-seed (fresh prod DB):** a live run (not dry-run/backfill) where
  `metric_baselines` is effectively empty (`count_points < MIN_HISTORY_POINTS`)
  widens the FOLD window to ~90d (`fold_days`) so Tier-2 works from day one — but
  the VALIDATION/report window stays at the normal recent `days`. Tier-1 runs over
  all fold rows ONLY to build `blocked` (never fold a bad historical day); a Tier-1
  fail becomes a reported exception / governance / alert ONLY when
  `period_date >= report_start`. So seeding never emits historical alerts or
  attempts historical auto-fixes. Summary/window/definitions scope to report_rows.
  **Why:** prod is a separate, initially-empty DB and the agent can't run a manual
  prod backfill — without this, Tier-2 stays silent ~10 days. Seed detection is a
  global count (fold is one batched execute_values = all-or-nothing on a fresh DB).

## Step 6 — cross-surface (cross-page) consistency (`cross_surface.py`)
- Different dashboard pages render the SAME metric from DIFFERENT `/api` endpoints,
  so a SQL drift in one endpoint silently makes two pages disagree even when the
  data is fine. This step is the guard for that class of bug: it reconciles the
  headline `/api/kpis` against every endpoint that decomposes the same measures —
  `/api/analytics/total-sales-summary` (direct), Σ`/api/daily-trend`,
  Σ`/api/sales-summary`, Σ`/api/country-summary` (date-only scenarios only) — plus
  the inventory pair `/api/inventory-summary` vs `/api/analytics/inventory-summary`
  and its internal `total_units == Σ by_location == Σ by_subcat`.
- **It is the ONLY agent step that talks HTTP, and it is strictly read-only.** It
  logs in once with the seed-admin creds (`SEED_ADMIN_EMAIL` default
  `admin@vivofashiongroup.com` + `SEED_ADMIN_PASSWORD`), caches the Bearer, retries
  once on 401, and only GETs. NO dashboard/endpoint code is touched. **Why:** the
  task's hard constraint — verify cross-page agreement without modifying the
  surfaces being verified, so the check can never paper over the bug it's hunting.
- API base = `http://localhost:<PORT>/api` (PORT defaults 8080 in BOTH dev workflow
  and the prod watchdog/Reserved VM), env-overridable via `VALIDATION_API_BASE`.
  Same port in both because the agent runs as a subprocess on the SAME VM as uvicorn.
- **Never raises into the sync loop** (defence-in-depth): `run_checks(period)` returns
  `(exceptions, skip_reason)` and converts unreachable-API / bad-login / per-scenario
  errors into a skip string; `run.py` also wraps the call in try/except. A flaky API
  is a skip, never a crash. Runs in dry-run too (read-only); skipped only on backfill.
- **Cross-surface decides its OWN severity and bypasses governance/auto-fix** (these
  breaks are never auto-fixable — you can't UPDATE a row to fix two disagreeing
  endpoints). RED if money gap ≥ `MATERIALITY_KES` (50k) OR relative gap ≥
  `CROSS_SURFACE_RED_REL` (1%), else AMBER. A mismatch only counts when BOTH
  rel > `CROSS_SURFACE_TOL` (0.05%) AND abs gap > a floor (money 100 KES / count 2) —
  the floor absorbs per-bucket integer ROUNDing (Σ of N ROUNDed rows vs the ROUNDed
  grand total differs by ~N/2). Exceptions still upsert + fold into reds/ambers →
  overall colour → alert payload like any Tier-1 break (entity_type `cross_surface`,
  entity = scenario e.g. `30d_all`/`30d_kenya`/`inventory`, period_date = run day).
- Filter-contract gotcha that drives the scenario design: `country-summary` takes
  date ONLY (no country/channel) → reconciled only in the no-filter scenarios;
  `daily-trend` takes date+country (no channel); `sales-summary`/`total-sales-summary`
  take date+country+channel (full kpis contract). `daily-trend`'s units column is
  `units` (NOT `units_sold`); country/sales-summary use `units_sold`; kpis uses
  `total_units`/`total_orders` vs the decomposition's `units`/`orders`.
