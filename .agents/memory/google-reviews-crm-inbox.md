---
name: Google Reviews CRM inbox integration
description: How the Google Business Profile reviews sync/reply works in the CRM Inbox and its gotchas.
---

# Google Reviews (Business Profile) → CRM Inbox

- Mirrors the TikTok pattern: OAuth connect → refresh token persisted in `crm_config` (`social.greviews.*`) → background sync thread with lock + stale detection → hourly hour-gated trigger from the sync loop → status strip in the Inbox.
- **Reuses the project's sign-in OAuth client** (GOOGLE_CLIENT_ID/SECRET) with the `business.manage` scope — no separate credentials. `prompt=consent access_type=offline` forces a refresh token on every connect.
- Data model: rows in `crm_social_feedback` with `platform='google'`, `type='review'`, `source_id='greview:<full v4 review resource name>'` (the reply endpoint needs the full `accounts/../locations/../reviews/..` name), `author_handle` = store/location title, `parent_source_id='gloc:<v4 location name>'`.
- Sentiment is **star-based, no LLM**: 4–5 positive, 3 neutral, 1–2 negative.
- Upsert `ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO UPDATE` refreshes body/rating on edited reviews but **COALESCE-preserves an existing CRM-logged reply** so a resync never clobbers replied_at.
- Replies deliver via `PUT https://mybusiness.googleapis.com/v4/{review}/reply` (upserts — also edits an existing owner reply).
- **Why the reviews API is v4 while accounts/locations are v1:** Google never migrated the reviews methods to the split v1 APIs; the v4 `mybusiness` endpoint is the only reviews read/reply surface.
- **Gate trap:** a new `/api/social/<x>/sync` endpoint called by the sync loop MUST be added to `_AUTH_INTERNAL_OR_SESSION_PATHS` in api_pg.py, and its OAuth callback to the public-path set — the route-level `_internal_ok()` check never runs if the middleware 401s first.
- **User-side prerequisite:** Google's GCP project needs manual Business Profile API access approval + the 3 My Business APIs enabled + the redirect URI `<domain>/api/social/google/oauth/callback` on the OAuth client; until then the connect flow stores the token and shows a friendly "API not approved yet" page, and sync errors surface in `last_run_error`.
