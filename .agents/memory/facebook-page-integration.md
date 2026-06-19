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
