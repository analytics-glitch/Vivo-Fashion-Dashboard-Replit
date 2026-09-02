---
name: Style Development tracker imports
description: Durable data-boundary and fidelity rules for Product Development Tracker batch imports.
---

Product Development Tracker batch imports belong in a dedicated tracker model rather than replacing the broader product catalogue or generic PLM records. Imports may replace the tracker view without deleting unrelated style data.

**Why:** The tracker carries exact operational statuses, target order weeks, source taxonomy labels, and incomplete or malformed style numbers that do not fit the catalogue's stricter lifecycle model.

**How to apply:** Preserve the supplied status text exactly; store normalized and original sub-category values separately; map NEW to Tier 4 and RR to Tier 3; represent missing numbers as null with a needs-number flag; retain malformed source text alongside the normalized display number. New week batches should append through versioned, idempotent imports.