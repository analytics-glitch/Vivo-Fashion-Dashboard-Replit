---
name: Style Development tracker imports
description: Durable data-boundary and fidelity rules for Product Development Tracker batch imports.
---

Product Development Tracker batch imports belong in a dedicated tracker model rather than replacing the broader product catalogue or generic PLM records. Imports may replace the tracker view without deleting unrelated style data.

**Why:** The tracker carries exact operational statuses, target order weeks, source taxonomy labels, and incomplete or malformed style numbers that do not fit the catalogue's stricter lifecycle model.

**How to apply:** Preserve every supplied source value exactly, including status casing, names, taxonomy text, week spacing, and blank fabric values; map NEW to Tier 4 and RR to Tier 3. A declared replacement batch must atomically clear tracker rows before inserting its versioned baseline; later batches append through separate versioned, idempotent imports. Treat spaced and unspaced WK labels as sortable equivalents without rewriting them. Represent unresolved named fabrics with a visible data-quality flag while retaining the supplied fabric text. Represent a missing target week as null and display it as Unscheduled. Represent missing numbers as null with a needs-number flag, and retain malformed source text alongside any normalized display number.

The dedicated tracker is also the canonical universe for Product Workspace development counts and the PLM list. Keep `pd_styles` only as an enrichment/detail mirror, selecting at most one matching mirror row per tracker style.

**Why:** The legacy mirror can contain duplicate and historical rows, so counting it made the home, tracker, and PLM catalogue disagree even when the tracker import itself was correct.

**How to apply:** Drive counts and list membership from tracker rows; join to the mirror by style number or exact normalized style name only for fields and interactions the tracker does not own. Never delete unrelated catalogue history just to reconcile a tracker count.