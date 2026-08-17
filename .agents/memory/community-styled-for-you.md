---
name: Community Styled for You
description: Opt-in personalised recs — consent rules, cadence rotation, surfaces
---
- Enrolment (opted_in) AND purchase-history use (use_activity) are TWO separate consents, both default FALSE; opted_in_at stamps first consent. Never streamline one into the other.
- Rotation is deterministic per cadence: md5(seed|sku) with seed = ISO week / week//2 / year-month per frequency; labels/subs come from the server (cadence_label, section sub) — frontend must not hardcode "weekly".
- Recs endpoint returns {opted_in:false} pre-consent; pool is one ~300-row query mirroring the products endpoint's card CTEs; scoring is Python-side.
- Surfaces: Home rail/invite (Maybe Later = sessionStorage), Shop sfyMode pill (tap-set vivo_shop_sfy hand-off consumed once), ?page=styleprefs editor — page id must stay in PAGES allowlist AND the guest fence list in CommunityShell.
- Notification prefs (push/email) are stored but NO sender exists yet.
