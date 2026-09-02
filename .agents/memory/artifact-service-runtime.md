---
name: Artifact service runtime
description: Environment, route ownership, and dependency packaging rules for artifact-managed services.
---

Preserve every managed service's environment block and give each externally routed path exactly one production-capable owner. Alternate browser prefixes need their own correctly based service rather than overlapping route claims.

**Why:** Dropped `BASE_PATH` or port settings can stop a service before it binds, while duplicate route owners let the deployment proxy choose a broken service even when the intended handler is healthy.

**How to apply:** Treat the full validated artifact manifest as the source of truth, preserve complete service env blocks, search all manifests for route overlaps, and verify both development and production routes after changes.

Package runtime dependencies during the production build when the deployed image may omit the workspace dependency tree; launch the generated or installed runtime rather than assuming development packages exist.

**Why:** Artifact production images can omit workspace dependencies, causing a service to exit before binding and making the supervisor recycle otherwise healthy services.

**How to apply:** Build or install the service's runtime dependencies in its production build, retain its route and port declarations, and verify readiness from the produced runtime.