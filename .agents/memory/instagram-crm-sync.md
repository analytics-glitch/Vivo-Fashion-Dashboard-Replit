---
name: Instagram → vivo-crm Inbox sync
description: How the IG (@vivo_woman) sync engine mirrors the FB Page sync into crm_social_feedback; the /tags data-volume trap and mention resumability rule.
---

# Instagram sync into the vivo-crm Inbox

The IG sync engine lives in `crm_clienteling.py` inside `_reg_social(app)`, right
after the FB engine, and is a deliberate mirror of the Facebook Page deep-backfill
pattern (see `facebook-page-integration.md` / `fb-sync-deep-backfill.md`). It reads
the IG **business account linked to the same FB Page** — no new secrets: it reuses
`FACEBOOK_PAGE_ACCESS_TOKEN` / `FACEBOOK_PAGE_ID`. `_ig_user()` resolves the linked
IG id/username dynamically (`instagram_business_account{id,username}` on the page
node, 1h in-proc cache). Rows land in `crm_social_feedback` with
`platform='instagram'`.

- Source-id prefixes (dedup via `ON CONFLICT(source_id)`): `igmedia:<id>` = post,
  `ig:<comment-id>` = comment (parent `igmedia:<media>`, inline replies flattened),
  `igtag:<media-id>` = mention. LLM sentiment (`A._fb_sentiment`) runs only on FRESH
  rows, never blocks the response.
- Progress/cursor config keys are `social.ig.*` and are written at the END of a run:
  `last_synced_at`, `last_sync_posts/comments/mentions`, `deep_cursor`/`deep_done`
  (posts/comments), `mention_deep_cursor`/`mention_done`, `last_mention_error`,
  `last_scopes_missing`.
- Phases share ONE 240s budget in order (fresh media → posts/comments deep backfill
  → Phase M mentions). A later phase only gets time once earlier phases finish, so a
  single run can legitimately skip mentions when posts/comments eat the whole budget
  — mentions converge over successive runs once posts `deep_done`. This is expected,
  not a bug, and matches how FB DMs wait behind posts/comments.
- **DMs are out of scope** by design (a clean seam; add later as a Phase C like FB).

**Why:** the marketing team manages @vivo_woman from the same cockpit as the FB
Page; keeping one engine shape means one mental model and shared helpers (`_fb_get`,
`_fb_post`, `_fb_sentiment`, `_cfg_get/_cfg_set`, `_fb_ts` on the `A`=api_pg alias).

## Trap 1 — the `/tags` edge over-fetch (Graph error #1)

Requesting aggregate fields (`like_count`, `comments_count`) on `{ig_id}/tags`
raises Graph error #1 "please reduce the amount of data you're asking for" over a
large tagged-media set, so **mentions silently never ingest** (`last_mention_error`
records it; the rest of the sync is unaffected). Request only the fields actually
consumed — `id,caption,permalink,timestamp,username` — with a modest `limit` (25).

## Trap 2 — mention phase MUST be cursor-resumable, not restart-from-page-1

**How to apply:** Phase M must mirror the posts Phase A + Phase B, NOT a naive
newest-first loop that stops on a zero-new page. A restart-from-page-1 walk that
breaks on `page_new == 0` re-hits the newest (already-seen) page every run and never
advances to older mentions — it can never reach `_IG_SYNC_MENTION_TARGET`. Correct
shape: a fresh newest-first pass (catch new tags, stop on 0-new) THEN a deep pass
that **resumes from the persisted `mention_deep_cursor`** and continues PAST
already-seen pages until cursor exhaustion / budget / target (never stopping on a
0-new page). Set `mention_done` + clear the cursor only on true exhaustion.

**Why:** first pass ingested the newest page then every later run stopped instantly,
so the deep history never filled — the same resumability lesson as the FB deep walk.

## Known inherited fragility (accepted for FB parity)

Config finalization runs after `except HTTPException: raise`, so a non-HTTPException
mid-phase skips the end-of-run `_cfg_set` writes (that run's progress isn't saved;
the next run just resumes from the last persisted cursor — no data loss). This is
inherited verbatim from the FB engine and left as-is to keep the two engines
identical.
