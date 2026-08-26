---
name: Retiring routed artifacts
description: How to prevent a retired artifact from retaining a conflicting public route.
---

Retire an obsolete routed artifact through the validated artifact-manifest replacement flow by leaving it service-free and giving its archive a non-conflicting preview path; then remove its vestigial source files.

**Why:** Removing the old application code alone does not remove the artifact's route claim. A duplicate public path can be sent to the retired service and turn an otherwise healthy API route into a monitoring outage.

**How to apply:** Preserve the intended route on its single live service, confirm the retired manifest has no `services` entries, and add a smoke assertion that detects both exact and nested path claimants before publishing.