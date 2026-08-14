---
name: Community app public API
description: Customer-facing /api/community/* endpoints — public-prefix auth pattern, demo OTP design, abuse guards, pooled DB access, privacy & legal/consent contracts
---

# Customer-facing Community app (/app/ + /api/community/*)

The standalone customer app (artifacts/vivo-community, served at /app/) talks to
public endpoints on the main FastAPI server. Pattern mirrors /api/loyalty.

## Public-prefix rules (invariant)
- The api_pg auth middleware lets the whole `/api/community/` prefix through with
  NO staff session; every member-scoped handler must therefore self-validate its
  Bearer token (sha256 stored in community_sessions, purpose 'member'/'signup')
  and fail closed 401. Anything added under this prefix is internet-reachable.
- **Why:** staff auth and customer auth are separate identity systems; the prefix
  bypass is the only join point, so a handler that forgets its own gate is public.
- **How to apply:** new community endpoints must (a) call the member-session
  helper, or (b) be intentionally public (catalogue/images) AND get a throttle.

## Abuse guards (required on every public endpoint)
- In-process sliding-window throttles keyed ip / phone / global. Lesson learned:
  **two rules on the same dimension must not share a bucket key** — include the
  window in the key, or every hit is counted once per rule and the effective
  limit halves (probe fired at ~8 of a nominal 15).
- OTP hygiene: per-phone resend gap lives in the DB row; attempts capped per code;
  phone/ip/global request budgets in front of it (SMS-pumping fence for when a
  real provider is connected).
- Caches keyed by anything caller-controlled (category strings, SKUs) must be
  size-capped; product images use a capped LRU that caches negatives too, so
  random-SKU probing can't become per-request DB hits.
- Rate-limit keys must derive the client IP from the **LAST** X-Forwarded-For
  entry (the one the trusted platform proxy appended); the first entry is
  attacker-supplied, letting one host mint unlimited fresh buckets. Pair with a
  hard bucket-table cap: at capacity sweep stale buckets, then evict the
  oldest-inserted — forged never-seen keys must never grow memory unbounded.

## Demo OTP design (user-accepted for rollout)
- A random code is generated first; when no SMS provider is configured the stored
  code is overwritten with fixed 123456 and the response carries demo:true (UI
  shows an amber banner). Plug-in point: implement _send_otp_sms() and make
  _sms_configured() detect the provider secret — verify logic never changes.

## DB access
- Handlers are sync def (threadpool) and borrow connections from the host API
  pool via the api module's _acquire_conn (clean 503 when saturated) — never one
  raw psycopg2 conn per public request. Pool conns can arrive autocommit=True
  (run_query sets it); reset to False before transactional writes.

## Data linking
- Members match all_customers by right-9-digit phone (best customer by
  total_orders); points = 200 welcome + floor(spend/50); tiers 0/500/1000.
  Points are display-only — no redemption backend yet.

## Client-side bag & wishlist storage
- Bag + wishlist live in localStorage as a **per-member map** (`{members: {id: items}}`,
  with one-time migration from the old single-record shape). Keep the map shape —
  reverting to a single record wipes other members' saves on shared devices; toggle
  decisions must run against a synchronous ref (double-tap atomicity).
- Wishlist stock hydration fetches PDPs through a small bounded worker pool + short
  client cache (public throttle is per-IP); in-flight fetches must survive effect
  re-runs — only unmount may discard results.

## Member privacy layer (usernames)
- Public identity on ALL community surfaces (feed, leaderboard, winners, fit notes, spotlight) = `@username` only; real name/phone/points never render publicly. Tier badges AND tier-coloured Avatar rings are opt-in via `show_tier`/`showTier` — gate both, the ring alone leaks tier.
- Leaderboard ranks by weekly contribution count, never points balances; `show_leaderboard=false` removes the member entirely (footer row explains own visibility).
- `community_members.username`: UNIQUE partial index on LOWER(username); all write paths normalize via `_norm_username` first. 409 detail shape `{code:"username_taken", message, suggestions}` shared by signup + settings; IntegrityError race → rollback + fresh suggestions.
- Signup token is single-use via atomic claim: DELETE by token_hash then check `cur.rowcount == 0` → 401. The username-taken 409 raises BEFORE the claim so the token survives for a retry with a new name.
- `_me_cache` eviction happens AFTER commit (not before payload build), or a concurrent /me can re-seed pre-commit data.
- Frontend availability checks (AuthFlow + TabProfile) are 400ms-debounced with a ref-based stale-response guard: strict `ref.current !== requested` return — no extra escape clauses (an `!== ""` clause let cleared-field stale responses through).
- If live UGC ever ships: derive public avatar initials from the username, not the real name (mock initials happen to match, live data won't).

## Scarcity privacy is a payload contract (2026-08)
"No exact stock counts customer-facing" means the PUBLIC API, not just UI copy:
- /products items and /product/{sku} ship availability booleans only (`in_stock`, `low` = 1..5) — never soh/stock/total_stock numbers. Sold-out size disabling and wishlist stock lines derive from the booleans.
- Bag quantity caps use the fixed `MAX_PER_ORDER` constant (ui.jsx), never live stock; real quantity enforcement belongs at the future checkout boundary.
- Merch badges (`selling_fast`/`best_seller`) come from a catalogue-wide map computed off the request path and stamped onto response copies at return time — cached payloads must never pin a cold empty badge map.
**Why:** the first badge pass removed counts from copy but left sizes[].stock/total_stock in the public PDP JSON — review failed it: the network tab is customer-facing.
**How to apply:** any new community endpoint or the checkout/server-side-bag work must keep counts out of payloads and re-derive availability as booleans.

## Legal & consent contracts (2026-08)
- Draft legal docs (Terms/Privacy) must NEVER render draft status as customer-visible text — status/version ride as `data-legal-*` DOM attributes + code comments only; visible copy carries version + effective date.
- `consent_terms_version` is SERVER-authoritative: signup records only versions in the published allowlist (client's claimed value is advisory, forged strings can't be stored). Bump the server constant + allowlist in lockstep with the frontend LEGAL_META when terms change.
- Marketing-reuse consent (featuring UGC in Vivo's own marketing) is a SEPARATE per-entry opt-in — never pre-checked, upload works without it; distinct from membership-terms consent.
- Membership is 18+: the client date-picker max is UX only; the server-side signup cutoff (with Feb-29 fallback) is the enforcement point.
**Why:** review failed a first pass where the consent record trusted a raw client string — audit trails must not be client-writable.
