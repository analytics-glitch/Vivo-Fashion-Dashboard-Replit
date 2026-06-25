---
name: Fabric effective Kg/Mtr fallback
description: How the Fabric page derives Kg/Mtr when Odoo lacks it, and which column conversions must use.
---

Fabric conversions (kg↔metre, cost/metre, m/kg, available-metres, weeks-of-cover, reservation metres→kg) must read the **generated** column `raw_fabric_products.kg_per_mtr_eff`, NOT the raw `kg_per_mtr`.

Rule (encoded as a STORED generated column in `extract_fabric.py`, so it auto-populates on dev AND prod every extract):
- stored `kg_per_mtr` > 0 → use it (authoritative, never overwritten); `kg_per_mtr_src='stored'`
- else Width(m) > 0 AND GSM > 0 → derive `width_m*gsm/1000.0`; src='derived'
- else → `kg_per_mtr_eff` is NULL; src='incomplete' (shown but excluded from metre math)

**Why:** ~70 fabrics had Width+GSM but no stored Kg/Mtr, so they were dropped from all metre calculations and wrongly flagged in the Data Quality "missing kg/m" check. The formula Kg/Mtr = Width(m)×GSM÷1000 is confirmed by the business.

**How to apply:**
- The "incomplete" check is `p.kg_per_mtr_eff IS NULL` (NOT `COALESCE(kg_per_mtr,0)<=0`). The Data Quality endpoint `missing-kg-per-metre` filters on this so only genuinely incomplete rows show.
- Endpoints feeding product/detail tables + Data Quality also SELECT `kg_per_mtr_src`; the dashboard renders a "derived"/"incomplete attributes" badge from it.
- Any GROUP BY that included `p.kg_per_mtr` must switch to `p.kg_per_mtr_eff` (+ `kg_per_mtr_src` where selected) to match the CASE expressions.
- `fabric_api.py` is **dead code** (only `fabric_router.py` is `include_router`-ed in `api_pg.py`) — do not bother updating it.
- Prod is a separate DB; the generated columns + derived values appear there once the fabric extract runs inside prod's incremental sync loop. Verify with a read-only prod query on `kg_per_mtr_src` distribution.
