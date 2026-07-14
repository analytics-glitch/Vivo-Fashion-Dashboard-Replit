---
name: Fabric landed-cost upload
description: Draft stock.landed.cost creation from the Fabric BI Receiving tab — Odoo access blocker, gate ordering, and integration facts.
---

# Fabric landed-cost upload (draft stock.landed.cost)

- The Fabric BI Receiving tab can create **draft-only** `stock.landed.cost` records in Odoo attached to a PO's receipt picking(s). It never validates them — accounting posts inside Odoo.
- **Odoo access blocker:** the XML-RPC integration user needs the *Inventory / Administrator* group to read/write `stock.landed.cost`. Until granted, reads fault ("not allowed to access"); the backend maps that fault to an actionable 403 (`_LC_PERM_MSG`) and the PO endpoint still returns pickings with `lc_access:false` so the form opens and shows the blocker instead of failing on submit.
- **Why draft-only + gate ordering:** validate the whole payload locally (400), then re-verify PO/pickings/products/journal live in Odoo, then a duplicate check (LCs already referencing the pickings → 409 unless `force`), and only then create. Nothing is written until every gate passes.
- Integration facts: LC requires `date`, `target_model='picking'`, `account_journal_id`; lines are `cost_lines` one2many with `split_method='by_current_cost_price'` and `price_unit` in final KES (FX lines converted client+server side as amount×rate). Cost types = products with `landed_cost_ok=True`. Default journal = "Miscellaneous Operations" (general type). Receipts exist only once a PO is confirmed — draft POs are blocked with a clear 400.
- **How to apply:** any new LC-touching call must go through `_lc_kw` (full fault text, permission mapping); frontend must use raw fetch + parse `detail` (the page's `apiFetch` swallows 403 as generic 'auth').
