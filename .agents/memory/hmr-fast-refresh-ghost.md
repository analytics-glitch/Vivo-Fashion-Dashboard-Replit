---
name: filters.jsx HMR Fast-Refresh ghost (vivo-bi)
description: Why "stuck on skeleton" + "useFilters must be used inside FiltersProvider" appear during dev edits but are NOT real bugs.
---

# filters.jsx Fast-Refresh ghost

`artifacts/vivo-bi/src/lib/filters.jsx` exports BOTH the `useFilters` hook AND
React components (e.g. `FiltersProvider`). React Fast Refresh requires a module
to export only components (or only non-components). Because this file mixes them,
every HMR update that touches `filters.jsx` (or co-updates it) prints:

- `[vite] invalidate /src/lib/filters.jsx: Could not Fast Refresh ("useFilters" export is incompatible)`
- `Invalid hook call ...`
- `useFilters must be used inside FiltersProvider` (thrown from TopNav in Sidebar.jsx)

then does a FULL page reload, which recovers cleanly.

**Why this matters:** These errors are DEV-ONLY HMR artifacts, not runtime bugs.
Production builds have no HMR and are unaffected. During a debugging session they
masquerade as a "page stuck on skeleton / Loading…" bug, especially when your own
edits trigger HMR right as you screenshot. Each `screenshot` call is also a FRESH
page load, so it routinely captures the pre-data loading state even when the page
loads fine.

**How to apply / verify the page actually loads:** trust the browser console
`loading:false ... hasKpis:true` line over a transient skeleton screenshot. The
Overview skeleton gate is `(loading || kpisLoading) && !kpis`; once `kpis` is set
the content renders. Confirm endpoints with `curl localhost:80/api/...` (go
through the proxy on :80, never the service port directly).

**Permanent fix (not yet applied — broad refactor):** move `useFilters` (and any
non-component exports) into a separate module so `filters.jsx` exports only
components; this restores Fast Refresh and removes the confusing errors. Touches
every `useFilters` import site, so it was left as a known dev wart.
