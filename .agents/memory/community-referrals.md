---
name: Community referrals
description: Durable rules for safe Vivo Community referral links and point awards.
---

Referral emails must always compose their URL from the configured canonical
public Community origin plus the fixed `/app/` mount. Do not derive the host
or path from request headers or client input.

**Why:** A forwarded Host/Origin header or a root-relative path can turn an
official invite into a misleading or non-routable link.

**How to apply:** Keep the public-origin setting valid whenever Community is
deployed; fail invitation sending explicitly if it is absent or malformed.

Referrers receive their points only after the referred member has a first
synced purchase, through a durable, idempotent reconciliation process rather
than a profile read.

**Why:** A member may not open the app after purchase, and retries or sync
backfills must never award the referrer twice.

**How to apply:** Preserve the referral reward ledger and unique points-event
guard whenever changing customer ingestion, reconciliation, or referral
rewards.