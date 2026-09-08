# Vivo Fashion Group BI

Executive BI cockpit for Vivo Fashion Group — a multi-brand fashion retailer across East Africa (Kenya, Uganda, Rwanda + Online). Surfaces sales, locations, footfall, customers, products, and inventory from a live PostgreSQL database. All money in Kenyan Shillings (KES).

## Vivo Johari (`artifacts/vivo-community`) — GitHub is the single source

This app is published from **Vivo's own server** at
`https://community.vivofashiongroup.com`, not from a Replit deployment. Work on
it happens in BOTH places — design and UI here, backend on the VM — and GitHub
is what keeps them one codebase. Neither side keeps a private copy; a second
copy is a fork with nobody reconciling it.

### ⚠️ NAME THE REMOTE. `git pull` AND `git push` DO NOT REACH GITHUB.

This workspace's `main` tracks a Replit sub-Repl remote (`subrepl-*/main`), not
GitHub, and there is no `origin`. So a bare `git pull` succeeds, reports
success, and fetches nothing of ours. The GitHub remote is named **`github`**:

```
git remote -v | grep github
# github  https://github.com/analytics-glitch/Vivo-Fashion-Dashboard-Replit.git
```

Every command below names it explicitly. Do not "fix" the tracking branch to
point at `github` — Replit's own task system uses those sub-Repl remotes, and
what depends on that upstream is not visible from here.

**Pull before touching anything under `artifacts/vivo-community/`:**

```
git stash push -u                  # only if the tree is dirty
git fetch github main
git merge github/main              # MERGE, not rebase — see below
git stash pop                      # if you stashed
```

Merge, never rebase. This branch carries hundreds of commits of unrelated
workspace history; rebasing them onto GitHub rewrites work that has nothing to
do with the community app.

Starting from a stale checkout means the next push either conflicts or silently
reverts work somebody else finished. This is not occasional: the VM pushes to
GitHub too.

**Push as soon as a change is done and your own checks pass:**

```
git push github main
```

The VM picks it up within two minutes, runs its own gate — typecheck, the
vitest suite, a production build — and publishes only if all three pass. A
commit that fails the gate publishes nothing and leaves the previous release
live, so pushing is safe; but a push IS a deploy, so push finished work rather
than a checkpoint.

Check what a push would carry before making one: `git log --oneline
github/main..main`. This repository is the whole workspace, so it will include
BI and backend commits alongside the community app. That is expected.

### The backend for this app is on the VM, not in `api_pg.py`

`/api/community/*` on `community.vivofashiongroup.com` is served by the Vivo
loyalty backend (Fastify + Prisma + Postgres), because a community member IS a
loyalty member — same account, same points wallet, same membership barcode.
`community_app.py` still serves the Replit-hosted copy of this app and should be
left alone until that copy is retired.

**So new backend endpoints for Vivo Johari are built on the VM.** Adding them to
`community_app.py` instead makes two backends answer the same paths against two
different databases, which is the one failure this split exists to prevent. Ask
for the endpoint rather than writing it here.

## Run & Operate

- API server: `api_pg.py` (FastAPI) via the `artifacts/api-server` workflow — uvicorn on port 8080, served under `/api`. Required env: `DATABASE_URL` (Neon **pooler** URL, used by the connection pool and all normal query paths) + `DATABASE_URL_DIRECT` (Neon **direct / non-pooler** URL, used by advisory locks, VACUUM, and the watchdog — see below). **When rotating either secret, update both at the same time.** `/api/readyz` checks both independently and reports `db_direct: "down"` + a warning if the direct URL is reachable after rotation; a missing `DATABASE_URL_DIRECT` falls back to `DATABASE_URL` and is logged as a startup warning.
- Frontend: `pnpm --filter @workspace/vivo-bi run dev` (previewPath `/`); typecheck with `pnpm --filter @workspace/vivo-bi run typecheck`.
- Health probes (both public): `GET /api/healthz` = DB-free liveness (always 200 when up), with `status: "ok"`, the process `started_at` ISO-8601 timestamp, and monotonic `uptime_seconds`. `GET /api/readyz` = readiness (503 when DB unreachable) + sync heartbeat state (`ok`/`warning`/`critical`/`starting`); a stale heartbeat is reported but never flips the HTTP status. The watchdog probes readyz for observability only — restart decisions stay on liveness + heartbeat. Uptime resets when the API process restarts; it is not historical availability monitoring.
- Replit monthly usage and spend are account-level platform data, not API telemetry. Check them in Replit **Settings → Account → Billing** for plan/budget details or **Settings → Account → Account usage** for resource consumption and cost breakdowns.
- Per-source sales staleness: `/api/sync-status` classifies each ACTIVE source (Kenya Odoo, Uganda, Rwanda, Shop Zetu; never retired `vivowoman`) via `sync_source_health.py` (trading-hours-aware); the topbar pill degrades naming the stale source, admins get one deduped bell alert per incident (auto-cleared on recovery), and pull failures land in `sync_health_log` (`source_failure`/`source_recovered`, rate-limited). See `.agents/memory/sales-source-staleness-watch.md`.
- Boot resiliency: ALL DB-touching startup work in `api_pg.py` must go through the `@_deferred_startup` decorator (one ordered background thread) so the port binds immediately — never a synchronous startup event. See `.agents/memory/startup-hooks-port-bind.md`.
- Pre-deploy gate: `check_python_syntax.py` byte-compiles every top-level backend `*.py`; runs as the `compile` check AND as a fail-closed boot gate in `watchdog.py` so a broken backend never promotes. Run it after every backend edit, then restart the api-server workflow.
- Heavy dashboards are kept warm by a background cache prewarmer (600s cycle, `HEAVY_DASH_TTL=900`); multi-query pages (exec-summary) use a whole-response cache. See `.agents/memory/heavy-dash-prewarm.md`.

### Production is a SEPARATE database (dev rebuilds do NOT reach prod)

Dev and the published deployment use different Postgres DBs. Prod runs `watchdog.py` (Reserved VM, `WATCHDOG_MANAGE_API=1`) = uvicorn + the incremental sync loop (`sync_incremental.py`; never the full rebuild). Publishing ships code + schema, NOT data rows — a dev rebuild fixes dev only. See `.agents/memory/prod-separate-db-rebuild.md`.

- Auxiliary surfaces self-bootstrap prod data from inside the sync loop (fabric extract, fabric-sheet override, production tracker, product images — the last runs when `product_images` is empty, then every 24h). The agent cannot write to prod; these populate after the user publishes. Verify with read-only prod queries (e.g. `SELECT COUNT(*) FROM production_orders` / `product_images`).
- Production tracker: `sync_production_tracker.py` (idempotent, upserts on `order_ref`, ensures its own schema; safe standalone). Board's Waiting Sewing / Sewing / Finishing stages are derived live from `all_inventory` Odoo locations — see `.agents/memory/production-derived-live-stages.md`.
- **Q3 targets:** after publishing a target-number update, run `DATABASE_URL=<prod_url> python3 mission420_targets.py` against production — the boot seed uses `DO NOTHING` and won't overwrite existing rows; only the script (which uses `DO UPDATE`) will.
- **Curated style tiers:** `style_tier_overrides` (Product Status sheet) reaches prod via a committed snapshot — `import_tier_overrides.py` regenerates `seed_data/style_tier_overrides.json` in the same run as every import, and a guarded boot seed (`style_tier_seed.py`, deferred startup in `api_pg.py`) replaces prod's table only when the snapshot is newer than the stored import (no-op otherwise). No scripts against prod needed; a unit test (`test_style_tier_seed`) fails if the dev table drifts from the committed snapshot.
- **Rebuild trap:** prod's `shopify_sales` is populated ONLY by `shopify_full_extract.py` (never by the sync), so a transform-only rebuild silently drops ALL Shopify retail. The one-time rebuild gate: set deployment secret `REBUILD_ON_BOOT=1` (leave `REBUILD_REFRESH_RAW=1` so all sources re-extract first; raise `REBUILD_TIMEOUT_SEC` e.g. 7200), publish off-peak, watch logs for non-zero "Shopify deduped rows" + "rebuild COMPLETED", then **unset the secret and republish**. Transform runs LAST so an aborted refresh leaves `all_sales` untouched.

### Mobile (Android / Google Play) build via EAS

`artifacts/vivo-mobile` is EAS-ready: id `com.vivofashiongroup.bi`; `eas.json` has `development`/`preview` (APK internal) and `production` (`.aab`, autoIncrement, remote versions); `metro.config.js` is monorepo-aware; unused native permissions blocked in `app.json`. Manual steps before a production build (agent cannot do these): (1) `npx eas init` to link an Expo account/projectId; (2) replace `"set-me-to-your-published-domain"` in each `eas.json` profile env with the published domain (`EXPO_PUBLIC_DOMAIN` is baked at build time); (3) if native modules aren't found, add `node-linker=hoisted` to root `.npmrc` and re-test dev. Build: `eas build --platform android --profile production`; prefer the `preview` APK or Play internal testing for this internal tool.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Backend: Python FastAPI (`api_pg.py`) querying live Postgres directly, returning JSON (KES)
- Frontend: React + Vite, wouter, React Query, Recharts, shadcn/ui
- Data fetching: custom `useApi` React Query hook → `GET /api/*` (no OpenAPI codegen in use)

## Where things live

- Backend: `api_pg.py` at the repo root — the BI GET endpoints under `/api/*`; CRM in `crm_clienteling.py`; HR in `hr_attendance.py`; fabric in `fabric_router.py`; reconciliation in `recon_engine.py`/`recon_api.py`
- Frontend app shell + routes: `artifacts/vivo-bi/src/App.tsx` (+ `App.js` route wiring); pages in `artifacts/vivo-bi/src/pages/`
- Data layer: `artifacts/vivo-bi/src/lib/api.ts` (`useApi`, `apiGet`, `API_BASE = "/api"`); global filters in `src/lib/filters.tsx`; page permissions in `permissions.js`
- Shared BI components: `src/components/bi/`; layout in `src/components/layout/`; theme in `src/index.css`

## Access & roles

- Custom Postgres email/password + Google OAuth (no Clerk/Mongo). Users in `app_users` (role, status pending|active|disabled|rejected), sessions in `user_sessions`; token in localStorage `vivo_token` sent as Bearer + httpOnly cookie.
- Passwords: stdlib PBKDF2-SHA256 (bcrypt/passlib wheels fail to build here). Google OAuth: stdlib + `requests` with a `state` cookie (not authlib/httpx). Secrets: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; redirect URI defaults from `x-forwarded-host`, override via `GOOGLE_REDIRECT_URI`.
- Seed admin on boot from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`. Allowed domains `vivofashiongroup.com` + `shopzetu.com` (`GET /api/auth/allowed-domains`); Google self-signups on those domains auto-approve into the minimal `employee` role — fenced server-side to HR Salary Advance only. See `.agents/memory/employee-self-signup-fence.md`.
- `clerk_auth_gate` middleware in `api_pg.py` is THE enforcement point: 401 unauthenticated, fails closed (503) if the user store is down, distinct 403s for non-active statuses, admin-only `/api/admin/*`, analyst+ for `/api/crm/*` and `/api/social/*`, per-group page access injected as `allowed_pages` on `/auth/me`. See `.agents/memory/group-page-access.md`, `.agents/memory/crm-authz-server-gate.md`, `.agents/memory/admin-only-page-gating.md`.
- Auth endpoints: `POST /api/auth/login|logout`, `GET /api/auth/me`, `GET /api/auth/google/login|callback` (redirects to `/auth/callback#token=…`). Admin user management: `/api/admin/users` + `src/pages/Users.jsx`. Last-admin lockout guard runs in one advisory-locked tx — see `.agents/memory/rbac-last-admin-toctou.md`.
- Web gating: `src/lib/auth.jsx`, `src/lib/api.js` (401 → `/login`), `src/components/ProtectedRoute.jsx`.
- Mobile hits the SAME gated `/api` with its own login screen (`app/login.tsx`, Google via deep link) and AsyncStorage `vivo_token`. See `.agents/memory/mobile-shares-api-auth-gate.md`, `.agents/memory/mobile-google-oauth-deeplink.md`.

## Architecture decisions

- Backend aggregates on-the-fly in SQL against live Postgres so cross-tabs stay internally consistent.
- Multi-page frontend with a shared filter bar driving every page via React Query keys `[path, params]`; endpoint filter contracts vary and pages respect them.
- Cost discipline: React Query `staleTime` 5 min, `refetchOnWindowFocus` false.
- Filter date presets are formatted in LOCAL time (East Africa UTC+3), not UTC, to avoid off-by-one at midnight.
- The filter bar's `channel` param carries `pos_location_name` values — see `.agents/memory/channel-param-pos-location.md`.

## Product surfaces

Web (vivo-bi) — persistent sidebar + global filter bar (7D/30D/90D/1Y/custom, country, channel):

- Core analytics: Overview (incl. "Projected Today" intraday forecast + Sales by Hour — see `.agents/memory/intraday-projection.md`, `.agents/memory/sales-by-hour-sources.md`), Locations, Footfall & Conversion, Customers, Products, Inventory, Exec Summary.
- Products & Range: Product Analysis, Range Management (Odoo-only retirement + advisory SOP "flagged for retirement" overlay with per-style reason — see `.agents/memory/range-mgmt-endpoints.md`, `.agents/memory/range-tier-model.md`), Weekly Style Tracker (`/style-tracker` — manual kanban by launch ISO week, seeded once via `app_config` marker).
- Product Development Flow (`/pd-flow`, page id `pd-flow`, backend `pd_flow_router.py` → `/api/pd/*`): 9-stage pre-production kanban (adopted → final_review) with assignees from `app_users`, append-only `pd_movements` log, aging vs admin-editable SLA days (`pd_stages`), detail timeline drawer, analytics/bottlenecks, completed archive, CSV exports. Same role gate as `/api/production`.
- Inventory ops: Inventory Management (`/inventory` — tabbed hub: stock, velocity & cover, stuck stock, Replenishments [+ pick distribution batches], Replenish by Style/SKU, Store Flow; old routes redirect to `?tab=`), Production Pipeline (`/production` — tracker board + report tabs), Excess Inventory (`/excess-inventory` — per-brand per-size allowance × store pack count `EXCESS_STORE_PACKS`, Online included), IBT, Re-Order, Size Health, Store Clusters, Warehouse Returns (`/warehouse-returns` — aged [store-level] or retired [Odoo status] modes), Transfer Tracking report (shared `ReplenishmentTransferReport.jsx` — see `.agents/memory/replen-done-twin-rows.md`).
- Finance / P&L (`/api/finance/pl`, WIP, admin-only, provisional tiers — see `.agents/memory/finance-pl-page.md`).
- Social (`/social`, analyst+): Facebook Page insights/posts/comments via Graph API (secrets `FACEBOOK_PAGE_ACCESS_TOKEN`/`FACEBOOK_PAGE_ID`) — see `.agents/memory/facebook-page-integration.md`. The CRM Inbox's own FB/IG/X/Google-Reviews syncs deep-backfill with resume cursors — see `.agents/memory/fb-sync-deep-backfill.md`, `.agents/memory/instagram-crm-sync.md`, `.agents/memory/x-crm-inbox-integration.md`, `.agents/memory/google-reviews-crm-inbox.md`.
- SOPs (`/sops`): 7 fixed department folders, files as BYTEA in `sop_files` (same filename = replace, 20 MB cap), per-user per-department upload grants (`sop_upload_grants`, admin panel), all writes server-enforced + audited to `app_activity_log` (admin Activity Logs page).
- Data Quality + Recommendations badges in the topbar; per-chart CSV export throughout.

Standalone surfaces (workspace is at its artifact cap — the `/fabric` static-page pattern):

- `/fabric` — fabric dashboard (`fabric_dashboard_live.html`, vanilla JS served by api_pg; XSS: always `esc()` interpolated text). Live-viewers presence via `POST /api/auth/heartbeat` + `GET /api/auth/active-viewers`. Reservation writes append best-effort audit rows to a Google Sheet (`FABRIC_LOG_SHEET_ID`, no-op when unset; sheet must be shared Editor with the connected account).
- `/reconcile` — Odoo reconciliation cockpit (`recon_dashboard.html`, admin|leadership; role gate in `clerk_auth_gate` is the enforcement; `/reconcile` must be in api-server `artifact.toml` paths). Write-back to Odoo STAGING only, disabled until `ODOO_WRITE_*` secrets exist. See `.agents/memory/recon-standalone-page.md`.

- `/loyalty-app` — served only by `api_pg.py`; root embeds `loyalty.vivofashionbrands.com` in a full-screen iframe (meta-refresh fallback). The retired Loyalty PWA service has been removed so the API service is the sole route owner.

Other artifacts:

- `artifacts/vivo-crm` (`/crm/`) — standalone Clienteling CRM ported from an external reference app; auth rewired to this project's login; backend `crm_clienteling.py` must match the frontend's verb+path+shape (reference source `/tmp/crm-ref/backend`). See `.agents/memory/vivo-crm-ported-frontend.md`.
- `artifacts/vivo-hr` (`/hr/`) — attendance dashboard; backend `hr_attendance.py` derives late/OT/absent from `vivo_attendance`. See `.agents/memory/vivo-hr-ported-frontend.md`, `.agents/memory/hr-roster-name-matching.md`, `.agents/memory/hr-attendance-tz-mislabel.md`.
- `artifacts/vivo-loyalty` (`/loyalty/`) + mobile `app/member/` — customer-facing loyalty (Carrefour-style card): self enrol/login (phone + PIN, throttled), CODE128 membership barcode, tiered earn multipliers, lazy 12-month points expiry, staff POS earn (idempotent on transaction_id), single-use redeem codes at till, redemptions report, member message inbox (scheduled via SQL time-gating, no cron). Member identity (`crm_loyalty_member`, `X-Member-Token`) is separate from staff `app_users`; the few public `/api/loyalty/*` paths are bypassed in `clerk_auth_gate`. See `.agents/memory/loyalty-member-card.md`, `.agents/memory/loyalty-tier-rules.md`.
- `artifacts/vivo-mobile` (Expo) — 4 tabs (Overview/Markets/Products/Footfall) + a "More" tab linking ~10 analytical stack screens and 5 lighter CRM screens; heavy operational tools intentionally NOT ported. Overview owns local filter state (All/Retail/Online maps to `country`). See `.agents/memory/mobile-overview-filter-mapping.md`.

In-app CRM (`src/pages/CRM.jsx`, `/api/crm/*` in `api_pg.py`): contacts/360 (FULL OUTER JOIN of `all_customers` with `crm_customer` overrides), tasks, tickets (+ complaint escalation ladder — see `.agents/memory/crm-complaint-escalation.md`), campaigns, loyalty admin, config. Brand-aware via `brand_code` (`vivo` #1a5c38, `sz` #7c3aed — colored dots, no logos).

## User preferences

- No emojis in the UI. No flag glyphs — represent countries with colored dots + the country name.
- Premium, editorial, information-dense aesthetic — warm peach background, white cards, safari-green primary (#1a5c38), dark-green sidebar. Light mode only.
- Country accent colors: Kenya #1a5c38, Uganda #d97706, Rwanda #00c853, Online #4b7bec.

## Gotchas

- JOIN RULE (user-mandated): joins between `all_sales`, `all_inventory`, `all_products_clean` MUST be on SKU (barcode acceptable) — NEVER `style_name` (~16.7k inventory rows have blank style_name). See `.agents/memory/triad-joins-sku-only.md`.
- `all_sales.sale_date` is TEXT — cast `::date` before date functions. See `.agents/memory/pg-text-date-columns.md`.
- `pos_location_name = 'vivowoman'` is the PRIMARY Kenya POS (~84% of sales) — never exclude it in `BASE_FILTERS` (only `Staff purchases`/`Manual Order`/`Online - vivo-uganda` are excluded). See `.agents/memory/vivowoman-base-filter.md`.
- Customer lifecycle: Active = last purchase <90 days; At Risk = 90–363 days; Churned = 364+ days. Returned means a new purchase after a 365+ day prior gap. Churn rate uses the 364-day assessable base.
- Backend Python packages: `uv pip install --target .pythonlibs/lib/python3.11/site-packages` (pip and the package tools fail here). See `.agents/memory/python-deps-pythonlibs.md`.
- DEV-ONLY HMR ghost: editing `src/lib/filters.jsx` prints hook errors + a transient "stuck on skeleton" — not a real bug. See `.agents/memory/hmr-fast-refresh-ghost.md`.
- ENVIRONMENT: the `u-root-cmds` Nix package shadows GNU coreutils and breaks checkpointing — remove it and fully restart if it reappears.
- Recharts: a Pie with a bottom Legend can collapse its radius to ~0; pin `cx`/`cy` + radii and constrain Legend height.
- FABRIC: Jan–Apr 2026 consumption/returns are overridden by the buying team's Google Sheet via the `fabric_moves_effective` view (survives the hourly Odoo rebuild); always read the view, never `raw_fabric_moves`. See `.agents/memory/fabric-net-consumption.md`.
- The legacy Express api-server, `lib/api-spec/openapi.yaml`, and Orval-generated `lib/api-hooks`/`lib/api-zod` are unwired leftover scaffold.

## Pointers

- `.agents/memory/MEMORY.md` — index of ~120 durable topic notes (data semantics, perf invariants, integration quirks). Check it before non-trivial work.
- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
