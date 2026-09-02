---
name: OpenAPI codegen compatibility
description: Codegen can clean generated outputs before failing on an invalid OpenAPI input, so retries need a guarded recovery path.
---

Orval codegen has cleaned the React and Zod generated output directories before failing to parse or resolve the OpenAPI input.

**Why:** A failed generation can leave tracked generated clients deleted even though the source OpenAPI file is intact.

**How to apply:** Before retrying codegen, preserve or restore tracked generated files. If the resolver still fails, update the OpenAPI source and generated client/schema types manually, then run `tsc -b --force` for the affected libraries so project-reference declarations are refreshed.