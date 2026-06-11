---
name: Loyalty tier rules & points expiry
description: Three-tier loyalty model (Bronze/Silver/Gold), tiered earn multipliers, and lazy points expiry on inactivity.
---

# Loyalty tier rules

Three tiers only (VIP removed from loyalty), qualified by spend (KES):
Bronze 1–49,999 · Silver 50,000–99,999 · Gold 100,000+.

- `loyalty.tier_vip_kes` config key is intentionally KEPT but is NOT a loyalty tier — it
  only powers the CRM "vip" high-spender customer segment. Do not reintroduce a VIP loyalty tier.
- Earn rate is tiered via `loyalty.earn_multiplier_{bronze,silver,gold}` (1/2/3 pts per
  `earn_rate_kes`=KES 100). `_crm_earn_multiplier(tier,cfg)` clamps to >=1.
- The earn endpoint sets the multiplier from the member's tier going INTO the purchase
  (`_crm_tier_for_spend(m.spend_kes)`), not the post-purchase tier.

**Why spend basis:** `crm_loyalty_member.spend_kes` is the program-tracked accumulated spend and
never decays; the ledger stores only points (not KES) so a true rolling-12-month KES window
cannot be reconstructed from it. The "trailing 12 months" tier window is honored canonically by
`/api/crm/loyalty/recalc-tiers` via `_crm_rolling_spend` (already 12mo) for customers with
`all_sales` history; self-enrolled members (no sales rows) rely on `spend_kes`. Do not run
recalc on self-enrolled members — it would zero their tier.

## Lazy points expiry

`_member_expire_inactive_points(customer_id, cfg)` zeroes the whole balance when the last
`reason='earn'` ledger row is older than `loyalty.points_expiry_months` (12). NO cron — it's
evaluated lazily on `GET /api/loyalty/me` (read) AND at the start of the earn endpoint (so a
returning customer's stale points expire before the new credit; coming back resets the clock).
It writes an `expire` ledger row (points_change=-bal, balance_after=0, created_by='system:expiry')
inside a `FOR UPDATE` tx and early-outs via `cur.connection.rollback()` when nothing to expire.

**Config lives in the DB** (`crm_config`), which overrides `CRM_CONFIG_DEFAULTS`. Changing the
Python defaults alone does nothing for an existing install — you must UPDATE/INSERT the
`crm_config` rows too.
