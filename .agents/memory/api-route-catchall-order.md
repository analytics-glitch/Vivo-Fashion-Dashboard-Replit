---
name: API routes must precede the SPA catch-all
description: New @app.get /api/* routes defined after the SPA catch-all route in api_pg.py silently 404 — registration order matters in Starlette.
---

# New API routes must be registered BEFORE the SPA catch-all

`api_pg.py` ends with a static-serving block: `@app.get("/{full_path:path}")`
(the React SPA catch-all), whose guard returns `{"detail":"Not found"}` 404
for any unmatched `api/…` path. Starlette matches routes in REGISTRATION
order, so any `@app.get("/api/…")` defined in the file AFTER that block is
silently dead: auth passes (401 without a token) but the route 404s with
`{"detail":"Not found"}`.

**Why:** the planning-calendar endpoint was first added at the bottom of the
file (near its seed hook) and returned 404 despite compiling and the seed
running fine — cost a debugging round to spot the shadowing.

**How to apply:** define new routes above the `# Serve React build as static
files` block (a warning comment sits there now). Symptom signature: endpoint
401s unauthenticated but 404s `{"detail":"Not found"}` authenticated →
check registration order first, not the auth middleware.
