---
name: Live vs legacy frontend (vivo-bi vs dashboard/)
description: artifacts/vivo-bi is the live app; dashboard/ (craco CRA) is dead. Don't edit the dead path.
---

# Two frontends exist — only `artifacts/vivo-bi` is live

- **LIVE:** `artifacts/vivo-bi` — Vite + React, served at `/` per its
  `.replit-artifact/artifact.toml` (`previewPath = "/"`, prod builds to
  `artifacts/vivo-bi/dist/public`, served static). This is the app the user sees and
  the only frontend the Replit path-router routes `/` to. It has ~27 pages.
- **DEAD:** `dashboard/` — a separate legacy craco CRA (its own, differing
  `Inventory.jsx` etc.; `artifacts/vivo-bi` does NOT import from it). `api_pg.py` has a
  catch-all `@app.get("/{full_path:path}")` that serves `dashboard/build` only if that
  dir exists — but the Replit proxy never routes `/` to the api-server artifact (it owns
  `/api` only), so this catch-all is unreachable in this deployment. `start_all.sh` is
  the legacy single-process launcher and is likewise unused (workflows run vivo-bi +
  uvicorn separately).

**How to apply:** Make frontend edits in `artifacts/vivo-bi/src`. Ignore specs that ask
to "rebuild dashboard with craco", "update start_all.sh", or add static-cache headers to
the FastAPI catch-all — that all targets the dead path. Backend (`api_pg.py` `/api/*`)
is shared and IS live. The DB connection pool there is already robust:
`ThreadedConnectionPool(min=2,max=20)` + an anyio thread limiter pinned to
`MAX_DB_CONNECTIONS-2` at startup so the HTTP path can never exhaust the pool.
