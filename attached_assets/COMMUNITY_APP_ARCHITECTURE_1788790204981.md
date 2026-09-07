# Vivo Community — where the code lives, and who owns what

**Audience: whoever works in the Replit workspace, including the Replit Agent.**
Read this before changing anything under `artifacts/vivo-community/` or touching
`community_app.py`.

The app is built in two places on purpose. This document says which half is
yours, which half has moved, and the handful of rules that keep the two from
fighting each other.

---

## 1. The arrangement, in one paragraph

**Replit is where the frontend is written, run and previewed. Our own server
publishes everything.** When frontend work is pushed to GitHub, our server
checks out that exact commit, builds it, and serves it from
`community.vivofashionbrands.com` — the same domain that serves the API. The
backend no longer runs on Replit at all; it has moved to its own repository and
runs on our server beside its database.

Nothing about the way you edit, run or preview the frontend changes.

---

## 2. Source of truth

| Part | Repository | Path | Who writes it |
| --- | --- | --- | --- |
| **Frontend** | `analytics-glitch/Vivo-Fashion-Dashboard-Replit` | `artifacts/vivo-community/` | **Replit** |
| **Backend** | `analytics-glitch/vivo-community-api` | repo root | **Our server** |
| Database | — | Postgres on our server, 36 `community_*` tables | the backend |
| Built frontend | — | `/var/www/community/` on our server | the deploy script |

The frontend stays a member of this pnpm workspace. It is **not** being split
out: it depends on `catalog:` versions declared in the root
`pnpm-workspace.yaml`, and `.replit-artifact/artifact.toml` ties it to Replit's
artifact system. Extracting it would mean pinning those by hand forever.

Our server reads this repository with a **sparse, shallow checkout** —
`artifacts/vivo-community/` plus the workspace files, about 73 MB rather than
1.3 GB. It never pushes here. Replit remains the only writer.

---

## 3. What Replit owns

- Everything under `artifacts/vivo-community/` — screens, components, styles,
  assets, tests.
- Running the dev server and previewing.
- `pnpm test` and `pnpm typecheck` for the frontend.
- Pushing to `main` when those pass (§7).

---

## 4. What Replit must not do

**Do not add or edit backend routes in this repository.** `community_app.py` and
`community_app_images.py` have moved to `analytics-glitch/vivo-community-api`.
A route added here will never run in production and will be lost.

**Do not re-point the frontend at a Replit-hosted API.** Production is
same-origin by design (§5). Hard-coding an absolute URL, or reintroducing a
Replit backend, breaks that.

**Do not commit secrets to the frontend.** Vite inlines every `VITE_*` variable
into the built bundle, where it is publicly readable. An API origin is fine.
Nothing else is.

---

## 5. The frontend contract

### Production is same-origin — keep the relative paths

In production the browser talks to **one domain**. nginx serves the built
frontend at `/` and reverse-proxies `/api/community/*` to the backend on the
same host. That means the existing calls work untouched:

```js
fetch('/api/community/challenges')          // correct — leave as is
```

Do not replace these with absolute URLs. If an API origin is ever needed, it is
needed **for previews only**, and it must fall back to a relative path:

```js
const API = import.meta.env.VITE_API_BASE ?? '';   // '' in production
fetch(`${API}/api/community/challenges`);
```

**This applies to media as well as JSON.** `src/components/community/authImage.js`
fetches image bytes with the `Authorization` header and returns a blob URL,
because a native `<img>` cannot carry a header. Every one of those call sites
needs the same treatment as the JSON helper — missing them is the usual way a
split like this half-works.

### Build variables

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/vivo-community build
```

- **`BASE_PATH=/`** for production. It is `/app/` only while the app is served
  under a sub-path on Replit.
- **`PORT` is required even for a build.** `vite.config.ts` throws if it is
  unset, on a command that never listens on a port. Set it to anything valid.

The Replit plugins already look after themselves: `cartographer` and
`dev-banner` are gated on `NODE_ENV !== 'production' && REPL_ID`, so they
disable off-Replit. Only `runtime-error-modal` loads unconditionally, which is
harmless as long as it resolves.

### Authentication — Bearer, not cookies

Members authenticate with a Bearer token held in `localStorage`, checked against
`community_sessions` on the backend. There are no auth cookies anywhere in this
app. Keep it that way: cookies would make the preview path far harder and would
buy nothing.

---

## 6. Removing the backend from this workspace

**This step is required, and it is the one that causes real damage if skipped.**

`api_pg.py` currently mounts the community routes into the CRM app. If those
registrations stay while our server also serves `/api/community/*`, two
backends answer the same paths against **two different databases** — members
post to one and read from the other, and neither is wrong from its own point of
view.

Remove these lines from `api_pg.py`:

```python
41194  import community_app_images
41195  community_app_images.register_community_app_image_routes(app)
41201  community_app_images.seed_shop_card_defaults()
41284  import community_app
41285  community_app.register_community_routes(app, _sys.modules[__name__])
```

Then delete `community_app.py` and `community_app_images.py` from this
repository. The `/api/community/` bypass in `clerk_auth_gate` can stay — it is
inert once nothing is mounted behind it — but note it in the commit message so
the next reader knows why it is there.

**Do this only when told the cutover is happening.** Removing it early takes the
community app down; leaving it late causes the split-brain above.

---

## 7. Push on green

Push to `main` only when the frontend build, typecheck and tests pass. That
keeps broken work out of the shared history.

**It is not the deployment gate.** Our server re-runs the build and the checks
before it swaps anything live, because a push can also arrive from a merge, from
another machine, or from an edit made directly on the server. Your gate protects
the repository; ours protects customers. Both exist on purpose — do not assume
the other one will catch it.

---

## 8. What happens after you push

For context, so the two halves are predictable to each other:

```
push → GitHub → our server checks out that commit
              → pnpm build + typecheck + tests
              → releases/<sha>/
              → ln -sfn current   (one atomic operation)
              → nginx reload
```

The symlink swap means no visitor ever sees a half-updated build, and rolling
back is moving the symlink to the previous release — seconds, no rebuild. It is
static, so nothing restarts and there is no downtime.

The backend deploys separately from its own repository, and can restart without
touching the frontend.

---

## 9. Things that will bite

- **A deep link 404s on refresh.** Client-side routing needs an SPA fallback in
  nginx. That is our side; tell us if you see it rather than working around it
  in the app.
- **Preview URLs change between deployments,** so the API's CORS allowlist for
  previews goes stale and previews break while production stays fine. If
  previews suddenly cannot reach the API, that is almost always why.
- **`@assets` and `@workspace/api-client-react` are declared but never
  imported.** They resolve to a 504 MB directory and a workspace package
  respectively. If you start importing either, tell us — it changes what our
  server has to check out.
- **SMS is in demo mode.** The OTP is the fixed code `123456` and responses
  carry `{"demo": true}` until a provider is configured. Do not build anything
  that assumes a real code has been delivered.
- **`community_sessions` is a real table.** If it is ever cleared, every member
  is logged out. It is not a cache.

---

## 10. Quick reference

```
Frontend source     analytics-glitch/Vivo-Fashion-Dashboard-Replit
                    artifacts/vivo-community/          (pnpm workspace member)

Backend source      analytics-glitch/vivo-community-api
                    community_app.py · community_app_images.py

Production          https://community.vivofashionbrands.com
                      /                    → built frontend (static)
                      /api/community/*     → backend, same origin

Build               PORT=5173 BASE_PATH=/ pnpm --filter @workspace/vivo-community build
Auth                Bearer token in localStorage → community_sessions
CORS                previews only; production is same-origin
```
