---
name: PLM Style Team
description: Role-based ownership for editable Product Workspace styles.
---

The editable Product Workspace style model has four independent nullable team assignments: Designer, Pattern Maker, Sample Maker, and Buyer. They reference the workspace team directory rather than login users. Legacy `owner` remains as a fallback, and is only migrated into Designer when the normalized names match exactly.

**Why:** one owner could not represent the cross-functional handoff, while deleting or overwriting legacy owner text would lose attribution for names that are not in the current team directory.

**How to apply:** use the role IDs for writes and the joined role objects for cards/grouping. Pattern Maker grouping uses the assigned member first, then the legacy pattern-maker text; keep the legacy owner visible until a Designer is assigned.