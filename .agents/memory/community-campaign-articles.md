---
name: Community campaign articles ("Join the Conversation")
description: Hero CTA blog + comments — tables, points, moderation, DPA contract
---

- The Home hero "Join the Conversation" CTA opens `?page=article-{slug}` (guest-readable; composer member-gated). Launch slug: `the-new-old-money`.
- Articles are DB rows (`community_articles`) seeded from `_ARTICLE_SEED` constants with the survey-wave upsert contract (constants win only when different). New campaigns = new rows, no new templates.
- Comment machinery mirrors feed comments one-for-one (`community_article_comments` + likes + reports tables, same endpoint shapes) — keep them in lockstep when either evolves.
- **Points:** first comment per article = +5 via `community_points_events` kind `article_comment_{slug}` (UNIQUE(member_id,kind) = per-article cap). More comments never earn.
- **Moderation:** submit-time `_COMMENT_BLOCKLIST` regex (profanity EN/SW + links) rejects with a friendly 400; reports go to `community_article_comment_reports` (DB-review is the v1 contract, no CRM queue yet).
- **DPA:** article comments appear in `/mydata` (unbounded owner query) and are author-deletable via DELETE `/article-comments/{id}` (soft delete, points stay) — per the "new member-data tables must join My Data + delete path" rule.
- Tier badge on comments honours the member `show_tier` opt-in; computed live via `_tier_for(_lifetime_points(...))[0]` per distinct opted-in commenter, never stored.
