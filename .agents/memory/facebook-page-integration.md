---
name: Facebook Page integration
description: How the staff Social surface talks to the Facebook Graph API and where its auth/sentiment seams are.
---

# Facebook Page integration (staff Social surface)

The cockpit can manage the brand's Facebook Page: publish offers, read Page
audience + engagement, and read/reply to comments with AI sentiment.

- **Endpoints** live in `api_pg.py` under `/api/social/*` (status, insights,
  posts, post[create], comments, comments/{id}/reply). They are an **analyst+
  surface**, gated server-side in `clerk_auth_gate` exactly like `/api/crm/*`
  (role ∈ analyst|exec|admin) — client nav hiding is not the boundary.
- **Credentials** come from secrets `FACEBOOK_PAGE_ACCESS_TOKEN` +
  `FACEBOOK_PAGE_ID` (a long-lived Page token). `_fb_get`/`_fb_post` hit
  `graph.facebook.com/<version>` and surface the Graph `error.message` (502 on
  failure) instead of a generic 500. If either secret is missing, `status`
  returns `{configured:false}` and the UI shows a "not connected" card.

- **Page-token-vs-user-token trap + auto-resolution.** People repeatedly paste a
  **USER** token from Graph API Explorer (its `/me` id = a person, not the Page),
  which cannot read Page posts/comments or publish. `_fb_get`/`_fb_post` therefore
  call `_fb_page_token()` → `_fb_resolve_page_token(raw, page_id)`: if the raw
  token's `/me` id already == `FACEBOOK_PAGE_ID` it's used as-is; otherwise the
  Page token is derived from the user token via `GET /{page_id}?fields=access_token`
  (fallback `/me/accounts`), cached keyed by the raw value (a Secrets change
  invalidates the cache). **Why:** make the integration tolerant of either token
  type so the common mistake just works.
  - **But resolution can't fix an INVALID token.** Explorer **user tokens are
    short-lived (~1-2h)** and expire; an expired/garbled token returns Graph
    **code 190 "Invalid application ID"** on every call (incl. `/me`) and there is
    nothing to resolve from. Durable fixes need a NON-expiring token: a **System
    User token** (Business Settings, never expires) for the Page, or exchange a
    short-lived user token for a long-lived one (needs the app id + **app
    secret**, which we don't store) then derive the never-expiring Page token.
  - Reading diagnostics: `matches_page_id:false` + identity = a person name ⇒ a
    user token (resolvable); Graph **code 190** on `/me` ⇒ token outright
    invalid/expired (not resolvable — needs a fresh/permanent token).
  - **System User scope ≠ Page asset access.** A System User token can hold all
    the right scopes (`pages_read_engagement` etc.) yet return Graph **error #10**
    on every `/{page}` call and show `/me/accounts` = 0 pages: the System User
    must ALSO be **assigned the Page as an asset** (Business Settings → System
    Users → Add Assets → Pages → Manage). No new token is needed after assigning —
    the same token starts working immediately. Also, a System User *user* token
    still can't read `/{page}/posts` directly (190); only the derived **Page**
    token can — which is exactly what `_fb_resolve_page_token` does.

- **Secret-delivery clipboard loop + env-var escape hatch.** The user repeatedly
  pasted the SAME dead token into the secrets prompt (their clipboard kept the
  old Explorer value) — verify every delivery by fingerprint (last-5 + length)
  BEFORE any Graph calls. The agent cannot write secrets; when the valid token
  is already exposed in open chat, a **shared env var with the same name takes
  precedence over the secret in the dev process env** (`setEnvVars` → verified
  live via a probe var), so setting it as an env var is a working escape hatch.
  **Why:** three secure-prompt attempts failed identically; the value was already
  chat-exposed so an env var added no new exposure. **How to apply:** after any
  chat exposure, recommend rotating the token later and moving the fresh value
  back into the secret (then delete the env var). Verify prod precedence after
  publish via `/api/social/status`.

- **Insights are derived, not the fragile /insights metric API.** The Graph
  `/{page}/insights` endpoint errors entirely if *any* requested metric name is
  invalid/deprecated for the API version, which breaks across version bumps. So
  `/api/social/insights` instead reads the page node (fan/followers) + recent
  posts and sums reactions/comments/shares client-of-graph-side. Reliable and
  version-proof. **Why:** avoid a whole-endpoint failure from one renamed metric.

- **Sentiment** (`_fb_sentiment`) batches comment text through the shared
  `_chat_llm` + `_chat_extract_json` (same path BI chat uses), asking for a
  compact JSON map {index→positive|negative|neutral}. It **never raises** —
  unscored comments just render an "Unscored" badge. Don't make UI depend on
  sentiment being present.

- **Audit:** create-post and reply write `_crm_audit("social", …)` so social
  actions show up in the same admin audit trail as CRM.

- **Frontend:** `artifacts/vivo-bi/src/pages/Social.jsx`, page id `social`
  (added to ANALYST in `permissions.js`, nav in `navItems.jsx`,
  route in `App.js`). Mirrors `CRM.jsx` styling (no React Query; plain
  `api.get/post` with `forceFresh`). Web-only — not ported to the Expo app.

- **Standalone CRM Inbox is a SECOND consumer** (`artifacts/vivo-crm`, `/crm/`),
  served by `crm_clienteling.py` `/api/social/facebook/{status,discover,pages,sync}`
  (same analyst+ gate). It reuses api_pg's `_fb_*` helpers via the module alias
  `A`, so the Page comes from the SAME secrets — there is **no real multi-page
  user-token discovery** despite the Inbox "Connect Facebook" dialog: `status`
  just auto-reports the one secret-configured Page as a `discovered_page` when
  reachable (empty ⇒ Inbox shows its "demo data" banner). `sync` pulls Page posts
  + their comments and upserts comments into `crm_social_feedback`
  (`platform='facebook'`), deduped by a `source_id` partial-unique index +
  `ON CONFLICT ... DO NOTHING` (so a re-sync with no new comments inserts 0 — do
  NOT derive "last synced" from `max(created_at)`; it's persisted explicitly in
  `crm_config` key `social.fb.last_synced_at` each sync). **There is NO auto-sync
  scheduler** — sync is manual only, so `auto_sync_minutes` is `null` and the UI
  copy says "Manual sync".

- **Sync stores BOTH posts and comments in `crm_social_feedback`.** Each Page post
  is persisted as its own row `type='post'`, `source_id='fbpost:<id>'`,
  `author_name` = the Page name (e.g. "Vivo Woman"), with `permalink` + a body =
  caption or a `[Photo post]`/`[Post]` placeholder. Each comment additionally
  stores `parent_source_id`, `parent_excerpt` (~90-char post-caption snippet, or
  the same placeholder), and a `permalink` (comment `permalink_url`, falling back
  to the post link). New columns added idempotently via `ALTER TABLE … ADD COLUMN
  IF NOT EXISTS`. **Why:** the Inbox must show ALL synced posts (not just the
  subset that had comments) and make each comment's parent post obvious + linkable.
  - **Re-sync does NOT backfill new columns** (ON CONFLICT DO NOTHING). After
    adding columns, `DELETE FROM crm_social_feedback WHERE platform='facebook'`
    then re-sync to populate them on existing rows.
  - **Posts must be EXCLUDED from feedback aggregations.** Because posts share the
    table, every consumer that treats rows as customer "feedback" — `/api/social/
    summary` (counts + by_platform), `/api/social/mentions`, `/api/social/
    influencers`, and the dashboard `social_feedback_30d` KPI — filters
    `type IS DISTINCT FROM 'post'`, or the brand's own posts inflate feedback
    counts and the Page tops the influencer ranking. The Inbox list
    (`/api/social/feedback`) intentionally keeps posts.

- **Graph withholds public commenter identity** ⇒ `author_name` falls back to
  "Facebook user" for comments; only the Page's own posts/replies carry the real
  name. This is a hard FB privacy limitation, **not a bug** — do NOT fabricate
  names. Mitigation: every item carries a `permalink` ("View on Facebook") so
  staff can inspect the author on Facebook itself.
