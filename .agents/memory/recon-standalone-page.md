---
name: Recon spin-off at artifact cap
description: How the Odoo Reconciliation UI became a standalone /reconcile page instead of a new artifact
---

**Rule:** when the workspace is at its artifact cap (createArtifact fails), a "standalone app" request for a surface that already lives on the shared FastAPI backend is satisfied with the `/fabric` pattern: a self-contained static HTML SPA at the repo root, served full-page by `api_pg.py` via in-memory `HTMLResponse` (never FileResponse — GZip pathsend 500s in prod), routes registered OUTSIDE the build_dir guard/catch-all, and the path added to the api-server `artifact.toml` `paths` (else the proxy sends it to the vivo-bi SPA).

**Why:** the 7-artifact cap is a hard platform limit and there is no deleteArtifact callback; the /fabric precedent already proved the pattern in prod (see fabric-page-routing.md).

**How to apply:** `/reconcile` (recon_dashboard.html) is the second such page. The standalone page keeps its own login against the shared `/api/auth/*` (shared `vivo_token` localStorage key so BI sessions carry over); client role checks are UX only — the server gate in `clerk_auth_gate` (role-based, e.g. admin|leadership for `/api/recon`) is the enforcement, and the page id must NOT stay in `_LEADERSHIP_PAGES`/permissions.js once spun off (or Group Access shows a ghost page).
