---
name: Two BI frontends — vivo-bi live, dashboard/ legacy
description: Which of the two React BI frontend copies is actually served in dev/prod, and the rules for payload renames and where UI work must land.
---

# Two BI frontends: artifacts/vivo-bi (LIVE) vs dashboard/ (legacy)

**Rule:** BI frontend work belongs in `artifacts/vivo-bi/src`. The near-duplicate tree in `dashboard/src` (CRA/craco) is a legacy copy: its `dashboard/build` is gitignored (never ships to prod — deployment postBuild is only `pnpm store prune`, it does NOT rebuild CRA) and the dev api-server SPA catch-all at the root path serves a months-stale build of it. Users see the vivo-bi artifact in dev (vite workflow) and the built vivo-bi artifact in prod.

**Why:** The two trees have silently diverged (e.g. sortable tables exist only in vivo-bi). At least one merged task landed a whole admin panel ONLY in `dashboard/src` — effectively invisible in every environment. And API payload-shape changes can break the stale compiled bundle: its interpolated labels read old keys.

**How to apply:**
- New pages/components/copy → `artifacts/vivo-bi/src`. Touch `dashboard/src` only for parity when it's nearly free.
- When renaming/removing a key in an API payload that any legacy `dashboard/` bundle interpolates, keep a legacy alias in the response (see marketing-candidates `threshold_pct`) or confirm the old bundle doesn't read it.
- Both trees have their own `permissions.js`; memory entries about ROLE_PAGES parity refer to whichever the live app uses — check `artifacts/vivo-bi/src/lib/permissions.js` first, and keep backend DEFAULT_ROLE_PAGES mirrored to the LIVE one.
- If a user reports a merged feature "missing", check whether it landed only in `dashboard/src`.
