---
name: Dot-replit schema replacement
description: Direct .replit edits are rejected and must use the validated replacement flow.
---

Direct edits to `.replit` are rejected by the workspace guard. Write the complete candidate TOML to a workspace-relative temporary file, then use the schema-validation replacement callback.

**Why:** This preserves Replit's workflow, port, and environment schema instead of allowing a partial or malformed configuration edit.

**How to apply:** When changing `.replit`, preserve the full current file, make the intended edit in a temporary candidate, validate-and-replace it, then remove the temporary file.