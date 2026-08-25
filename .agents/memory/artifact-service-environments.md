---
name: Artifact service environments
description: How multi-service web artifacts retain their preview configuration.
---

When a web artifact gains a second managed service, keep each service's `BASE_PATH` and port environment configuration in the validated artifact TOML; a missing block causes the Vite workflow to fail before it can bind its preview port. Alternate clean browser paths need their own service and must not also appear on the base web service, because one Vite base cannot serve both prefixes reliably. Every externally routed path must have exactly one production-capable service owner: a second artifact claiming the same path is not a harmless fallback, because the deployment proxy can select it even when the intended service has a valid handler.

**Why:** The Product Workspace API was healthy while the web workflow failed immediately because the service environment was dropped during a multi-service TOML update; later, a duplicate `/feedback` path caused the base service to claim the public route and reject it. A duplicate route claimed by an artifact with development-only configuration produced proxy-level production 500s and recurring false health-check outages while the API's liveness and readiness endpoints remained healthy.

**How to apply:** Treat the full artifact TOML as the source of truth, validate complete replacements, give every alternate prefix a unique managed service with matching `BASE_PATH`, search all artifact manifests for route overlaps, and test both the custom production URL and generated deployment URL after publishing. Restart affected workflows before diagnosing application code.