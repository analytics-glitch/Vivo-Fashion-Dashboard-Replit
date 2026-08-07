---
name: Production Overview style cards
description: Buying-orders-at-a-glance style cards must partition styles one-bucket-per-style so New+Replenishment+Re-order always sums to Total Styles.
---

# Production hub Overview — style card counting contract

- The STYLES cards (Total / New / Replenishment / Re-order) read a **partition**: every
  style is assigned exactly ONE bucket, by precedence **New › Replenishment › Re-order**;
  styles whose window orders carry no lifecycle type land in an "Unclassified" caption
  line (clickable drill) under the card grid. Guarantee: the three cards + unclassified
  always sum to Total Styles.
- Style identity = **style_number first**, then style_name, then product_name, then
  order ref (`styleKeyOf`). Never key style counts on `style_name` alone.

**Why:** the cards originally showed per-lifecycle ORDER counts labeled "Styles" (only
coincidentally summed to total, hid a New style — user-reported). Data facts: a batch of
`production_orders` rows have blank style_name but valid style_number, and several
styles per quarter are ordered under more than one lifecycle type, so per-lifecycle
distinct-style counts double-count and don't partition.

**How to apply:** any new per-lifecycle style metric on production surfaces (cards,
targets, exports) must reuse the shared partition buckets, not fresh per-lifecycle
distinct counts; drills filter orders by the style's bucket membership, keeping drill
rows consistent with the card number.
