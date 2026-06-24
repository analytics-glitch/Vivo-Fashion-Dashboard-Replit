---
name: Making a BI page truly admin-only (no bypass)
description: The four places that must change to restrict a vivo-bi page to admins only — removing it from a role group is NOT enough.
---

# Admin-only page gating (vivo-bi) — the full no-bypass recipe

To make an existing BI page (nav id `X`) visible to **admins only** with no
client- or server-side bypass, FOUR things must line up. Doing only one or two
leaves a hole.

1. **Remove `X` from every default role group** — `permissions.js` `ROLE_PAGES`
   (frontend) AND `api_pg.py` `DEFAULT_ROLE_PAGES` / `_LEADERSHIP_PAGES`
   (backend mirror). These two MUST stay mirrored.
2. **Keep `X` OUT of `api_pg.py` `ALL_PAGE_IDS`.** `_set_role_pages` only accepts
   page ids that are in `ALL_PAGE_IDS`, so leaving `X` out means an admin can
   NEVER grant it to a non-admin group via the Group Access override. Admins
   still reach it because admin's effective set is computed separately and the
   frontend short-circuits on `role==='admin'`.
3. **Add `X` to `ADMIN_ONLY_PAGES` in `permissions.js`** and hard-block it in
   `canAccessPage` *before* the `allowed_pages` check. **Why:** `canAccessPage`
   trusts `user.allowed_pages` ahead of the static role map, so a stale override
   already containing `X` would otherwise still show the nav/tile/route.
4. **Add a server-side role gate** in `clerk_auth_gate` for the page's API prefix
   (e.g. `if path.startswith("/api/finance") and role != "admin": 403`), the same
   way CRM/social/production/HR are gated. This is the real security boundary —
   data never leaks even if a UI gate is missed.

**The trap:** "remove it from the LEADERSHIP list" alone is NOT admin-only —
the page stays grantable (if it's in `ALL_PAGE_IDS`) and `canAccessPage` honours
`allowed_pages`, so a non-admin group could be handed it. Steps 2 + 3 close that.

**How to apply:** this is exactly how the Finance / P&L page (`finance`, a
work-in-progress surface) is restricted. A `wip: true` flag on the nav item drives
an amber "WIP" badge in Sidebar (desktop + mobile) and Home tiles.
