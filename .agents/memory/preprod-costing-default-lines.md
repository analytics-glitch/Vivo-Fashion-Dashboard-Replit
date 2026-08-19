---
name: Pre-production costing default lines
description: Contract for the four auto Pre-production rows in the /fabric Product Costing editor — adoption matching, percentage basis, reopen re-sync scope.
---

# Pre-production default costing lines (editor contract)

- Pre-production always presents four rows in order: main Fabric, Accessories (13% of fabric cost), CMT, Defect Allowance (10%). Seeding is idempotent on any unlocked sheet; toggling back to Main Production prunes the derived rows + a pristine seeded fabric row.
- **Derived-row identity**: `is_auto` + source starting with `pre-production auto` OR (legacy adoption) the machine-generated label regexes (`Accessories (N% of fabric cost)`, `CMT (…×N.NN)` — any multiplier, incl. legacy ×1.40, `Defect Allowance (N% of fabric cost)`). Recalc ADOPTS matches (folding duplicates) — never duplicates them; user-added extra trim/overhead lines never match and stay untouched.
- **Production Multiplier**: CMT adj minutes = raw minutes × per-sheet `fabric_costing_sheets.production_multiplier`; NULL/blank/non-positive → 1.40 (legacy sheets stay identical). Label/helper/PDF basis note quote the sheet's OWN multiplier. Last TYPED value remembered in localStorage to prefill NEW sheets only. CMT time pickers are HH:MM (no seconds); legacy HH:MM:SS values normalized on input fill, minutes maths unchanged.
- **Percentage basis = Σ of ALL fabric lines' line totals** (qty × unit_cost), not the first line's unit cost. Recalc fires on: fabric pick, cost auto-fill/self-heal, header input edits, fabric row add/edit/delete, kind flips.
- Only the MAIN (first) fabric row's qty mirrors Mtrs per Garment (read-only); additional fabric rows keep hand-typed qty and keep AUTO after a qty edit (qty edits on preprod fabric rows must NOT strip is_auto; cost edits still flip to manual but re-trigger calc).
- **Reopen re-sync is EDITOR-SIDE ONLY**: opening an unlocked preprod sheet re-derives from the sheet's own saved header inputs and persists only on save. Server read/export endpoints must stay snapshot-faithful, and locked (step-3-signed) sheets are never touched — the locked check gates seeding, calc, and stage/header inputs.

**Why:** the original bug was recalc firing only on header typing + qty edits stripping AUTO, so 13%/10% lines showed KES 0.00; the label-regex adoption exists because that old flip bug persisted manual-flipped default rows in saved sheets.
**How to apply:** any change to costing editor line handling, save payloads, or new derived line types must preserve the source-prefix tag, the all-fabric-lines basis, and the unlocked-only / editor-only re-sync scope.

- **Stage-specific headers:** PostgreSQL column defaults are global; keep shared schema defaults compatible with Main Production and apply Pre-production-only header defaults in stage-aware server/UI paths.

**Why:** a shared column default cannot distinguish `pre_production` from `main_production`, so changing it would silently alter direct Main Production inserts.

**How to apply:** when adding or migrating stage-specific costing fields, use explicit stage normalization and an audited Pre-production backfill; do not encode the new value as a global column default.
