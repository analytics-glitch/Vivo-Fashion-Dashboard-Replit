---
name: Production workspace revision integrity
description: Rules for immutable planning revisions and plan-local child references.
---

Planning inputs such as operations/SAMs, assignments, capacity, and readiness must belong to a specific plan revision, not only to the shared work item. Reopening must clone the complete planning snapshot into a new revision while preserving the frozen source unchanged. Every plan and its inputs must also resolve to one factory/line/shift context.

**Why:** Work-item-scoped inputs let later edits silently alter the meaning of an approved/frozen revision. Foreign keys alone also permit an assignment on one plan to point at an operation from another—or a plan to use a different factory's line, machine, calendar, or capability—corrupting the snapshot without an obvious database error.

**How to apply:** Scope plan inputs with `plan_version_id`; clone all planning inputs during governed reopen; reject duplicate reopening from a frozen source. Validate plan-local and factory/line/shift child links in the route and with a database trigger/constraint so a future direct-SQL route cannot bypass the invariant.

The factory, line, and shift on a plan header are editable only before its first operation, assignment, or capacity input; changing context afterwards requires a governed revision.

**Why:** Reparenting a populated draft header leaves existing inputs tied to the former factory context and corrupts the frozen snapshot before it is even submitted.

**How to apply:** Reject a header-context update in both API and database whenever detailed plan inputs exist; do not rely only on frozen-state immutability.

When one PostgreSQL trigger function is attached to tables with different row shapes, read optional fields through `to_jsonb(NEW)` rather than direct `NEW.column` access.

**Why:** PostgreSQL can evaluate a missing `NEW` field before a table-name branch excludes it, breaking unrelated writes such as creating a machine.

**How to apply:** Either use a dedicated trigger function per table or use `to_jsonb(NEW)->>'field_name'` for fields absent from any attached table.