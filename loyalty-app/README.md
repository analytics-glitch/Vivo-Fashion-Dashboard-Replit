# Vivo Loyalty — Shopify-connected Loyalty PWA (Replit edition)

A premium, installable customer loyalty app for the **Vivo** brand on ShopZetu.
This is a **Replit-ready clone** of the live app.

> ### 📌 Start here
> - **`replit.md`** — project context + **design system & architecture rules**.
>   **Read before changing any UI.** It exists so this app keeps *our* look and feel
>   and doesn't drift toward generic Replit-template styling.
> - **`REPLIT_SETUP.md`** — step-by-step setup: database, secrets, deploy, domain,
>   Google OAuth, Shopify webhooks, data migration.
> - **`design-palette.md`** — the full colour/blur design system reference.

---

## Stack

- **Frontend** — `the-loyalty-app/` · React Router 7 (**SPA mode**) + Tailwind v4, mobile-first, installable PWA
- **Backend** — `loyalty-app-backend/` · Fastify + TypeScript + Prisma + PostgreSQL
- **Single origin** — in production Fastify serves **both** the built SPA and `/api`.
  `VITE_API_URL` stays **empty**.

```
Browser ──HTTPS──▶ Fastify (SPA + /api + /webhooks) ──▶ PostgreSQL
                              └─▶ Shopify Admin API + Storefront API
```

## Features

| Feature | Details |
| --- | --- |
| 🔐 Auth | Google OAuth + passwordless email OTP (with one-tap magic link) |
| ⭐ Points | Ledger-first engine, tiers + multipliers, signup/birthday bonuses |
| 🎁 Rewards | Redeem points → real Shopify discount codes |
| 🤝 Referrals | Share code/link, invite by email, both sides earn |
| 🛍️ Shop | Curated Vivo collections, product detail, **in-app cart** (Storefront API) → Shopify checkout |
| ❤️ Wishlist | Saved to the account — follows you across devices |
| 📦 Orders | Live orders & returns from the Shopify Admin API |
| 🛠️ Admin | `/admin` — signups, active now, installs, logins, last seen (EAT), app version |
| 📲 PWA | Installable, offline shell, "Update available" banner |

## Quick start

```bash
npm run install:all     # install both workspaces
npm run db:deploy       # apply Prisma migrations
npm run db:seed         # seed tiers + rewards (first run only)
npm run dev             # Vite :5173 (HMR) → proxies /api to Fastify :4001
```

Production: `npm run setup` (install + build + migrate) → `npm start`.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Both dev servers (Vite + API) |
| `npm run build` | Build SPA + compile API |
| `npm run setup` | install → build → migrate (Replit deploy build step) |
| `npm start` | Run Fastify (serves SPA + API) |
| `npm run typecheck` | Typecheck both workspaces |
| `npm run db:deploy` / `db:seed` / `db:studio` | Prisma helpers |

## Config

All config is env-driven — see `loyalty-app-backend/.env.example`.
On Replit use **Secrets** (never commit `.env`). Details in `REPLIT_SETUP.md`.

---

**Note:** this clone is independent of the live production deployment
(`loyalty.shopzetu.com`), which continues to run on our own server. Changes here
do not affect it. If this is a staging clone, **don't** point Shopify webhooks at
both instances — customers would earn points twice.
