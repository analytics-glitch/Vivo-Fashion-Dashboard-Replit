---
name: Fabric PO upload pricing writes
description: Odoo write conventions + gate ordering for the receiving PO upload's Yuan→KES pricing
---
# Fabric PO upload pricing writes

- Odoo XML-RPC line writes: `analytic_distribution` dict **keys must be strings** (`{"46": 100}`), and clearing taxes is the one2many command `taxes_id: [[5,0,0]]` (blank Taxes column even when Odoo auto-applies a default). Use lists, never tuples, in xmlrpc payloads.
- **Why:** integer keys / tuples serialize wrong or are rejected; a "cleared" tax list left unset lets Odoo re-apply the default VAT.
- **How to apply:** any new field pushed onto purchase.order.line during the receiving upload goes through the same single `_line_extras`-style dict applied to BOTH the update and create branches — the two paths drifted once before.
- **FX direction:** the "Yuan per USD" rate (~8) is Yuan PER USD, so KES = yuan / yuan_to_usd * usd_to_kes — Yuan→USD is a DIVISION. It shipped multiplied once (30¥ → 31,247 KES/kg instead of 488). Backend plan builder and the frontend live preview each compute it — change both together.
- Gate ordering on upload: validate pricing completeness (400, nothing written) → resolve the HQ analytic once (502 if absent, nothing written) → only then touch lines. Per-product *conversion* problems block the product; missing rates/prices block the WHOLE upload.
