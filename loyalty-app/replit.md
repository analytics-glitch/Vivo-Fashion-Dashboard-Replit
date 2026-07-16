# Vivo Loyalty — project context (READ THIS FIRST)

> **For any AI agent or developer working in this Repl.**
> This is an existing, production-grade app with an established design system and
> architecture. **Do not restyle it, do not rebuild it, do not "modernise" it to
> match other Replit projects on this account.** Follow the rules below exactly.
> When in doubt, copy the patterns already in the code.

---

## 1. What this is

**Vivo Loyalty** — a Shopify-connected customer loyalty **PWA** (installable) for ShopZetu's Vivo brand.

- **Frontend:** `the-loyalty-app/` — React Router 7 in **SPA mode** (`ssr: false`) + **Tailwind v4**
- **Backend:** `loyalty-app-backend/` — **Fastify** + **Prisma** + **PostgreSQL**
- **Single origin:** in production Fastify serves **both** the built SPA **and** `/api`.
  There is no separate web server. `VITE_API_URL` is **always empty**.

```
Browser ──HTTPS──▶ Fastify (serves SPA + /api + /webhooks) ──▶ PostgreSQL
                                    └─▶ Shopify Admin API + Storefront API
```

---

## 2. NON-NEGOTIABLE RULES

**Do NOT:**
- ❌ Add a UI kit — **no shadcn/ui, MUI, Chakra, Bootstrap, Radix, DaisyUI, Ant**.
  This app has its own components in `the-loyalty-app/app/components/ui.tsx`.
- ❌ Add `tailwind.config.js`. This is **Tailwind v4** — theme lives in `app/app.css` under `@theme`.
- ❌ Change the colour palette, fonts, radii, or the nav/tab structure (see §4).
- ❌ Convert the app to SSR, Next.js, Vite-only, or a different router.
- ❌ Replace Prisma/Postgres, or the cookie+JWT auth.
- ❌ Introduce a state library (Redux/Zustand/etc.) — we use React Context
  (`lib/auth.tsx`, `lib/cart.tsx`, `lib/wishlist.tsx`).
- ❌ Set `VITE_API_URL` to anything. It must stay **empty** (same-origin).
- ❌ Scaffold a "Replit template" look. Ignore other projects' conventions on this account.

**Always:**
- ✅ Reuse `components/ui.tsx` (`Button`, `Card`, `Badge`, `Skeleton`, `EmptyState`, `Spinner`).
- ✅ Reuse `components/icons.tsx` (inline SVG). Add new icons **there**, same style.
- ✅ Use `useToast()` from `components/toast.tsx` for feedback.
- ✅ Mobile-first. The whole app is a **centred `max-w-md` column** (`AppShell`).
- ✅ Keep TypeScript strict; run `npm run typecheck` before finishing.

---

## 3. Architecture rules (hard-won — do not regress)

These caused real production outages. **Do not change them:**

1. **`@fastify/static` must use `wildcard: true`** (`src/app.ts`).
   With `wildcard: false` it globs files **once at boot**, so after a frontend
   rebuild every new hashed chunk **404s** and the app hangs on the splash screen.
2. **The SPA fallback must return a real 404 for asset paths.**
   In `setNotFoundHandler`, paths starting `/assets/` or ending in a file
   extension return **404** — never `index.html`. Serving HTML in place of JS
   breaks module parsing and freezes hydration.
3. **The service worker must NOT cache assets** (`public/sw.js`).
   Navigations are network-first; assets go straight to the network. A caching SW
   caused repeated "stuck on splash" bugs. Bump `VERSION` if you ever touch it.
4. **Node ≥ 22.22** — required by the React Router 8 build toolchain.
5. `index.html` + `sw.js` are served **no-cache**; `/assets/*` are immutable.

---

## 4. Design system — follow exactly

Full reference: **`design-palette.md`** in this repo. Summary:

### Colour
| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#fe6a02` | **Orange.** Buttons, active tabs, points chip, prices, links-as-actions |
| `--accent-600/700` | `#ea5f00` / `#c25000` | hover / dark-on-light text |
| `--accent-soft` | `#fff1e6` (light) / `rgba(254,106,2,.14)` (dark) | tinted backgrounds |
| `brand-*` (indigo→violet) | `#6366f1` … `#312e81` | **Bluish.** Dashboard hero gradient, soft chips |

**The split matters:**
- **Orange** = buttons, tabs, active states, prices, points chip.
- **Bluish/violet gradient** = the dashboard "points hero" card. **Keep it bluish** — do not make it orange.
- Logo orange is `#fb4c03` (icon assets only) — distinct from `--accent`.

### Surfaces (light + dark via CSS vars in `app.css`)
`--bg`, `--card`, `--card-border`, `--text`, `--text-muted` — auto-switch with `prefers-color-scheme`.

### Shell & chrome
- **Bottom nav:** 5 tabs — **Home · Rewards · Shop · Orders · Profile** (Shop is the middle tab).
  Dark bar `#14141c`, **white text**, rounded-3xl, with an **orange glow on the TOP edge only**.
  Active tab = small orange pill + white label.
- **Top bar:** Vivo mark + wordmark, orange points pill, wishlist heart, cart icon (with badges).
  Top padding is `calc(env(safe-area-inset-top) + 1.25rem)` — do not replace with `pt-*`.
- **PWA theme colour:** dark `#0a0a0f` (status bar). App icons come from `public/icons/vivo-icon.png`.

### Type & shape
- Font **Inter**. Cards `rounded-[1.75rem]`, controls `rounded-xl`/`rounded-2xl`.
- Product images are **9:16** with `object-top` (fashion crops).
- Glassmorphism: `backdrop-blur-xl` + `color-mix(in srgb, var(--bg) 80%, transparent)`.

---

## 5. Features (already built — extend, don't rewrite)

- **Auth:** Google OAuth + passwordless **email OTP** (with one-tap magic link). JWT in an httpOnly cookie.
- **Loyalty:** ledger-first points (`PointsTransaction` is the source of truth; the
  balance on `Customer` is a synced cache), tiers w/ multipliers, birthday/signup bonuses.
- **Rewards:** catalogue → redeem → generates a **real Shopify discount code**.
- **Referrals:** share code/link, invite by email; both sides earn.
- **Orders & returns:** live from the Shopify **Admin API**; expandable cards + detail page.
- **Shop:** curated collections (`SHOP_COLLECTIONS` env) in a hamburger drawer;
  product detail + **in-app cart** via the Shopify **Storefront API**; checkout hands off to Shopify.
- **Cart:** Storefront cart; its id is stored on `Customer.cartId` so the cart **follows the account across devices**.
- **Wishlist:** per-customer rows in Postgres → follows the account everywhere.
- **Admin:** `/admin` (role `ADMIN` via `ADMIN_EMAILS` env) — signups, active-now, installs,
  login counts, last login/seen in **EAT**, and per-user app-version (latest/old).
- **PWA:** installable; "Update available" banner when a newer build is detected.

---

## 6. Running it

```bash
npm run install:all     # install both workspaces
npm run db:deploy       # apply Prisma migrations
npm run db:seed         # seed tiers + rewards (first run only)
npm run dev             # Vite :5173 (HMR) proxying /api → Fastify :4001
```

**Production / Replit deploy:** `npm run setup` (install + build + migrate) then `npm start`
→ Fastify serves the SPA **and** the API on one port.

**Setup + secrets:** see **`REPLIT_SETUP.md`**.

---

## 7. Conventions

- Times shown to admins are **EAT (Africa/Nairobi)** — use `formatEAT()` in `lib/format.ts`.
- Money via `formatMoney()` (KES). Points via `formatPoints()`.
- API client is `lib/api.ts` — add endpoints there, typed; never call `fetch` from components.
- All shop/loyalty API routes require auth (cookie). Admin routes use `requireAdmin`.
- Prisma changes: edit `schema.prisma` → `npx prisma migrate dev --name <change>`.
- Never commit `.env`. Use **Replit Secrets**.
