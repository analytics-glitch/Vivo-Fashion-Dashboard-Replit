---
name: SOP workflow stage and revision invariants
description: Durable compatibility and audit rules for the staged SOP repository.
---

Keep legacy Approved and Obsolete stage IDs stable when inserting or reordering workflow stages; display order and internal identity are separate concerns.

**Why:** Existing SOP rows and historical stage events refer to internal IDs, so renumbering IDs would silently reinterpret history.

**How to apply:** Add new stages with unused IDs, then control user-facing numbering through stage names/order.

Every SOP content save and every stage transition must append an immutable content snapshot in the same database statement as the update.

**Why:** A stage event alone proves that a move happened but cannot prove which exact wording was reviewed or approved.

**How to apply:** Retained direct transition routes and editor transitions must both increment the revision and insert the snapshot atomically. Replacing a stage-one upload starts a clean revision history.