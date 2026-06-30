---
name: Fabric effective Kg/Mtr fallback
description: How the Fabric page derives Kg/Mtr when Odoo lacks it, and which column conversions must use.
---

Fabric conversions (kg↔metre, cost/metre, m/kg, available-metres, weeks-of-cover, reservation metres→kg) must read the **generated** column `raw_fabric_products.kg_per_mtr_eff`, NOT the raw `kg_per_mtr`.

Rule (encoded as a STORED generated column in `extract_fabric.py`, so it auto-populates on dev AND prod every extract). The conversion is **purely the standard formula** — the stored Odoo `kg_per_mtr` value is IGNORED:
- Width(m) > 0 AND GSM > 0 → `kg_per_mtr_eff = width_m*gsm/1000.0`; `kg_per_mtr_src='derived'`
- else → `kg_per_mtr_eff` is NULL; src='incomplete' (shown but excluded from metre math)
- `src` resolves to ONLY 'derived' or 'incomplete' — there is no longer a 'stored' value.

**Why:** the business wants one transparent calculation for every metre/cost/cover figure. The formula Kg/Mtr = Width(m)×GSM÷1000 is confirmed. Previously the stored Odoo Kg/Mtr was preferred (src='stored') and rescued fabrics lacking Width/GSM — that is no longer the case (a fabric is "incomplete" purely when missing Width and/or GSM).

**How to apply:**
- The "incomplete" check is `p.kg_per_mtr_eff IS NULL` (= missing Width and/or GSM). The Data Quality / missing-conversion logic must list Width/GSM as the only fixable fields (no "stored kg/m" alternative).
- Endpoints feeding product/detail tables + Data Quality also SELECT `kg_per_mtr_src`; the dashboard renders a "derived"/"incomplete attributes" badge from it (no green "stored" pill).
- Any GROUP BY that included `p.kg_per_mtr` must use `p.kg_per_mtr_eff` (+ `kg_per_mtr_src` where selected) to match the CASE expressions.
- `kg_per_mtr_eff`/`kg_per_mtr_src` are STORED GENERATED, so `ADD COLUMN IF NOT EXISTS` will NOT change an existing column's expression. Changing the formula on a DB that already has the columns requires a **drop + re-add** migration (see `migrations/004_fabric_kg_per_mtr_standard_formula.sql`). The extract's `ADD IF NOT EXISTS` only gives a FRESH DB the right expression.
- `fabric_api.py` is **dead code** (only `fabric_router.py` is `include_router`-ed in `api_pg.py`) — do not bother updating it.
- Prod is a separate DB; the new expression reaches prod when `migrate.py` runs the drop+re-add migration on publish (and a fresh prod DB gets it from the extract). Verify with a read-only prod query on `kg_per_mtr_src` distribution — no rows should be `stored`.
- Migration version numbers can collide: `migrate.py` keys off the numeric prefix, and a prefix already in `schema_migrations` (even if its file is gone) is silently skipped. Pick the next free number, not just the next on disk.
