---
name: Artifact service environments
description: How multi-service web artifacts retain their preview configuration.
---

When a web artifact gains a second managed service, keep each service's `BASE_PATH` and port environment configuration in the validated artifact TOML; a missing block causes the Vite workflow to fail before it can bind its preview port. Alternate clean browser paths need their own service and must not also appear on the base web service, because one Vite base cannot serve both prefixes reliably.

**Why:** The Product Workspace API was healthy while the web workflow failed immediately because the service environment was dropped during a multi-service TOML update; later, a duplicate `/feedback` path caused the base service to claim the public route and reject it.

**How to apply:** Treat the full artifact TOML as the source of truth, validate complete replacements, give every alternate prefix a unique managed service with matching `BASE_PATH`, and restart affected workflows before diagnosing application code.