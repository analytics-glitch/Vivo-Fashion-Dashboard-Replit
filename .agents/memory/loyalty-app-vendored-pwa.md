---
name: Vendored loyalty PWA at /loyalty-app
description: Standalone Shopify loyalty PWA vendored AS-IS at repo-root loyalty-app/; own stack, own Postgres schema, second service on api-server artifact.
---

# Vendored loyalty PWA (/loyalty-app)

- Lives at repo-root `loyalty-app/` (backend `loyalty-app-backend/`, SPA `the-loyalty-app/`), deliberately OUTSIDE the pnpm workspace globs — it uses npm and must stay AS-IS (its own `replit.md` rules are non-negotiable: own design, Fastify+Prisma+cookie/JWT auth, Tailwind v4; do not port to the BI stack or its auth).
- At the 7-artifact cap, it is exposed as a SECOND `[[services]]` block on `artifacts/api-server/.replit-artifact/artifact.toml` (port 8090, paths `["/loyalty-app"]`), not a new artifact. Single Fastify process serves SPA + API + webhooks same-origin under the `/loyalty-app` base path.
- **Why the base path matters everywhere:** basename in react-router.config, `base` in vite.config, API_URL fallback in `app/lib/api.ts`, sw.js SHELL, manifest start_url/scope/icons, cookie `path`, backend route prefixes and notFound handler all carry `/loyalty-app`. Missing any one breaks PWA install or auth cookies.

## Database isolation (critical)

- Prisma tables live in the dedicated `loyalty_app` Postgres schema via `?schema=loyalty_app` appended to DATABASE_URL (derived in `src/config/env.ts` and `scripts/db-env.mjs`; datasource env is `LOYALTY_APP_DATABASE_URL`).
- **Never run `prisma db push` against the shared DB's `public` schema** — Prisma treats the whole schema as declarative and proposed DROPPING BI tables (`warehouse_bins_meta`, …). Use `node scripts/db-env.mjs npx prisma migrate deploy` (empty dedicated schema = clean baseline, avoids P3005).
- After changing the datasource env-var name, `prisma generate` must re-run or the client still targets `public`.

## Graceful secrets degradation

- `LOYALTY_APP_JWT_SECRET` missing → ephemeral random secret + loud warning (boots, sessions don't survive restarts) instead of `process.exit`.
- Google/SMTP/Shopify features are flag-gated (`googleEnabled` etc.) and simply stay off until `LOYALTY_APP_*` secrets exist. WEB_BASE_URL defaults to "" → relative redirects (same-origin).
- All its env vars are `LOYALTY_APP_*`-prefixed to avoid clashing with the BI platform's GOOGLE_/SMTP_/SHOPIFY_ vars.

## Publish gotchas

- The production build runs `npm ci` for BOTH `loyalty-app-backend` and `the-loyalty-app`; if either `package-lock.json` drifts from its `package.json` (e.g. a dep added without regenerating the lock), the WHOLE api-server artifact fails to publish. After any dependency change run `npm install` then verify `npm ci` passes in both dirs.
- Prod verification: `https://<domain>/loyalty-app/health` must return `{"status":"ok",...}` JSON. If it returns the BI SPA's HTML instead, the live deployment predates the second `[[services]]` block (its `/loyalty-app` path isn't registered, traffic falls through to `/`) — the fix is a republish, not code. Same tell: prod DB has no `loyalty_app` tables, deploy logs show only 2 artifact processes.

## Distinct from existing surfaces

- The pre-existing `/loyalty/` artifact (vivo-loyalty member card) and `clerk_auth_gate` are untouched; `/loyalty-app` traffic never passes through `api_pg.py`.
