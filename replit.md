# Vivo Fashion Group BI

An executive Business Intelligence cockpit for Vivo Fashion Group — a multi-brand fashion retailer operating across East Africa (Kenya, Uganda, Rwanda, and an Online channel). It surfaces sales/revenue, locations & channels, footfall & conversion, customers, products, and inventory health from a live PostgreSQL database. All money is in Kenyan Shillings (KES).

## Run & Operate

- API server: runs `api_pg.py` (FastAPI) via the `artifacts/api-server` workflow — `uvicorn api_pg:app --host 0.0.0.0 --port 8080`, served under `/api`
- Frontend: `pnpm --filter @workspace/vivo-bi run dev` (previewPath `/`)
- `pnpm --filter @workspace/vivo-bi run typecheck` — typecheck the dashboard
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Backend: Python FastAPI (`api_pg.py`) querying live Postgres directly, returning JSON (money in KES)
- Frontend: React + Vite, wouter (routing), React Query, Recharts, shadcn/ui
- Data fetching: a small custom `useApi` React Query hook → `GET /api/*` (no Orval/OpenAPI codegen in use)

## Where things live

- Backend: `api_pg.py` at the repo root — ~25 read-only BI GET endpoints under `/api/*`
- Frontend app shell + routes: `artifacts/vivo-bi/src/App.tsx`
- Pages (one per nav item): `artifacts/vivo-bi/src/pages/` — `overview`, `locations`, `footfall`, `customers`, `products`, `inventory`
- Data layer + response types: `artifacts/vivo-bi/src/lib/api.ts` (`useApi`, `apiGet`, `API_BASE = "/api"`)
- Global filters (date range / country / channel): `artifacts/vivo-bi/src/lib/filters.tsx`
- Shared BI components: `artifacts/vivo-bi/src/components/bi/` (Panel, KpiCard, DataTable, QueryState, ExportButton, ChartTooltip)
- Layout: `artifacts/vivo-bi/src/components/layout/` (app-shell with sidebar + PageHeader, filter-bar)
- Theme: `artifacts/vivo-bi/src/index.css`

## Access & roles

- **DISABLED FOR NOW (login + security removed):** Authentication and all access-control gating are currently bypassed so the app is fully open with no login. Restore by reverting the three choke points: backend `clerk_auth_gate` middleware in `api_pg.py` (now sets a built-in admin and skips Clerk + `app_users`), `artifacts/vivo-bi/src/lib/auth.jsx` (`AuthProvider` now returns a static admin, no Clerk hooks), and `artifacts/vivo-bi/src/components/ProtectedRoute.jsx` (now a pass-through). App.js no longer mounts `ClerkProvider`/`SignIn`/`SignUp`. The Clerk + `app_users` code and the (now unrouted) `Login`/`AccessRestricted`/`AuthCallback`/`AwaitingApproval`/`Users` pages remain in place for re-enabling. SQL-injection date-param validation in the middleware is intentionally kept. The original design is documented below for that restore.
- Identity is via Replit-managed Clerk (company domains only). Roles + approval status persist in the Postgres `app_users` table (`user_id` = Clerk sub, `email`, `name`, `role`, `status` [pending|active|disabled|rejected], `auth_method`, timestamps). Clerk proves *who you are*; `app_users` decides *what you can do*.
- First login bootstraps an admin: the very first user — or anyone whose email is in `ADMIN_BOOTSTRAP_EMAILS` (comma-separated env) — becomes `admin`/`active`. Everyone else lands `store_manager`/`pending` and sees the AwaitingApproval screen until an admin approves them.
- `api_pg.py` middleware enriches `request.state.user` with the persisted role/status, **fails closed (503)** if the user store is unreachable, blocks non-`active` users from all data (except the auth self-paths: `/api/auth/me`, `/me/status`, `/login`, `/logout`, `/heartbeat`), and gates `/api/admin/*` to admins only.
- Admin user management lives under `/api/admin/users` (list / approve / reject / role / enable-disable / delete, plus create via the Clerk Backend API). Frontend admin page: `artifacts/vivo-bi/src/pages/Users.jsx`.
- Last-admin lockout guard + first-login bootstrap run inside one advisory-locked transaction (`_users_tx(lock=True)` + `SELECT … FOR UPDATE`) so concurrent requests can never leave zero active admins. See `.agents/memory/rbac-last-admin-toctou.md`.

## Architecture decisions

- The FastAPI backend aggregates on-the-fly in SQL against the live Postgres data, so cross-tabs (country/channel/product/store) stay internally consistent.
- The frontend is multi-page (6 nav sections) rather than a single scrolling page, with a shared filter bar that drives every page via React Query keys `[path, params]`.
- Endpoint filter contracts vary and the pages respect them: footfall & weekday-pattern take `date_from`/`date_to`/`channel` (no country); customer-trend / customers-by-location / stock-to-sales take `date_from`/`date_to`/`country`; churned-customers takes `days`/`limit` only.
- Cost discipline: React Query `staleTime` 5 min, `refetchOnWindowFocus` false.
- Filter date defaults/presets are formatted in local time (not UTC) to avoid an off-by-one around midnight in East Africa (UTC+3).

## Product

A multi-page executive cockpit with a persistent sidebar and a global filter bar (date presets 7D/30D/90D/1Y + custom range, country, channel):

- Overview — KPI row, YoY/period sales trend, sales-by-country donut, channel/brand/category breakdowns
- Locations — net sales & orders by country, top markets, active selling points
- Footfall & Conversion — total footfall, outside traffic, turn-in, conversion, weekday pattern, top stores by conversion
- Customers — total/new/repeat customers, avg spend, churned count, customer-trend (new vs returning), purchase frequency
- Products — units sold, current stock, sell-through, top style, sales by subcategory, units-sold-vs-stock
- Inventory — available vs on-hand units, SKUs, locations, available stock by location
- Markdown & Clearance — markdown candidates (WoC, sell-through, recommended markdown %, est. revenue) and a clearance plan grouped by IMMEDIATE vs PLANNED urgency

Operational close-the-loop pages also exist (IBT transfer suggestions, Replenishments, Re-Order, Size Health, Store Clusters, Data Quality) with recommendation actions, bulk operations, and "Export to Operations" file downloads. The topbar carries a Data Quality status pill and a Replenishments pending-count badge.

Per-chart CSV export is available throughout.

## User preferences

- No emojis in the UI. No flag glyphs — represent countries with colored dots + the country name.
- Premium, editorial, information-dense aesthetic — warm peach background, white cards, safari-green primary (#1a5c38), dark-green sidebar. Light mode only.
- Country accent colors: Kenya #1a5c38, Uganda #d97706, Rwanda #00c853, Online #4b7bec.

## Gotchas

- ENVIRONMENT: if the `u-root-cmds` Nix package is present in `.replit` `[nix].packages`, it shadows GNU coreutils (`find`, `ls`, `sort`, `head`, `tail`, ...) with stripped-down versions. This breaks search/glob tooling AND the agent checkpoint/save step (fails with `UNKNOWN_NOT_GIT`). Remove it and fully restart the Repl. See `.agents/memory/uroot-find-breaks-checkpoint.md`.
- DEV-ONLY HMR ghost: `src/lib/filters.jsx` exports both the `useFilters` hook and components, which breaks React Fast Refresh. Editing it (or co-editing) prints `Invalid hook call` / `useFilters must be used inside FiltersProvider` then forces a full page reload that recovers. These are NOT runtime bugs — production has no HMR. They masquerade as a "stuck on skeleton / Loading…" bug, especially since each screenshot is a fresh page load that captures the pre-data loading state. Trust the console `loading:false … hasKpis:true` line over a transient skeleton screenshot. See `.agents/memory/hmr-fast-refresh-ghost.md`.
- `all_sales.sale_date` is a TEXT column. `BETWEEN '...' AND '...'` works, but date functions (`date_trunc`, `EXTRACT`) need an explicit `s.sale_date::date` cast or they error with `function date_trunc(unknown, text) does not exist`. See `.agents/memory/pg-text-date-columns.md`.
- DATA: `pos_location_name = 'vivowoman'` is the PRIMARY Kenya POS (~84% of all sales, all pre-Feb-2022 data). It must NOT be excluded in `api_pg.py` `BASE_FILTERS` or history/Kenya sales go missing. Keep excluding only `Staff purchases`/`Manual Order`/`Online - vivo-uganda`. See `.agents/memory/vivowoman-base-filter.md`.
- Churn (doc 5): churned = no transaction in the last 90 days; rate = churned / eligible base (customers whose first purchase is older than 90 days). Defined identically in `/api/customers` and `/api/customers/churn-rate`. The rate is legitimately high (~97%) because the dataset is largely historical relative to today; this is correct, not a bug.
- Recharts: a Pie with a bottom Legend can collapse its radius to ~0; pin `cx`/`cy` + radii and constrain Legend height. See `.agents/memory/recharts-donut-collapse.md`.
- The legacy Express api-server, `lib/api-spec/openapi.yaml`, and the Orval-generated `lib/api-hooks`/`lib/api-zod` are no longer wired into the running app (kept only as leftover scaffold).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
