---
name: Preprod Accessories % auto-pick
description: Contract for the server-picked Accessories % on pre-production costing sheets (previous-month Done-DPS pooled ratio, picked once, read-only, provenance everywhere).
---

# Pre-production Accessories % auto-pick

**Rule:** New pre-production costing sheets get their "Accessories % of fabric
cost" from the server, not the user: the pooled ratio
Σ(consumed_qty×unit_cost_mo) trims ÷ fabric over the previous **calendar**
month's qualifying Done DPS in `mo_fabric_consumption` (qualifying = ≥1 fabric
row AND ≥1 trims row AND fabric sum > 0, attributed to month of latest
done_date). Walk back to the most recent earlier qualifying month (flagged
`fallback`), else 13% flagged `is_default`. The current in-progress month is
never used.

**Picked ONCE, never re-picked.** The precise float + a JSONB provenance meta
(source_month, month_label, dps_count, fallback, is_default, requested_month*)
are persisted at create; update reads the stored pair and both create/update
IGNORE any client-supplied accessories % for preprod sheets (read-only is
server-enforced). Legacy sheets have meta NULL ⇒ every surface renders the
bare pre-existing wording byte-identically (labels, PDF basis note) — locked/
approved sheets must not change.

**Provenance string is shared 3 ways** — Python helpers, the extracted-JS
mirror in the fabric dashboard, and the PDF sentence all build from the same
suffix grammar with em-dash U+2014:
`" — {Mon YYYY} Done-DPS avg, {N} DPS"` (+` (fallback)`), or
`" — default (no Done-DPS history)"`. Display % = half-up 2dp then `:g`
("8.98", "13", "12.3"); the precise value stays in the maths.

**Why:** trims really cost ~9%, not the old hand-typed 13%; freezing the pick
at creation keeps sheets auditable, and byte-identical legacy output protects
approved/exported PDFs.

**How to apply:** any new label/adoption regex must tolerate decimal
percentages AND the optional `( — .*)?` suffix (Python + JS in lockstep); the
derived-row re-stamp only ever edits an existing machine Accessories line
(source tag prefix `pre-production auto`), never injects one. Month history
SQL lives in one helper so tests can patch it; tests pin "today" or they
drift when the wall-clock month rolls over.
