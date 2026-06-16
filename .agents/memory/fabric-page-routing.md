---
name: Fabric BI full-page routing
description: Why /fabric needs api-server in its artifact.toml paths, and how the page is served
---

The `/fabric` page is a self-contained static HTML dashboard (`dashboard/build/fabric.html`, "Vivo Fabric BI") served full-page by `api_pg.py`'s `serve_react` catch-all (it special-cases `full_path == "fabric"`). Its JS calls the auth-gated `/api/fabric/*` endpoints (in `fabric_router.py`) with the session cookie carried by the full-page navigation.

**The trap:** that catch-all only fires if the request actually reaches api-server. The shared proxy routes by most-specific path; vivo-bi owns `/` and api-server owned only `/api`, so `/fabric` was being routed to the vivo-bi Vite SPA (200, but the wrong page) and the fabric handler was dead code.

**Fix / how to apply:** `/fabric` must be listed in the api-server `artifact.toml` `paths` (now `["/api", "/fabric"]`) so the proxy hands it to api_pg. Change paths only via the artifacts skill (`verifyAndReplaceArtifactToml`), then restart the api-server workflow. Same applies if any other full-page route is added under api_pg.

**Why:** without the explicit path, the proxy's `/` rule shadows it. Most-specific-first matching means adding `/fabric` does not conflict with vivo-bi's `/`.
