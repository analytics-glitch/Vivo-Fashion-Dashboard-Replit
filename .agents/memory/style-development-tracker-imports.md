---
name: Style Development tracker imports
description: Durable data-boundary and fidelity rules for Product Development Tracker batch imports.
---

Product Development Tracker batch imports belong in a dedicated tracker model rather than replacing the broader product catalogue or generic PLM records. Imports may replace the tracker view without deleting unrelated style data.

**Why:** The tracker carries exact operational statuses, target order weeks, source taxonomy labels, and incomplete or malformed style numbers that do not fit the catalogue's stricter lifecycle model.

**How to apply:** Preserve every supplied source value exactly, including status casing, names, taxonomy text, week spacing, and blank fabric values; map NEW to Tier 4 and RR to Tier 3. A declared replacement batch must atomically clear tracker rows before inserting its versioned baseline; later batches append through separate versioned, idempotent imports. Treat spaced and unspaced WK labels as sortable equivalents without rewriting them. Normalize whitespace and repeated hyphen separators only while parsing date fields because source sheets can contain both `22-Jun- 2026` and `18- Aug-2026`; retain the source text elsewhere. Represent unresolved named fabrics with a visible data-quality flag while retaining the supplied fabric text. Represent a missing target week as null and display it as Unscheduled. Represent missing numbers as null with a needs-number flag, and retain malformed source text alongside any normalized display number.