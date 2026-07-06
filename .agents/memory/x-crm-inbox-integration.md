---
name: X (Twitter) CRM inbox integration
description: How the X/Twitter social engine differs from the FB/IG engines in the Clienteling CRM inbox, and its dual-auth trigger.
---

# X (Twitter) CRM inbox engine

X is a first-class platform in the Clienteling CRM social inbox (artifacts/vivo-crm, /crm/), mirroring the Facebook + Instagram engines in `crm_clienteling.py`. Scope is the CRM Inbox ONLY — NOT the BI "Social" page, NOT scheduled outbound posts.

## Two things that differ from FB/IG (non-obvious)

- **Split auth tiers per capability.** X reads (own posts, mentions) use a **Bearer token** (`X_BEARER_TOKEN` + `X_USER_ID`/`X_USERNAME`). Replies and DMs use **OAuth 1.0a user context** (`X_API_KEY`/`X_API_SECRET`/`X_ACCESS_TOKEN`/`X_ACCESS_TOKEN_SECRET`) with a stdlib HMAC-SHA1 signature (no oauth libs — same stdlib-only constraint as PBKDF2/Google-OAuth in this repo). So a deployment can be read-configured but not write-configured; missing tier/scope is surfaced in `scopes_missing` and must NEVER crash the sync.
  **Why:** X gates DMs + writes behind paid API tiers / elevated scopes that reads don't need.

- **`/api/social/x/sync` is dual-auth** (unlike FB/IG sync which is staff-session-only). It is in a NEW middleware set `_AUTH_INTERNAL_OR_SESSION_PATHS` in `api_pg.py` (distinct from the strict internal-only `_AUTH_INTERNAL_TOKEN_PATHS`): a valid `X-Internal-Token` short-circuits (lets the headless sync loop bootstrap it), otherwise it FALLS THROUGH to normal session auth + the `/api/social` role gate (so a browser hit still needs marketing+). The endpoint re-checks `_internal_ok(request)` to decide whether to skip the staff-role assertion.
  **Why:** the inbox self-bootstraps from the sync loop on a fresh prod DB (like fabric/production/images) AND staff can hit "Sync from X" manually.

## Sync-loop cadence gotcha

Any per-cycle POST added to `sync_incremental.py` fires **every 60s** (main() loops on `time.sleep(60)`). Hour-gate it with a module-level timestamp global (pattern: `_LAST_X_SYNC` / `_LAST_VALIDATION_RUN` — stamp `now` up front, `>= 3600`) or you hammer X's rate-limited tiers. Treat HTTP 400 as "not configured" (expected, harmless) and 409 as "already running" (benign); stamp the guard in all three branches so a not-configured deployment doesn't retry every cycle.

source_id prefixes: `xpost:` / `xmention:` / `xdm:`. Cursors: `social.x.*` in `crm_config` (mirror the IG `social.ig.*` layout). Posts get NULL sentiment; mentions/DMs get LLM sentiment (never blocks the response).
