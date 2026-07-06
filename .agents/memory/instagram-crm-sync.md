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
  → Phase M mentions → Phase C DMs). A later phase only gets time once earlier phases
  finish, so a single run can legitimately skip mentions/DMs when earlier phases eat
  the whole budget — they converge over successive runs once earlier phases are
  `deep_done`. This is expected, not a bug, and matches how FB DMs wait behind
  posts/comments.
- **DMs (Instagram Direct) are IN scope** as a Phase C mirroring the FB DM phase:
  `igdm:<msg_id>` source ids, INBOUND only (`from.id != ig_id`), parent
  `igconv:<thread>`, cursor keys `social.ig.dm_deep_cursor`/`dm_deep_done`, counters
  `social.ig.last_sync_dms`, error key `social.ig.last_dm_error`, missing scope
  `instagram_manage_messages` (reported in `scopes_missing`, never fails the sync).
  Conversations are walked via `GET /{page-id}/conversations?platform=instagram`
  (reusing the linked FB Page token) and the Inbox reply sends a real Direct message
  via `POST /{page-id}/messages` to the sender's IGSID (stored in `author_handle`),
  surfacing the Graph error (e.g. 24-hour window) as a 502 without stamping
  `replied_at`. IG DM `author_name` is the sender's @username (FB DM uses `name`).
- **Auto-run:** the IG sync (with the FB sync) now runs hourly from `sync_incremental.py` (no more manual "Sync from Instagram" button dependency) — see the auto-run + two-layer-auth note in `fb-sync-deep-backfill.md`.

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

## Reply delivery must have a branch per (platform, type)

The Inbox reply endpoint (`cl_soc_feedback_reply`) delivers to the real platform
only via an explicit per-(platform,type) branch: IG comment → `/{id}/replies`,
FB comment → `/{id}/comments`, FB DM → Send API `/{page_id}/messages`. Any type
with NO branch falls through to a local-only `UPDATE reply_body/replied_at` and
returns `delivered=false` — i.e. it is saved but NEVER posted to FB/IG. A missing
branch is a silent "logged-only success", not a delivery.

**Why:** FB *comment* replies (the bulk of comments) originally had no branch, so
staff replies were saved locally and never appeared on Facebook. The UI must show
`delivered` vs logged-only honestly (return `delivery_channel`), or ops assume a
reply went out when it did not.

**How to apply:** when adding a new ingested type (e.g. IG DMs — task #500), add
its matching delivery branch AND set `delivery_channel`, or it will silently log
without sending.

## Known inherited fragility (accepted for FB parity)

Config finalization runs after `except HTTPException: raise`, so a non-HTTPException
mid-phase skips the end-of-run `_cfg_set` writes (that run's progress isn't saved;
the next run just resumes from the last persisted cursor — no data loss). This is
inherited verbatim from the FB engine and left as-is to keep the two engines
identical.
