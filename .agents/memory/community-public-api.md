---
name: Community app public API
description: Customer-facing /api/community/* endpoints — public-prefix auth pattern, demo OTP design, abuse guards, pooled DB access
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
