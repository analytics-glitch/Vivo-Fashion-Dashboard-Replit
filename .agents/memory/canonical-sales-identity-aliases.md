---
name: Canonical sales identity aliases
description: Keep source-customer and canonical-person identity namespaces distinct.
---

Source-customer IDs and canonical person IDs are different namespaces. Carry
both meanings explicitly through internal analytics, and introduce legacy
compatibility aliases only at the API boundary.

**Why:** The same source ID can belong to different people in different stores,
while one person can own several source IDs. Reusing one generic name too early
can silently split, merge, or ambiguously filter people.

**How to apply:** Qualify source identity by store during resolution, use
canonical person identity for customer-grain analytics, and expose old response
field names only where client compatibility requires them.