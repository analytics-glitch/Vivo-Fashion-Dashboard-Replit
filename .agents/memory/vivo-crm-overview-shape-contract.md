---
name: vivo-crm Overview API shape contract
description: Why the vivo-crm Overview page went blank and the contract /api/insights/overview must honor
---

The standalone `artifacts/vivo-crm` Overview page renders KPI cards as `ov.kpis.<field>` (no optional chaining on the leaf), so if `/api/insights/overview` returns a flat object without a `kpis` key, `ov` is truthy but `ov.kpis` is undefined → TypeError at render → the whole page blanks (the page's fetch `.catch` only swallows the network error, not the render crash).

**Contract** `/api/insights/overview` must return:
`{ kpis: {total_customers, new_customers_30d, new_customers_delta_pct, active_customers_30d, active_customers_delta_pct, vip_customers, at_risk_customers, avg_basket_kes, avg_basket_delta_pct, messages_sent_30d, messages_delta_pct, social_sentiment_net, social_feedback_30d}, tier_distribution: {Bronze,Silver,Gold,VIP}, callouts: [{tone:"positive"|"negative", text}] }`

**Why:** A nested-shape consumer with non-optional leaf access turns any backend shape drift into a blank screen, not a graceful empty state.

**How to apply:** When an endpoint feeds the vivo-crm pages, match the exact nested shape the page reads (grep `ov?.`/`ov.` in the page first). Wrap each backend sub-query in its own try/except returning safe zero defaults so one failing metric never blanks the whole response. Tier buckets follow the loyalty thresholds (Bronze <50k, Silver 50–149,999, Gold 150–299,999, VIP ≥300k).
