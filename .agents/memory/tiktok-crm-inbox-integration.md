---
name: TikTok CRM inbox integration
description: How the TikTok social engine differs from FB/IG/X in the vivo-crm marketing inbox, and the TikTok API quirks that bit us.
---

TikTok mirrors the FB/IG/X CRM-inbox engines in `crm_clienteling.py` (deep-backfill with persisted cursors, per-request time budget, comment sentiment via the shared `A._fb_sentiment`, `scopes_missing` reporting, analyst+ server-side role gate in `clerk_auth_gate`, hourly sync-loop trigger gated to once/hour), but with these TikTok-specific realities:

**No DMs.** TikTok has NO public messaging API — the engine pulls only own posts (videos) + their comments. Never add a DM phase or a DM reply path; the inbox strip and toasts must say "posts & comments" only.

**Dual error signalling — check BOTH.** TikTok's Open API returns HTTP 200 with a body `error.code` that is `"ok"` on success and something else on failure. The `_call` helper MUST check the HTTP status AND `body.error.code != "ok"`; relying on HTTP status alone silently treats API errors as success.

**Unconfigured-connector contract.** Until `TIKTOK_ACCESS_TOKEN` is provisioned the status endpoint returns `connected:false` and the sync endpoint returns 400 "not configured" — the frontend shows a connect banner and NEVER crashes. The sync-loop trigger treats 400 as expected/harmless (stamps last-run so it doesn't retry for an hour) and 409 as "already running" (benign).

**Scopes.** Posts need `video.list`, comments need `comment.list`, replying needs the comment-write scope. Missing scopes surface via `scopes_missing` and never fail the rest of the sync.

**Where the pieces live:** TikTok helper block (`_TIKTOK_API`, `_tiktok_*`, `_call`) sits before `_internal_ok`; the engine (status/sync endpoints + `_tiktok_sync_run` phases A/B posts via `/v2/video/list/`, phase C comments via `/v2/video/comment/list/`) is inside `_reg_social`; the reply branch is in `cl_soc_feedback_reply`. Source ids: `tiktok:vid:<id>`, `tiktok:cmt:<id>`, parent `tiktokvid:<vid>`. Config keys `social.tiktok.*`. `/api/social/tiktok/sync` is in `api_pg.py` `_AUTH_INTERNAL_OR_SESSION_PATHS` so the sync loop can POST it with `X-Internal-Token`.
