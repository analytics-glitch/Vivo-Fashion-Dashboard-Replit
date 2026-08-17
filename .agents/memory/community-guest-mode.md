---
name: Community guest mode
description: How guest browsing works in vivo-community and what reviewers require of the fence.
---

Guest mode is a client-side sessionStorage flag (`vivo_guest`) in AuthContext (`guest`/`enterGuest`/`exitGuest`); server auth is still the enforcement (member writes 401).

**Rule:** every member-write UI entry point must show a sign-in fence (GuestGate → exitGuest → welcome screen), not a failing authenticated control. That includes not just tabs (Community/Rewards/Account) but **deep-linkable URL-state overlays** — `?event=` (RSVP), `?page=tryon|survey|contact|mydata` — and post like/comment cards, reels, survey/try-on promos on Home.

**Why:** completion code review rejected twice for guests reaching RSVP/composer/like controls via Home links and direct URLs; tab-level gating alone is insufficient.

**How to apply:** when adding any new member-write surface or page id, either gate it on `member` in CommunityShell's overlay fence list or fence its entry controls. Read-only browsing (products, cart/wishlist local state, news/legal/help) stays open to guests.
