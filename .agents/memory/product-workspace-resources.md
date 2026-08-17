---
name: Product Workspace Resources
description: Resources library behavior, seed policy, and authorization boundaries.
---

Resources are stored as markdown in the Product Workspace database and seeded idempotently by title; bootstrap must never overwrite an existing document because admins can edit seeded references.

**Why:** The library is a living operating reference, so preloaded documents need a safe starting state without erasing later team edits on API restarts.

**How to apply:** Keep reads behind the workspace session, enforce admin-only create/edit/delete in the API (not only in the UI), and render markdown through a safe structured renderer with real HTML tables.