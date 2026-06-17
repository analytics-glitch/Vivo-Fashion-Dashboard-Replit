---
name: vivo-crm ported reference frontend
description: The standalone Clienteling CRM artifact is a faithful port of an external React app; its ~120 backend endpoints are now built in crm_clienteling.py.
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

## The backend — now BUILT in `crm_clienteling.py`
The ~120 endpoints the ported frontend calls are now all implemented in `crm_clienteling.py`
(a standalone module registered onto the FastAPI app in `api_pg.py` BEFORE the StaticFiles SPA
catch-all). Groups: dashboard, customers (grid/360/timeline/nba/brief/moments/duplicates/freshness),
tasks, notes, messages, templates, segments, campaigns, insights/* (incl. cohorts), loyalty/*
(manager-facing, distinct from `/api/crm/loyalty/*`), social/*, training/*, users, audit, plus
public lookbook share links. **Source of truth for SQL/shape was the cloned reference backend**
(`git clone --depth 1 https://github.com/analytics-glitch/CRM.git /tmp/crm-ref`).

Conventions to keep consistent when extending:
- Shared helpers live at the top of `crm_clienteling.py`: `_ex(sql, params, fetch=False)` /
  `_one(sql, params, fetch=True)` run parameterized psycopg2; `_q` wraps SELECT→JSON. NEVER
  f-string user input into SQL — coerce via `_int/_num/_clamp`, dates via `_safe_date`, `IN`-lists
  via `_in_clause`.
- `all_sales.sale_date` is TEXT: every `sale_date::date` cast MUST be preceded by the `_ISO` regex
  guard in the SAME CTE's WHERE (a missed guard in a cohort CTE caused a 500 on dirty dates).
- Auth: most CRM paths flow through `clerk_auth_gate` (analyst+). `/api/loyalty/*` and `/api/public/*`
  are gate-BYPASSED in `api_pg.py`, so loyalty handlers re-check staff role via `_staff(request,
  roles=...)` manually; public lookbook paths are intentionally token-gated only.
- `crm_loyalty_ledger`'s points column is `points_change` (NOT `points`).
- Modules with thin/no data source (social/training/lookbooks/wishlists) return designed empty
  states rather than 500.
