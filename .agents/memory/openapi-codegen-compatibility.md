---
name: OpenAPI codegen compatibility
description: Orval is security-patched, but codegen still needs a guarded recovery path because its input resolver has failed in this repository.
---

Orval must remain at 8.21.0 or later because Replit's publish security gate blocks 8.9.1 for critical advisories. Separately, the codegen command has previously cleaned the React and Zod generated output directories, then failed with “Failed to resolve input: Please provide a valid string value or pass a loader to process the input.” The failure occurred both through the package config and direct `-i openapi.yaml` invocation.

**Why:** A failed generation can leave tracked generated clients deleted even though the source OpenAPI file is intact.

**How to apply:** Keep Orval at 8.21.0 or later and never downgrade to the vulnerable 8.9.1 release. Before retrying codegen, preserve or restore tracked generated files. If the resolver still fails, update the OpenAPI source and generated client/schema types manually, then run `tsc -b --force` for the affected libraries so project-reference declarations are refreshed.