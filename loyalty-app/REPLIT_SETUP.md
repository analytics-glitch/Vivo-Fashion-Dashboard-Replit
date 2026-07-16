# Deploying Vivo Loyalty on Replit — step by step

This repo is a **self-contained clone** of the live app, prepared for Replit.
The original deployment (nginx + PM2 + Docker Postgres on our own server) is
untouched and keeps running — nothing here affects it.

> **Before you touch the UI**, read **`replit.md`**. It locks in our design system
> and architecture so this app doesn't drift toward generic Replit styling.

---

## What changes vs. our server (and what doesn't)

| Piece | Our server | On Replit |
| --- | --- | --- |
| App code / UI / features | — | **Identical.** Nothing about the app changes |
| PostgreSQL | Docker container | **Replit PostgreSQL** (or Neon/Supabase) |
| Process manager | PM2 | Replit **Deployments** |
| HTTPS + domain | nginx + certbot | Built into Replit |
| Secrets | `.env` file | **Replit Secrets** |

---

## 1. Create the Repl

1. Upload/import this folder into a **new Repl** (Node.js). If importing from
   GitHub, push this folder to a repo first.
2. Replit reads `.replit` automatically:
   - **Dev:** Vite on `5173` (HMR) proxying `/api` → Fastify on `4001`
   - **Deploy:** `npm run setup` then `npm start` (Fastify serves SPA + API on one port)
3. Confirm **Node ≥ 22.22** (the `nodejs-22` module). The React Router build requires it.

## 2. Add the database

**Tools → Database → Create a PostgreSQL database.**
Replit injects **`DATABASE_URL`** as a secret automatically. Nothing else to configure.

*(Alternative: use Neon/Supabase and set `DATABASE_URL` yourself.)*

## 3. Add Secrets

**Tools → Secrets.** Copy the keys from `loyalty-app-backend/.env.example`.
Minimum to boot:

| Secret | Value / note |
| --- | --- |
| `DATABASE_URL` | auto-set by Replit's DB |
| `JWT_SECRET` | **required** — generate: `openssl rand -hex 32` |
| `HOST` | `0.0.0.0` (already set in `.replit`) |
| `SERVE_FRONTEND` | `true` (already set in `.replit`) |
| `NODE_ENV` | `production` for deployments |

Then the integrations:

| Group | Secrets |
| --- | --- |
| **Public URLs** | `API_BASE_URL`, `WEB_BASE_URL` — both your Replit URL (see §5) |
| **Google OAuth** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| **Email (OTP)** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |
| **Shopify** | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_STOREFRONT_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` |
| **Shop** | `STOREFRONT_BASE_URL=https://www.shopzetu.com`, `SHOP_COLLECTIONS=vivo-collection,vivo-outerwear-1` |
| **Admin** | `ADMIN_EMAILS=nigel@shopzetu.com` (comma-separated) |
| **Economics** | `POINTS_PER_CURRENCY`, `SIGNUP_BONUS_POINTS`, `BIRTHDAY_BONUS_POINTS`, `REFERRAL_*`, `POINTS_EXPIRY_MONTHS` |

> ⚠️ **Never** set `VITE_API_URL`. It must stay empty — the app is single-origin.

## 4. First run

```bash
npm run install:all
npm run db:deploy     # creates all tables from prisma/migrations
npm run db:seed       # seeds tiers + rewards (first time only)
npm run dev           # then open the webview
```

## 5. Deploy + URLs

1. **Deploy** → choose **Reserved VM** (recommended: no cold starts — an installed
   PWA should feel instant). *Autoscale* works but sleeps and cold-starts.
2. Build command `npm run setup`, run command `npm start` (already in `.replit`).
3. Note your deployment URL, then **set these Secrets to it** and redeploy:
   - `API_BASE_URL` = `https://<your-app>.replit.app`
   - `WEB_BASE_URL` = `https://<your-app>.replit.app`
   - `GOOGLE_REDIRECT_URI` = `https://<your-app>.replit.app/api/auth/google/callback`

### Custom domain (optional)
Replit **Deployments → Settings → Custom domain**. If you point a domain here,
use that domain in the three URLs above.
⚠️ Do **not** reuse `loyalty.shopzetu.com` unless you're retiring the live app —
that DNS currently points at our server.

## 6. Update Google OAuth

Google Cloud Console → your OAuth client:
- **Authorized JavaScript origins:** `https://<your-app>.replit.app`
- **Authorized redirect URIs:** `https://<your-app>.replit.app/api/auth/google/callback`

Must match `GOOGLE_REDIRECT_URI` **exactly**. (OTP login works without this.)

## 7. Shopify webhooks (only if this instance should award points)

Point these at the Replit URL, using the app's API secret as `SHOPIFY_WEBHOOK_SECRET`:

| Topic | URL |
| --- | --- |
| `orders/paid` | `https://<your-app>.replit.app/webhooks/shopify/orders-paid` |
| `refunds/create` | `https://<your-app>.replit.app/webhooks/shopify/refunds-create` |

> ⚠️ **Careful:** if both the live app and this Replit clone receive `orders/paid`,
> customers get points **twice**. For a staging clone, either don't add webhooks or
> point Shopify at only one instance.

---

## 8. Moving the data (only if this replaces production)

The clone starts with an **empty database** (schema only). To carry over real
users/points/wishlists/carts:

```bash
# On our server — take a dump
docker exec zetu-loyalty-db pg_dump -U loyalty -d loyalty --no-owner --no-acl > vivo.sql

# Restore into Replit's Postgres (run from the Repl shell, DATABASE_URL is set)
psql "$DATABASE_URL" < vivo.sql
```

**Verify before switching DNS**, and keep the original server running until the
Replit instance is proven. Note our current DB is a Docker volume with **no
backups** — take a dump regardless.

---

## 9. Sanity checklist

- [ ] `npm run typecheck` passes
- [ ] App loads; login via **OTP** works (check the Repl logs for the code if SMTP is unset)
- [ ] Google sign-in works (URIs match)
- [ ] Shop tab lists the curated Vivo collections; products show images
- [ ] Add to cart → cart badge → checkout opens Shopify
- [ ] `/admin` reachable for an `ADMIN_EMAILS` account (**log out/in once** — the role is applied at login)
- [ ] PWA installs; manifest + `sw.js` return 200

## 10. Gotchas (learned the hard way)

- **Never** flip `@fastify/static` to `wildcard: false` → new chunks 404 after a rebuild → app stuck on splash.
- **Never** let the SPA fallback return `index.html` for `/assets/*` → HTML parsed as JS → hydration hangs.
- **Never** make the service worker cache assets.
- These are documented in `replit.md` §3. Please keep them.
