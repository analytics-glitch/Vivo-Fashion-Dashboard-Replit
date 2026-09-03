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

Buying orders are atomic dated records. Weekly, monthly, and quarterly actuals must be grouped independently from non-cancelled Odoo orders by `date_ordered`; months must never be inferred from whole ISO weeks.

**Why:** ISO weeks cross month boundaries, and orders can slip into a later week. Rolling a week into one month misattributes real spend and requires manual reconciliation.

**How to apply:** A week shows orders whose dates fall inside its Monday–Sunday range; a month shows orders dated in that calendar month; a quarter equals its three month totals. Count distinct styles but sum every order quantity. Include unplanned orders in headline actuals and flag them rather than rejecting or hiding them. Show weekly targets with no dated match separately as planned-not-raised intent; they never contribute to actual progress.

Assortment Plan is the canonical range/reorder surface. Its Active/Retired universe must use the same Odoo status precedence, tier mapping, style-name alias fold, and style-number identity as BI Range Management; quarter exclusions never change lifecycle counts.

**Why:** The retired manual override table, “any active SKU” catalogue rule, and quarter exclusions produced three incompatible active-style counts.

**How to apply:** Default Assortment Plan to Active. Keep retired styles opt-in. Style Development count means active rows in its dedicated tracker (`exit_status='active'`), not the separate historical `pd_styles` catalogue.

Weekly Order Plan lines must be created only by selecting a confirmed Style Development record or a Style Catalogue record. Source-owned identity, taxonomy, brand, fabric, colourway options, and target week are immutable snapshots; only quantity, selected colourways, order type, and order stage belong to the week.

**Why:** Re-keying style names, numbers, and taxonomy caused missing and conflicting identifiers and made weekly orders impossible to reconcile reliably to the monthly plan.

**How to apply:** Never add free-text style creation to the weekly plan. Missing styles must be created and numbered in Style Development first. Confirming locks only the weekly target; it does not create, date, or roll up an actual order. Generate target references under a locked week row as `W<week><three-digit sequence>`.