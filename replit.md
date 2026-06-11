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

- Authentication is a **custom Postgres email/password + Google OAuth** system (no Clerk, no Mongo, no Emergent). Identity + roles + approval status persist in the Postgres `app_users` table (`user_id`, `email`, `name`, `role`, `status` [pending|active|disabled|rejected], `auth_method` [password|google], `password_hash`, timestamps). Sessions live in `user_sessions` (`session_token` PK, `user_id`, `expires_at`). The session token is returned in the login JSON (frontend stores it in `localStorage` key `vivo_token` and sends it as `Authorization: Bearer`) and is also set as an httpOnly `session_token` cookie.
- Passwords use **stdlib PBKDF2-SHA256** (per-user random salt, 200k iterations, `hmac.compare_digest` constant-time verify) — NOT bcrypt/passlib (those wheels fail to build in this env). Google OAuth uses stdlib + `requests` (authorization-code flow with a `state` cookie for CSRF), NOT authlib/httpx.
- A seed admin is created idempotently on boot from `SEED_ADMIN_EMAIL` (default `admin@vivofashiongroup.com`) + `SEED_ADMIN_PASSWORD`. Google sign-ups whose email is on an allowed company domain land `store_manager`/`pending` and see the AwaitingApproval screen until an admin approves them. Admin-created users (`POST /api/admin/users`) are provisioned `active` immediately (creating them is the approval).
- Allowed company domains: `vivofashiongroup.com` and `shopzetu.com` (exposed via `GET /api/auth/allowed-domains`). Google callback requires `email_verified == true` AND an allowed domain.
- `api_pg.py` `clerk_auth_gate` middleware validates the session (Bearer or cookie) → `request.state.user`, returns **401** when unauthenticated, **fails closed (503 `auth_store_unavailable`)** if the user store is unreachable, blocks non-`active` users with distinct 403 details (`account_pending_approval` / `account_rejected` / `account_disabled` / `account_inactive`) so the frontend can route, allows the auth self-paths (`/api/auth/me`, `/me/status`, `/login`, `/logout`, `/heartbeat`, Google OAuth paths), and gates `/api/admin/*` to admins only. SQL-injection date-param validation runs for every `/api` request regardless of auth.
- Auth endpoints: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/google/login`, `GET /api/auth/google/callback` (exchanges code → profile → domain check → provision → session → redirects to frontend `/auth/callback#token=…` or `#error=…`). The Google redirect URI defaults to `<scheme>://<x-forwarded-host>/api/auth/google/callback` and can be overridden with the `GOOGLE_REDIRECT_URI` env var. Requires secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- Admin user management lives under `/api/admin/users` (list / approve / reject / role / enable-disable / delete / create as a local PBKDF2 user). Frontend admin page: `artifacts/vivo-bi/src/pages/Users.jsx`.
- Frontend gating: `src/lib/auth.jsx` (`AuthProvider` — `checkAuth` via `/auth/me`, `loginWithPassword`, `completeGoogleLogin(token)`, `logout`), `src/lib/api.js` (Bearer interceptor; 401 → `/login`), `src/components/ProtectedRoute.jsx` (loading spinner → `/login` if no user → AwaitingApproval if `status != active` → admin/page checks), routes wired in `src/App.js` (`/login`, `/auth/callback` public).
- Mobile gating (`artifacts/vivo-mobile`): the Expo app hits the **same** gated `/api`, so it has its own login. The login screen (`app/login.tsx`) is a visual replica of the web `Login.jsx` (brand row, allowed-domain subtitle from `GET /api/auth/allowed-domains`, **Google sign-in** + email/password). Google uses `expo-web-browser` `openAuthSessionAsync` with a runtime deep link from `Linking.createURL("/auth/callback")` passed to the backend as a validated `return` param (see `.agents/memory/mobile-google-oauth-deeplink.md`); `lib/auth.tsx` `completeGoogleLogin(token)` finishes the session. `lib/api.ts` maps transient gateway failures (502/503/504) + transport errors to friendly messages instead of raw "Request failed (502)". `lib/api.ts` keeps a module-level token (`setAuthToken`) attached as a Bearer header on every `apiGet`/`apiPost`; a 401 fires `onUnauthorized` → clears session → `/login`. `lib/auth.tsx` (`AuthProvider`) persists the token in `AsyncStorage` key `vivo_token`, restores it on launch via `/auth/me` (must be `status==='active'`), and clears the React Query cache on login/logout so a second user can't see prior figures. `app/_layout.tsx` redirect gate (loading spinner → `/login` if unauthenticated → `/(tabs)` once authenticated); `app/login.tsx` login screen; tab screens gate queries with `enabled: status==='authenticated'`; Overview has a sign-out button. See `.agents/memory/mobile-shares-api-auth-gate.md`.
- Mobile parity screens: beyond the 4 tabs (Overview, Markets, Products, Footfall) there is a **"More" tab** (`app/(tabs)/more.tsx`) — a grouped directory + sign-out linking to 10 stack routes that replicate the web analytical pages: `app/exec-summary`, `customers`, `rfm`, `margin`, `markdown`, `inventory`, `velocity`, `size-health`, `targets`, `data-quality`. Each is an auto-registered Expo Router stack route that sets its own title via `<Stack.Screen options={{title}}/>` and uses the native themed header (`app/_layout.tsx` Stack `screenOptions`). Heavy operational tools (Allocations/IBT/Replenishment/Re-Order/Range/Marketing/Custom Report/Exports/Feedback/Store Clusters) and admin (Users/Activity Logs) are intentionally NOT ported to mobile. Shared building blocks: `components/charts.tsx` (Donut/Legend/TrendLine/BarChart on react-native-svg) and `components/screen.tsx` (Screen scaffold, KpiGrid, MiniTable, Badge). Stack screens wrap their body in `<Screen onRefresh refreshing>`; date-scoped screens render `<PresetPills/>` + `useFilters().range`. Screens with multiple queries OR-compose loading/error (or use per-section states) so a partial API failure is never shown as healthy.
- Mobile Overview (`artifacts/vivo-mobile/app/(tabs)/index.tsx`) is a snapshot cockpit mirroring the web filter bar: top app bar (Vivo logo + brand + refresh/sign-out icons), an All/Retail/Online segmented control, a Share action (RN Share API), and tappable filter chips (date preset, compare period, country) backed by a Modal bottom-sheet; KES + POS chips are static. It shows a date-range + "vs <compare>" line, a "Mobile snapshot" pill with last-refreshed time (Africa/Nairobi), a dismissable stockout-alert banner, and a 2-col KPI grid (Total Sales [accent], Net Sales, Transactions, Units Sold with vs-period deltas + action pills that deep-link to /markets, /products, /footfall; plus Total Footfall and Conversion Rate). The Overview owns its **own local** filter state (preset default "today", compare default "last_month", country) so it does NOT re-scope the other tabs; the shared `lib/filters.tsx` provider stays preset-only (default "90d") for Markets/Products/Footfall. Deltas come from two `/api/kpis` calls (current + shifted compare range) since `/api/kpis` has no built-in comparison. The segmented All/Retail/Online and the Country sheet both write the `country` param (All=""/Retail="Kenya,Uganda,Rwanda"/Online="Online"; the sheet exposes a "Retail markets" option matching the combined value) because the backend's `channel` param is `pos_location_name` and cannot express Retail-vs-Online. See `.agents/memory/mobile-overview-filter-mapping.md`.
- Last-admin lockout guard + seed/bootstrap run inside one advisory-locked transaction (`_users_tx(lock=True)` + `SELECT … FOR UPDATE`) so concurrent requests can never leave zero active admins. See `.agents/memory/rbac-last-admin-toctou.md`.

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
