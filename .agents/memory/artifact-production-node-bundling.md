---
name: Production Node server bundling
description: Why an artifact-managed Node API should not rely on workspace node_modules at runtime.
---

For an artifact-managed Node service that must keep a port open in a multi-artifact deployment, produce a self-contained Node bundle during the production build and launch that bundle rather than importing runtime dependencies from the workspace.

**Why:** The production image can serve static artifacts while omitting the workspace's Node dependency tree. A Node API then exits before binding its configured port; the artifact supervisor treats that as an incomplete deployment and restarts every runnable service, taking otherwise healthy routes down.

**How to apply:** Keep typechecking before bundling, target the deployed Node runtime, include package dependencies in the server bundle, and verify its readiness endpoint from the generated output. Do not remove the artifact's frontend/static build or its service port and route declarations.