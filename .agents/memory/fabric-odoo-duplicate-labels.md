---
name: Fabric Odoo duplicate display labels
description: Odoo fields_get labels are not unique — resolver keeps ordered type-ranked candidates per concept; mapping-signature change forces a full reconcile.
---

# Fabric Odoo duplicate display labels

**Rule:** Odoo `fields_get` display labels are NOT unique and never will be — the live catalogue legitimately carries an attribute-backed many2one AND a plain char field under the identical label (e.g. "GSM"). The Fabric metadata resolver must map each business concept to an ORDERED candidate list ranked by field type (relational/selection → numeric → char/text), then take the first POPULATED value per product. Only a true tie (two same-type fields at the head of a required concept) is genuinely ambiguous — that still fails safely BEFORE any TRUNCATE so the last known-good master survives.

**Reconcile trigger:** the chosen mapping is fingerprinted (canonical JSON of concept → [[field, type]…]) and stored in `fabric_sync_state` in the SAME transaction as the product rows. Any signature change — or no stored signature at all — promotes the next pull from incremental to a FULL product reconciliation. That is what repairs rows whose Odoo `write_date` predates the fix, and it makes prod rollout automatic: a freshly-published prod DB has no signature row, so the first pull is a full one.

**Normalization:** Odoo returns `False` for empty fields — it must become `None`/NULL, never `float(False)=0.0` (a zero GSM would poison the kg/mtr derivation). Display values may carry magnitude-neutral unit suffixes ("157 gsm", "1.70 m") and comma decimals; anything non-positive or non-finite is rejected, not silently derived.

**Why:** a duplicate "GSM" label (attribute + text twin) hard-stopped every Fabric product sync for ~40 min in Aug 2026; treating valid duplicates as fatal ambiguity means any Odoo admin adding a similarly-labelled helper field can silence the whole feed.

**How to apply:** when adding a new Fabric business attribute, add label aliases to the spec — never assume a unique label or a fixed `x_vivo_attr_NN` id. If source selection logic changes, rely on the signature promotion (don't hand-run backfills). Data Quality's missing-kg-per-metre view only lists incomplete products that have real stock or usage — zero-quantity incomplete products are by design absent there but still carry `kg_per_mtr_src='incomplete'` everywhere else.
