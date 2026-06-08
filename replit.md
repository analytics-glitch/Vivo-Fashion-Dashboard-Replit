# Vivo Fashion Group BI

An executive Business Intelligence cockpit for a multi-brand fashion retail group. Surfaces revenue/sales trends, brand/category/region/channel breakdowns, top products, store performance, and inventory health from a seeded PostgreSQL dataset.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Frontend: React + Vite, React Query, Recharts, @tanstack/react-table
- Build: esbuild (CJS bundle)

## Where things live

- Frontend dashboard: `artifacts/vivo-bi/src/App.tsx` (previewPath `/`); theme in `artifacts/vivo-bi/src/index.css`
- API contract (source of truth): `lib/api-spec/openapi.yaml` — 9 read-only BI GET endpoints under `/api/bi/*`
- Generated hooks/Zod schemas: `lib/api-hooks`, `lib/api-zod` (run codegen after spec edits)
- BI route handlers: `artifacts/api-server/src/routes/bi.ts` (registered in `routes/index.ts`)
- DB schema: `lib/db/src/schema/` — `salesLines` (fact), `stores` (dimension + targets), `inventory` (snapshot)

## Architecture decisions

- Single `sales_lines` fact table (16k seeded rows, 2025–2026) aggregated on-the-fly in SQL so all cross-tabs (brand/category/region/channel/store) stay internally consistent. `stores` and `inventory` are small dimension/snapshot tables.
- Reporting period is derived dynamically: `getReportingYears()` reads `MAX(year)` from the fact table (cached per process) as the current year, prior = current − 1. No hardcoded years, so comparisons stay correct as data ages.
- Every endpoint validates its output with the generated Zod response schema before sending.
- Data-viz cost discipline: React Query `staleTime` 5 min, `refetchOnWindowFocus` false.

## Product

Single-page executive dashboard: KPI row (revenue, units, margin, AOV with YoY deltas), YoY revenue trend line, channel donut, brand/category/region bar charts, inventory diagnostics (stock value vs weeks of cover), and sortable/paginated top-products & store-performance tables. Includes dark mode, print-to-PDF, per-chart CSV export, and manual/auto refresh.

## User preferences

- No emojis in the UI.
- Premium, editorial, information-dense aesthetic (warm off-white/charcoal palette, deep accent).

## Gotchas

- After editing `lib/api-spec/openapi.yaml`, always run codegen before relying on hooks/schemas. Do not change the OpenAPI `info.title` — it controls generated filenames.
- Seeding large batches via the SQL sandbox: keep multi-row INSERT chunks small (~200 rows). Large single statements fail with `E2BIG` (argument list too long).
- Reporting-year cache (`getReportingYears`) is per-process; restart the api-server after reseeding if the year range changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
