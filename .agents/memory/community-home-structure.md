---
name: Community-first homepage structure
description: Vivo Community home is a fixed community-first section order; shopping content deliberately demoted/moved.
---
The home tab follows a fixed community-first order (stakeholder-approved brief, tightened by the 2026-08 Home-vs-Shop rewire): hero (Join the Conversation primary CTA — NO "Shop the edit"; the seasonal hero + Shop-the-edit CTA now sits at the top of the Shop tab) → mission → personal moments → feed preview → reels → style question of the week → next event → Community Spotlight → Styled for You (opt-in invite; when opted in, a compact "See my picks in Shop" card — never a ProductRail on Home) → rewards → Vivo Stories → Second Life. Vivo Edits moved to the Community tab feed (default view only) with Shop-the-Look stripped from its "Worn by the community" sub-cards; the ?edit= detail view keeps its shop section.

**Rules:**
- Feed preview: max 4 posts, engagement-ranked, question posts excluded (the top question is featured separately); `openPost` must resolve back into the FULL feed for the detail modal.
- Community Spotlight = the merged "This Week's Jewel" + "Community Voices" card; jewel from celebrations API with an evergreen fallback quote — never render two separate voice/jewel cards.
- Moved, not deleted: promo banner + try-on entry live on the Shop tab; fit notes on PDP; boards/full news/extra posts in Community. Don't re-add shopping promos to home.
- Guests get the static community intro card in place of the feed preview; member-only: preview, question, Styled for You.
- Home PostCards render WITHOUT product tag pills (pills live in the detail modal/Shop surfaces); EndCap primary = "This week's challenge", shop is a quiet text link.
- Mobile nav is a scrollable top tab row inside the sticky mobile header (same `tab-*-mobile` testids) — the old bottom tab bar is gone; don't re-add fixed-bottom padding.

**Why:** homepage = curated weekly community overview; shopping is secondary by design.
