---
name: OpenAPI codegen compatibility
description: The current local Orval executable cannot resolve the repository OpenAPI input, so generated outputs need a guarded recovery path.
---

The checked-in Orval 8.9.1 command currently cleans the React and Zod generated output directories, then fails with “Failed to resolve input: Please provide a valid string value or pass a loader to process the input.” The failure occurs both through the package config and direct `-i openapi.yaml` invocation.

**Why:** A failed generation can leave tracked generated clients deleted even though the source OpenAPI file is intact.

**How to apply:** Before retrying codegen, preserve or restore tracked generated files. If the resolver still fails, update the OpenAPI source and generated client/schema types manually, then run `tsc -b --force` for the affected libraries so project-reference declarations are refreshed.