---
name: Customer-facing loyalty membership card
description: How the self-service loyalty layer (enrol/login/redeem without staff login, POS barcode earn) is wired and the two security invariants it must keep.
---

# Customer-facing loyalty (Carrefour-style membership card)

Shoppers enrol, check tier/points, and redeem WITHOUT any staff login; a scannable
membership barcode lets the POS earn points. Reuses the same backend + auth file +
branding + KES. Points/tiers live in the EXISTING `crm_loyalty_enrolment` /
`crm_loyalty_ledger` / `crm_redemptions` keyed by the member's `customer_id`
(`mbr:`+hex). Member identity is a SEPARATE table `crm_loyalty_member` — it is NOT a
staff `app_users` row.

## Two security invariants (do not regress)

### 1. POS earn idempotency is a HARD DB invariant, not just a pre-check
`POST /api/crm/loyalty/earn` must never double-credit on retry/race. A SELECT-then-INSERT
pre-check alone is NOT enough — two concurrent same-`transaction_id` requests can both pass
it. The guarantee is a partial-unique index `uq_crm_ledger_earn_txn` on
`crm_loyalty_ledger(customer_id, transaction_id) WHERE reason='earn' AND transaction_id IS NOT NULL`,
and the earn path inserts the ledger row FIRST with `ON CONFLICT … DO NOTHING RETURNING id`;
if zero rows return, it rolls back and returns `duplicate:true` with the existing balance so
the spend + balance updates never double-apply.
**Why:** points are money-equivalent; a retry/double-tap or POS resend must be safe.
**How to apply:** any new earn/credit path that takes a client transaction id must rely on
the unique index + ON CONFLICT, never on a bare pre-SELECT. A manual staff award with NO
transaction_id intentionally always credits (each is a deliberate action; double-tap is
guarded client-side by a disabled button).

### 2. PIN login is brute-force throttled
`POST /api/loyalty/login` is phone + a 4–6 digit PIN = low entropy. 5 consecutive bad PINs
lock the account for 15 min (HTTP 429); a correct PIN clears the counter. `failed_logins` +
`locked_until` live on the `crm_loyalty_member` row and the whole check-and-bump runs in one
`_users_tx(lock=True)` advisory-locked tx so concurrent guesses can't race past the cap.
Unknown phone returns the SAME 401 as a wrong PIN (no account enumeration).
**Why:** a 4-digit PIN is ~10k combos; without throttling it's trivially brute-forced for
account takeover + redemption fraud.

## Auth model
- Public paths `POST /api/loyalty/{enrol,login,logout,redeem}` + `GET /api/loyalty/me` are
  bypassed in `clerk_auth_gate` (they self-authenticate via the member token, not a staff
  session). They are the ONLY non-`/api/crm/*` loyalty paths. Members still cannot reach
  staff `/api/crm/*` data — that stays role-gated.
- Device session = a card token: minted on enrol/login, `secrets.token_urlsafe(32)`,
  **sha256-hashed at rest** in `card_token_hash`, sent by the client as the `X-Member-Token`
  header. PIN reuses the staff PBKDF2 `_hash_password`/`_verify_password`.
- Enrol mirrors the member into `crm_customer` (`is_manual`, `created_by='loyalty:self'`) +
  `crm_loyalty_enrolment` so staff 360 / loyalty admin see self-enrolled members.

### 3. Redeem-code apply must re-check status under a row lock (no double spend)
Members redeem points online/in-app → get a `discount_code` (`VFG-…`) stored
`code_status='issued'` in `crm_redemptions` (points already deducted at issue time).
Staff burn it at the till via `POST /api/crm/loyalty/redeem-code/apply`: it does
`SELECT … FOR UPDATE` on the row by `discount_code`, RE-checks `code_status='issued'`
inside the tx (returns 409 if already used, 404 if unknown), then sets `used`. The
separate `…/redeem-code/lookup` preview is read-only and can go stale — never trust it
for the final burn.
**Why:** a code = KES discount; a stale lookup + two concurrent tills must not let the
same code be spent twice. Applying only burns the code + surfaces the KES value; it does
NOT re-deduct points.
**How to apply:** any "consume a single-use code/voucher" path must FOR-UPDATE-lock the
row and re-assert its unused status in the same tx, not rely on a prior read.

## Clients
- Mobile (`artifacts/vivo-mobile`): `lib/member.ts` keeps the token in AsyncStorage key
  `vivo_member_token`. The `app/member/` group (index card with CODE128 barcode via
  `react-native-barcode-svg` on react-native-svg, enrol, login) must be reachable while the
  STAFF app is unauthenticated — `app/_layout.tsx`'s redirect gate allows `segments[0]==="member"`
  exactly like `login`, and the root Stack registers `member`. If a future auth change bounces
  unauthenticated users, re-check that the `member` segment is still whitelisted.
- Staff "award points by code" UI: web `src/pages/CRM.jsx` Loyalty tab + mobile
  `app/crm-loyalty.tsx`, both POST `/api/crm/loyalty/earn`.

## Gotcha
- `crm_loyalty_member.phone` is stored NORMALIZED (`_crm_norm_phone` → `+254…`), so deleting
  test members by the raw `07…` phone matches 0 rows. Delete by `member_id`/`customer_id`.
