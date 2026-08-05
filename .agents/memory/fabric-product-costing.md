---
name: Fabric Product Costing tab
description: Costing sheets on /fabric — email-allowlist gate, DPS labour cost source, MO→style matching rule
---
- Access is a strict email allowlist `_FABRIC_COSTING_EMAILS` in fabric_router.py (admin role does NOT qualify), now DERIVED as the union of per-step sign-off sets `_COSTING_STEP_EMAILS` (1=prepare, 2=check, 3=approve); enforced in api_pg clerk_auth_gate middleware for all `/api/fabric/costing/*`; UI tab hiding is UX only and fails closed via GET /costing/access (which also returns can_sign_steps + step_signers for button gating).
- Per-step sign rights + separation of duties are enforced in the signoff POST: signer's email must be in the step's set, and the signer of the immediately preceding step (resolved uid→email via app_users, uid fallback) cannot sign the next one (prepare→check, check→approve). 403 with a who-may-sign message. Unsign remains open to any tab user (unchanged semantics).
- Labour/CMT cost lives on the Odoo DPS model `mrp.production.day` (`total_labour_cost`, `total_production_cost`, `cost_per_unit`), reached via `mrp.production.dps_id`; stored on mo_fabric_consumption (dps_cost_per_unit etc.). Labour per garment = produced-qty-weighted avg.
- **MO→style matching:** never match mo_fabric_consumption.style_name to the product master (Odoo MO names embed fabric+colour); match `finished_sku = all_products_clean.sku` — 99.9% join when master intact.
- One sheet per style (unique on lower(style_name)); POST returns 409; line totals recomputed server-side; edits append fabric_costing_history rows.
- Cost basis for fabric AND accessory suggestions = DPS/MO-recorded cost (`mo_fabric_consumption.unit_cost_mo`; per kg → per metre via kg_per_mtr_eff), latest-PO price only as fallback for fabric (PO pricing for accessories explicitly rejected). Odoo stock.move.price_unit is 0 and valuation layers are gated to inventory admins, so the extract records the component's average/standard cost (product.standard_price) — the cost Odoo values MO consumption at.
- mo_fabric_consumption now also holds Accessories & Trims components (Odoo categ 19) flagged `is_main_fabric=FALSE`; EVERY fabric-only reader (metres/garment KPIs, category breakdowns, movements) must filter `AND c.is_main_fabric`. fabric_router lazily ensures the columns via `_ensure_mo_cons_cols()` in q().
- New-sheet form has a style-scoped DPS # picker (GET /costing/dps lists Done DPS by dps_ref); `suggest?dps_ref=` scopes ALL suggestions (fabric metres, accessories, labour) to that one DPS (validated to belong to the style, else 404); blank = 365-day Done-DPS average. Chosen dps_ref persists on fabric_costing_sheets.dps_ref and shows read-only on reopen.
- Accessory suggestion lines: kind='trim', qty/garment = Σconsumed ÷ Σproduced per component, unit cost = consumed-weighted avg unit_cost_mo, AUTO badge; capped at 25 components.

## Costing sheets are SNAPSHOTS (explicit user decision, Jul 2026)
Saved costing sheets capture fabric cost/metre at DPS/sheet creation time and must NEVER
re-price on read as raw_fabric_products.standard_price drifts. An earlier read-time
re-pricing behaviour was reversed on the boss's instruction. fabric_costing_lines.component_id
(fabric-product link) is kept for *reporting* drift only — it must not feed pricing math.
_strip_reprice_notes cleans the legacy "· current cost/metre" source notes.

## Fabric-first lines + auto Cost/Mtr (Aug 2026)
- raw_fabric_products has NO `sku` column — the internal code is `default_code`. (A `p.sku` select 500'd the pre-production costing search for weeks; the UI catch hid it — verify search endpoints with curl, not just "dropdown appears".)
- Pre-prod (no dps_ref) search covers the whole raw-material master by name/default_code/barcode: Fabric-category rows carry cost_per_metre = standard_price × kg_per_mtr_eff; Trim rows carry standard_price as unit_cost. BOTH branches return `cost_missing_reason` (shared `_fabric_cost_missing_reason`) so a blank cost is explained, never a silent 0.
- Fabric lines order FIRST on every surface: `_sheet_payload` ORDER BY `(kind <> 'fabric'), position` + client stable sort that also feeds save positions and the PDF/xlsx. Ordering only — amounts untouched. The PUT change-summary's old-lines query must use the SAME order or legacy sheets log spurious "edited" history.
- New Pre-production sheets seed one empty fabric row client-side (unsaved sheets only; pristine row pruned when toggled back to Main Production, so no duplicates).
- SNAPSHOT carve-out (user-approved): the ONLY auto re-price is the editor-side self-heal — unlocked sheet + fabric line with component_id + cost never captured (≤0) + advisory `current_cost_per_metre` now derivable → fill AUTO ("auto-filled when the Odoo data became available"), persisted on next save. Lines already carrying a cost and locked sheets are NEVER touched; read endpoints stay pure (advisory fields only).

## Sign-off & edit lock (Jul 2026)
- 3 ORDERED sign-off steps per sheet in fabric_costing_signoffs (row exists ONLY when signed;
  titles customizable at signing, defaults Prepared/Checked/Approved by). Step 3 signed =
  approved = LOCKED: every sheet/line mutation endpoint must call _costing_reject_if_locked
  (409) — new mutation endpoints must add this too. Un-signing step N cascades to later steps
  and un-approving is history-logged; all sign actions write fabric_costing_history.
- Per-sheet branded PDF: GET /costing/sheets/{id}/export.pdf builds from the SAME
  _sheet_payload as the screen (reportlab A4, grouped by kind, sign-off blocks, history).
