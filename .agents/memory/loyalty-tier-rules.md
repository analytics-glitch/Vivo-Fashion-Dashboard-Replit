---
name: Loyalty tier rules & points expiry
description: Four-tier loyalty model (Bronze/Silver/Gold/VIP), tiered earn multipliers, and lazy points expiry on inactivity.
---

# Loyalty tier rules

Four tiers (PRD v3 §5.3 launch values), qualified by spend (KES):
Bronze 1–49,999 · Silver 50,000–149,999 · Gold 150,000–299,999 · VIP 300,000+.

**Why VIP is now a real loyalty tier:** earlier the model was 3 tiers and `loyalty.tier_vip_kes`
only powered the CRM "vip" high-spender segment. PRD v3 §5.3 makes VIP a real 4th loyalty tier and
raises Gold from 100k→150k. Both `_crm_tier_for_spend` (api_pg) and `_tier_case`/`_tier_for_spend`/
`_tier_label` (crm_clienteling) now return VIP, and every tier enumeration / next-tier ladder /
retention-floor map / member-facing config includes it.

- Earn rate is tiered via `loyalty.earn_multiplier_{bronze,silver,gold,vip}` (1/2/3/4 pts per
  `earn_rate_kes`=KES 100). `_crm_earn_multiplier(tier,cfg)` clamps to >=1.
  **Open business decision (flag for finance):** PRD §6.2 says *flat* 1pt/KES100 at launch; the tiered
  x1–x4 multipliers are technically the PRD's Phase-2 "dynamic multipliers" shipped early. The infra
  is kept; whether launch should be flat vs tiered is a finance sign-off, not a code question.
- The earn endpoint sets the multiplier from the member's tier going INTO the purchase
  (`_crm_tier_for_spend(m.spend_kes)`), not the post-purchase tier.
- `loyalty.retain_vip_kes` (default 240000) and `loyalty.voucher_vip_kes` (default 20000) are
  code-fallback only (not in `CRM_CONFIG_DEFAULTS`) — they work without a DB row but aren't seeded.

**Distinct from the CRM "vip" segment:** `/api/crm/segments` vip_count + insights/overview vip_count
are *lifetime* high-spender counts (the segment uses `tier_vip_kes`=300k; insights/overview still
hardcodes 100k lifetime). Those are NOT the loyalty tier (trailing-12mo) and were left as-is.

**Why spend basis:** `crm_loyalty_member.spend_kes` is the program-tracked accumulated spend and
never decays; the ledger stores only points (not KES) so a true rolling-12-month KES window
cannot be reconstructed from it. The "trailing 12 months" tier window is honored canonically by
`/api/crm/loyalty/recalc-tiers` via `_crm_rolling_spend` (already 12mo) for customers with
`all_sales` history; self-enrolled members (no sales rows) rely on `spend_kes`. Do not run
recalc on self-enrolled members — it would zero their tier. To re-tier existing enrolments after a
threshold change, POST `/api/loyalty/recompute` (admin) — it re-derives tier from `spend_kes`.

## Lazy points expiry

`_member_expire_inactive_points(customer_id, cfg)` zeroes the whole balance when the last
`reason='earn'` ledger row is older than `loyalty.points_expiry_months` (12). NO cron — it's
evaluated lazily on `GET /api/loyalty/me` (read) AND at the start of the earn endpoint (so a
returning customer's stale points expire before the new credit; coming back resets the clock).
It writes an `expire` ledger row (points_change=-bal, balance_after=0, created_by='system:expiry')
inside a `FOR UPDATE` tx and early-outs via `cur.connection.rollback()` when nothing to expire.

**Config lives in the DB** (`crm_config`), which overrides `CRM_CONFIG_DEFAULTS` via
`ON CONFLICT (key) DO NOTHING` seeding. Changing the Python defaults alone does NOTHING for an
existing install — you must UPDATE existing rows and INSERT new keys too (e.g. raising gold to
150k required `UPDATE crm_config … WHERE key='loyalty.tier_gold_kes'` + inserting the vip
multiplier row, because the old 100k row already existed).
