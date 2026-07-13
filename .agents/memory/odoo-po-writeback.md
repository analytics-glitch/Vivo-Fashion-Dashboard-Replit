---
name: Odoo PO write-back (receiving upload)
description: Conventions for the first and any future Odoo WRITE path (fabric receiving → purchase.order.line quantities).
---

# Odoo PO write-back pattern

Rules established for the receiving → draft-PO upload (the project's first Odoo write-back). Any future Odoo write should follow the same shape.

- **Idempotent by SET, not increment**: each `purchase.order.line.product_qty` is SET to the summed received total, so re-uploading after more sheets arrive is always safe. Never `+=` a delta.
- **Draft-only gate re-checked server-side at write time** (`_recv_read_po(require_draft=True)`) — the UI disabling the button is UX only; a PO that moved past draft 400s with the state surfaced verbatim.
- **Quantities pushed in the line's OWN UoM** (kg or metres via `kg_per_mtr_eff`); an unsupported unit or a missing conversion BLOCKS that product from upload rather than guessing — never silently convert.
- **Stop on first Odoo error, report honestly**: lines written before the failure stay written, the rest are marked `skipped`, and the Graph/XML-RPC fault's last line is surfaced verbatim. Every attempt (success or failure) is audited in `fabric_po_uploads` with the full per-line results JSON.
- **PO snapshot on the sheet** (`po_id`/`po_name`/`po_date` columns) so lists/prints don't need an Odoo round-trip; only the picker, batch modal and upload hit Odoo live.
- **Testing**: exercise create-link → batch plan → detail → delete via a temp `user_sessions` row; do NOT run the actual upload against the real Odoo draft PO in dev — it writes real business data with no undo in scope.

**Why:** Odoo is the company's live ERP shared with dev; write paths must be re-runnable, honest about partial failure, and never fabricate unit conversions.
