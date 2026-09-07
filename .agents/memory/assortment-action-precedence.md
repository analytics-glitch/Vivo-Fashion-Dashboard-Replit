---
name: Assortment proposed-action precedence
description: Business precedence and order evidence rules for resolving competing Assortment Plan lifecycle recommendations
---

When multiple Assortment Plan rules fire, resolve them in this order: REORDER, RETIRE, GRADUATE, WATCH, then no action. Reordering is the operational decision; any resulting graduation is a later records update.

Graduation order counts must use distinct, positive-quantity buying-order references matched by style number or canonical style name. Pipeline stock is not order-count evidence, and zero-quantity drafts do not count as orders.

**Why:** A graduation-first implementation hid styles that needed a reorder this week, and one style appeared to have a second order only because a zero-quantity draft row was counted.

**How to apply:** Evaluate only the lifecycle band appropriate to the style's age, collect any independent order-count graduation candidate, then resolve competing actions with the business precedence above.