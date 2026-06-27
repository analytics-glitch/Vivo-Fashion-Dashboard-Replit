---
name: Data-validation agent module
description: The standalone validation_agent/ package — what it is, the data definitions it resolved, and the non-obvious design constraints.
---

# validation_agent/ — self-contained data-validation agent

A NEW module (`validation_agent/`), deliberately decoupled from the BI dashboard
(hard constraint: it must never modify existing dashboard code). Entry point
`python3 -m validation_agent.run`; intended to run as an hourly Scheduled
Deployment. Reads Postgres source (`all_sales`, `footfall`) and writes ONLY to its
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
- The agent CANNOT create the Scheduled Deployment or write to prod; the user
  configures the hourly deployment and supplies alert recipients + messaging creds.
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
