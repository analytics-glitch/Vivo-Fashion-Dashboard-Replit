---
name: Vivo Johari branding
description: Community-app loyalty program naming, tier canon, celebration rules, and terms-version lockstep after the Vivo Johari rebrand
---

# Vivo Johari (customer Community App program brand)

- Program name: **Vivo Johari** (johari = Swahili for jewel). Tagline used at login/intro moments: "We shine together" Wordmark = letterspaced caps `JohariWordmark` component (Poppins as Century Gothic stand-in) in the community `ui.jsx`.
- Tiers: **Tsavorite (0–499) → Ruby (500–999) → Tanzanite (1,000+)**, computed from **lifetime** points.
  **Why:** redeeming spends `points` but must never walk a member's tier or progress backwards.
  **How to apply:** any tier-progress UI (bar, "pts to next tier" label, ladder highlighting) must read `lifetime_points ?? points`, never the spendable balance alone. Bug of this exact shape was fixed in both TabRewards mirrors.
- Scope boundary — three separate tier systems, never cross-rename: Community app = Tsavorite/Ruby/Tanzanite; vivo-loyalty SZ CRM = x1–x4 multipliers; vivo-crm complaint ladder = Gold/VIP. Lowercase "gold accessories" product captions in mockData are jewelry copy, intentional.
- Terms lockstep: `COMMUNITY_TERMS_VERSION` (community_app.py) must equal `LEGAL_META.terms.version` (legalData.js); every historical version stays in `COMMUNITY_TERMS_PUBLISHED`.
  **Why:** the published list is the design — older consents remain valid; there is deliberately NO forced re-acceptance flow. The 0.9.3→0.9.4 bump was branding-only copy. Forcing re-acceptance is a product/legal decision to make with the user, not a default.
- Celebration rules: ONE celebration moment per event, dismissible (CelebrationCard in TabHome). Signup welcome = sessionStorage `johari_welcome` flag set by AuthFlow; tier-up = localStorage `johari_tier_seen` vs TIER_RANK — first observation stores silently (no retroactive celebration for existing members). "vigelegele" appears ONLY in tier-up / challenge-win copy; Spotlight is titled "This Week's Jewel".
- The Home-tab spotlight/sidebar is `hidden lg:block` — desktop-only by design; mobile testers won't see it at phone widths (known false-positive trap in e2e plans).
- BI dashboard mirrors the community UI (artifacts/vivo-bi community components + CommunityApp page, mock-data driven): copy/logic changes must land in BOTH mirrors and both dists rebuilt (community `BASE_PATH=/app/`, bi `BASE_PATH=/`).


## Gem rename (Aug 2026): Tsavorite / Ruby / Tanzanite
Tiers are East African gemstones — Tsavorite (0–499, vivid green), Ruby (500–999), Tanzanite (1,000+, violet-blue, most luminous). Same thresholds as the original Pearl/Ruby/Diamond.
**Why:** brand wants the ladder rooted in the region's own stones (Tsavo garnet, EA ruby heartlands, Kilimanjaro tanzanite "rarer than diamond").
**How to apply:**
- TIER_RANK in the customer Home tab MUST keep legacy aliases (Pearl→0, Diamond→2): `johari_tier_seen` localStorage can hold pre-rename names, and without aliases every legacy top-tier member gets a false tier-up vigelegele. Never remove them.
- Badges are jewellery-like gradients keyed by EXACT tier name in both ui.jsx mirrors (customer + BI); unknown tier falls back to Tsavorite. Renaming a tier means updating gradient keys, Avatar border keys, and the fallback in BOTH mirrors.
- "Our Gems" explainer lives in the Rewards tab (both mirrors) + an `our-gems` FAQ item; tells the Tsavo/Kilimanjaro story.
- Tier names live ONLY in code (TIER_LADDER + event-seed gate dicts); members' tiers are computed from lifetime points and events store only locks/RSVPs — a rename needs NO data migration.
- Tagline is exactly "We shine together" (English only, user-mandated); Swahili stays in celebration copy (Karibu, vigelegele) and the name story only.

## Earn rate & tier progress (2026-08-14)
- Earn rate canon: **1 point per 100 KES** (`KES_PER_POINT = 100` in community_app.py). Product spec; was 50 at launch.
- **Why:** spec alignment requested after the compact rewards-card redesign; tiers are computed live from lifetime points so no migration, but members near 500/1k thresholds drop a tier when the rate changes.
- Rate copy exists in BOTH word orders — "1 pt per 100 KES" and "every KES 100" (FAQ). Grep both forms when changing it.
- Tier progress must read `lifetime_points` (fallback points), never spendable `points` — Rewards hero AND Home PersonalCard; a redeemed member's progress must not walk backwards.
- Rewards tab hero is a COMPACT light card (~220px, testid rewards-balance-card), not a dark hero panel; Our Gems card sits after How to Earn in the customer app.
