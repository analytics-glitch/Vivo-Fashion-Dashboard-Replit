---
name: vivo-crm ported reference frontend
description: The standalone Clienteling CRM artifact is a faithful port of an external React app; backend endpoints are staged and mostly missing.
---

# vivo-crm — faithful port of the external Clienteling CRM

`artifacts/vivo-crm` (slug `vivo-crm`, previewPath `/crm/`) is a faithful duplicate of the
external reference app `github.com/analytics-glitch/CRM` (24 pages + its own FastAPI). It is
**separate** from the older in-app CRM (`artifacts/vivo-bi/src/pages/CRM.jsx`, route `/crm` on
the BI app) — that one stays; this is a new standalone product the user wanted ported verbatim.

## What was ported / rewired
- Reference `src/{pages,components,contexts,lib,hooks}` copied verbatim (24 pages, ui/46).
- **Auth was the only real rewrite.** Reference used Emergent (`#session_id=` + `/auth/session`
  + `withCredentials`). Replaced with THIS project's Postgres email/password + Google backend:
  Bearer token in `localStorage` key `vivo_token`, axios baseURL `/api`, request interceptor.
  Files: `src/lib/api.js`, `src/contexts/AuthContext.jsx`, `src/pages/{Login,AuthCallback}.jsx`.
- **Role mapping:** reference gates manager pages on `user.role === "manager"`. AuthContext
  normalizes backend roles {admin,exec,manager}→"manager", everything else→"associate", keeping
  the original as `backend_role`. Only `status==='active'` users are treated as signed in.
- **Base-path routing trap:** app lives at `/crm/`, so `<BrowserRouter basename="/crm">` (derived
  from `import.meta.env.BASE_URL`). Any hard redirect (logout, Google return) MUST prefix the base
  — a bare `/login` routes to the vivo-bi SPA, not this app. `/api/*` always reaches api-server
  (proxy is most-specific-first).
- **Tailwind is v3 here, not catalog v4.** Explicit `tailwindcss ^3.4.17` + postcss + autoprefixer
  + tailwindcss-animate. `postcss.config.cjs` / `tailwind.config.cjs` MUST be `.cjs` because the
  package is `type: module` (a `.js` CommonJS config throws "module is not defined in ES module scope").
- tsconfig uses `allowJs:true, checkJs:false` (source is .jsx/.js).

## The backend gap (next staged work)
The ported frontend calls **~120 endpoints under names that DO NOT exist on `api_pg.py`** — e.g.
`/api/dashboard/me`, `/api/my-customers`, `/api/dashboard/call-list`, `/api/customers/grid`,
`/api/customers/{id}/{timeline,nba,brief,moments,...}`, `/api/insights/*`, `/api/bi/*`,
`/api/loyalty/*` (different from existing `/api/crm/loyalty/*`), `/api/social/*`, `/api/training/*`,
`/api/tasks`, `/api/templates`, `/api/segments/*`. The existing backend exposes `/api/crm/*` with
different shapes. So after login every data page currently 404s. **Source of truth for the SQL/shape
of each endpoint: the cloned reference backend at `/tmp/crm-ref/backend`** (`server.py`, `routes/`,
`insights.py`, `loyalty.py`, `training.py`, `social.py`) — re-clone with
`git clone --depth 1 https://github.com/analytics-glitch/CRM.git /tmp/crm-ref` if gone.
Plan: build endpoints in stages (customers/360/loyalty/tasks/Overview/Insights/call-list first);
modules with no data source (social/training/lookbooks/wishlists) render designed empty states.
