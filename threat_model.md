# Threat Model

## Project Overview

Vivo Fashion Group BI is a multi-tenant executive BI cockpit for a multi-brand fashion retailer operating across East Africa (Kenya, Uganda, Rwanda, and Online). It exposes sales analytics, inventory, customer data, HR attendance, CRM/loyalty, social integrations, and operational tooling via a publicly deployed FastAPI backend (`api_pg.py`) backed by a live Neon PostgreSQL database. The frontend is a React/Vite SPA. The deployment is a Replit Reserved VM with visibility set to `public` at `https://vivofashionbrands.com`.

## Assets

- **Staff session tokens** — short-lived opaque tokens delivered to the web SPA solely as an httpOnly `session_token` cookie (no `localStorage` copy; the mobile app uses its own Bearer/AsyncStorage flow). Compromise allows impersonation of any staff role.
- **Customer/member data** — PII including names, phone numbers, email addresses, purchase history, and loyalty points for customers across all brands. Stored in PostgreSQL.
- **Business intelligence data** — multi-brand sales figures, inventory, margins, and financials. A data breach could expose competitive pricing and vendor relationships.
- **Application secrets** — `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`/`SECRET`, `FACEBOOK_PAGE_ACCESS_TOKEN`, Stripe-adjacent loyalty config. Compromise allows database access or OAuth impersonation.
- **Admin user accounts** — `app_users` with roles from `employee` (minimal) to `admin` (full). Admin accounts can promote users, adjust loyalty points, and access all BI data.
- **Loyalty points balance** — financial value redeemable for discounts. Manipulation would cause direct business loss.

## Trust Boundaries

- **Browser ↔ API**: All /api/* requests cross this boundary. The `clerk_auth_gate` middleware enforces authentication and role-based access on every request. The API must never trust client-supplied role or tenant identifiers.
- **API ↔ PostgreSQL**: The API server has full database access via connection pools. SQL injection at the API layer would grant full database read/write.
- **API ↔ External Services**: Google OAuth, Facebook Graph API, Recon Odoo staging. Credentials stored as env secrets; SSRF or key leakage would allow unauthorized operations.
- **Public ↔ Authenticated**: Health probes (`/api/healthz`, `/api/readyz`), loyalty member endpoints (`/api/loyalty/*`), community app (`/api/community/*`), and lookbook share links (`/api/public/*`) are intentionally unauthenticated. All other `/api/*` paths require a valid staff session.
- **User ↔ Admin**: The `admin` role can manage users, roles, and data-quality fixes. Role-specific gates are enforced server-side in `clerk_auth_gate`.
- **Loyalty member ↔ Staff**: Loyalty members use a separate `X-Member-Token` (not a staff session). Member endpoints validate this token internally and cannot access staff-only data.

## Scan Anchors

- **Primary entry point**: `api_pg.py` (FastAPI, port 8080) — all `/api/*` routes; middleware gate is `clerk_auth_gate` at line ~1360.
- **High-risk areas**: Auth endpoints (`/api/auth/login`, `/api/auth/google/*`); admin endpoints (`/api/admin/*`); loyalty endpoints (`/api/loyalty/*`); CRM endpoints (`/api/crm/*`).
- **Public surfaces (unauthenticated)**: `/api/healthz`, `/api/readyz`, `/api/sync-status`, `/api/environment`, `/api/auth/login`, `/api/auth/google/login|callback`, `/api/loyalty/*`, `/api/community/*`, `/api/public/*` (except `/api/public/attendance` which requires `SESSION_SECRET`).
- **Standalone services**: `fabric_api.py` (dev-only standalone, not mounted in production), `community_app.py` (mounted via router), `hr_attendance.py`, `crm_clienteling.py`, `fabric_router.py`.
- **Frontend**: `artifacts/vivo-bi/src/` — React SPA; `src/lib/auth.jsx` and `src/lib/api.js` manage token lifecycle.

## Threat Categories

### Spoofing

Authentication uses PBKDF2-SHA256 (200k iterations) for staff passwords, Google OAuth for SSO, and opaque session tokens stored as httpOnly cookies. The `POST /api/auth/login` endpoint enforces a per-account lockout (10 consecutive failures → 15-minute lock, tracked in `app_users.failed_logins`/`locked_until`) plus a per-IP failed-attempt throttle (20 fails per 15 minutes, client IP taken from the trusted proxy's rightmost `X-Forwarded-For` entry). Google OAuth state is validated via a short-lived httpOnly cookie (CSRF protection is present). The loyalty login (`/api/loyalty/login`) implements per-account lockout (5 attempts, 15-minute lock).

**Guarantees required**: Staff login MUST implement IP-based rate limiting or account lockout to prevent credential brute-force. Session tokens MUST NOT be stored in localStorage (XSS-accessible); the httpOnly cookie alone is sufficient.

### Tampering

SQL queries throughout `api_pg.py` use parameterized statements (`%s` placeholders). Date filter params are centrally validated against an ISO-date regex before reaching any query. Allowlist-validated ORDER BY columns prevent injection in sort parameters. Admin-executed `UPDATE` patches via `/api/admin/validation-exceptions/{id}/apply-fix` are additionally checked against an allowlisted table list and forbidden-keyword regex.

**Guarantees required**: All database queries MUST use parameterized statements. Date params MUST pass ISO date validation before use in queries.

### Information Disclosure

Email addresses are logged at `INFO` level at multiple points in `api_pg.py` (lines 1935, 1948, 1951, 1987, 9153). The community throttle log at `community_app.py` line 674 logs the composite rate-limit key which includes the member's phone number. In a compromised or externally shipped log environment, this constitutes PII leakage.

The staff web SPA no longer persists the session token in `localStorage` (legacy `vivo_token` keys are actively removed) and the Google OAuth web callback redirect carries no token in the URL — the httpOnly session cookie is the sole web credential, so an XSS payload cannot read the session token. Native mobile deep links still receive the token as a query param (a separate process that cannot read cookies).

**Guarantees required**: PII (email, phone) MUST NOT appear in logs. Session tokens MUST be stored only in httpOnly cookies, not in localStorage.

### Denial of Service

Public loyalty endpoints, community app endpoints, and health probes are rate-limited at the application level. Staff login and Google OAuth endpoints are not explicitly rate-limited at the application level.

### Elevation of Privilege

Role-based access control is enforced server-side in `clerk_auth_gate` for all `/api/admin/*`, `/api/crm/*`, `/api/social/*`, `/api/production/*`, and `/api/pd/*` paths. The `employee` role is fenced to salary-advance endpoints only. Custom group slugs are validated against a reserved-name allowlist.
