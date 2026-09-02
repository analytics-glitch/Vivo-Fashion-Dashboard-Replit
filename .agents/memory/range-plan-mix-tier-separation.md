---
name: Range Plan mix and tier separation
description: Defines the shared planning grain and the boundary between tier health and commercial plan totals.
---

Quarterly and monthly Range Plans must use the same category/subcategory Mix Matrix. New/reorder/replenishment splits are attributes of those rows, not separate planning rows. Tier-filtered views may project the splits but must not duplicate the underlying commercial plan.

**Why:** Tier planning rows created a second, incompatible plan grain and could multiply style health counts into commercial units and revenue.

**How to apply:** Derive units and gross revenue from category rows only. Tier 4 new units use an editable per-row new-style AOS (default 300); reorder/replenishment use the subcategory AOS. Newness is a unit share.

Q3 2026 is an actual-plus-plan quarter: July–August are locked tracker actuals and September is read live from the September monthly plan. Do not copy September into Q3 or smooth actual backlog into capacity.

**Why:** The quarter was rebuilt near completion, so it must reconcile to placed orders while still updating whenever the remaining September plan changes.

**How to apply:** Keep Q3 row actuals immutable, keep capacity and COGS assumptions editable, and label actuals, plan, tracker-boundary orders, and backlog separately.

Monthly Range Plans express business need and must never cap new-style demand to the current development pipeline. Pipeline supply is a live comparison, with shortfalls and surpluses visible per sub-category.

**Why:** Planning down to available pipeline hides the styles the business still needs and prevents teams from seeing where development effort can be moved or accelerated.

**How to apply:** Count matching NEW pipeline styles in the month’s target-order-week window, calculate planned minus available by sub-category, and sum positive gaps separately from surpluses.

Monthly order tracking has two mutually exclusive states: Ordered is live Odoo buying-order data; Provisional Committed is a weekly Style Tracker row with no matching, non-cancelled Odoo order. Count distinct styles but sum every order/commitment quantity. Never hide unmatched rows.

**Why:** A weekly plan precedes Odoo creation by several days, while one style can have multiple Odoo orders. Treating order rows as styles or dropping unmatched taxonomy rows understates progress and units.

**How to apply:** Move a commitment to Ordered automatically as soon as its Odoo order appears. Project month-end as ordered units + provisional units + remaining new styles at 300 units + remaining repeat/replenishment styles at 400. Flag projected units above 110% of plan; only flag under-order pacing below elapsed-month expectation after a 15-point grace band.