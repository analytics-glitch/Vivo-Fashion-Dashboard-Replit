---
name: Style Development stage history
description: Durable rules for stage derivation, blockers, approvals, and audit history in the Product Workspace tracker.
---

The current development stage must be derived from the furthest recorded event, never typed directly. Imported tracker status may create one system baseline event so existing work starts in the right stage. A rejection starts another round but must not erase progress already reached.

**Why:** The tracker is intended to tell the full story of a style. Editable stage fields or destructive updates would lose rejections, reporting lag, and historical week slippage.

**How to apply:** Keep events and notes append-only with actor, occurred time, and recorded time. Backdating changes `occurred_at`, not the audit timestamp. Blockers overlay the derived stage. Target-order-week edits append old/new history. Odoo alone owns Ordered and later states.