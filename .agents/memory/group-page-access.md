---
name: Per-group page access (Group Access screen)
description: How admin-editable per-group page visibility resolves, and the default-map coupling between backend and frontend.
---

# Per-group page access

An admin "Group Access" screen lets an admin pick one of the department groups and tick which BI pages that group sees. Selections persist in `app_config` key `role_pages` (JSON `{role: [page_ids]}`) and drive nav, Home tiles and route guarding.

## How it resolves (the key mechanism)
- The frontend `canAccessPage` (permissions.js) already honors `user.allowed_pages` (an array) when present, and only falls back to the static `ROLE_PAGES` map when it's absent. Admin role short-circuits to full access before either check.
- So the whole feature works with **no client gating logic change**: the backend computes the effective page list for the user's group and injects `allowed_pages` into `/auth/me`, the login response, and `/auth/me/status`. Frontend `auth.jsx` sets the user straight from those responses, so it flows through automatically.
- Effective list = saved override for that group if present, else the built-in default. **Admin always resolves to the full catalog** regardless of any stored value (cannot be locked out); PUT for role `admin` is rejected 400.

## The coupling to watch
**Why:** the backend `DEFAULT_ROLE_PAGES` (in api_pg.py) is a hand-maintained mirror of the frontend `ROLE_PAGES` (permissions.js). For a group with no override they must agree, or behavior would differ depending on whether `allowed_pages` was sent.
**How to apply:** if you change a group's default pages in permissions.js, change `DEFAULT_ROLE_PAGES` in api_pg.py in lockstep (and vice-versa). New page ids must also be added to the backend `ALL_PAGE_IDS` catalog or PUT validation will silently strip them.

## Guard rails (enforced server-side, not just UI)
- Non-admin groups can never be assigned `admin-` prefixed pages — they're stripped on save (admin routes are `adminOnly` anyway). Unknown page ids are also stripped.
- Reset = `PUT {role, reset:true}` deletes that group's override key so it reverts to the built-in default (future default changes then propagate).
- The GET returns `{groups, defaults, overridden, labels, custom, page_catalog}` so the screen can render the checklist, show a "Customized" badge, and offer Reset.

## Custom groups (admin-created)
- Admins can create custom groups from the Group Access dropdown ("+ Create new group…"). Stored in `app_config` key `custom_groups` as `{slug: label}`; slug derived from the label, must start with a letter, collisions with built-ins/legacy slugs/labels → 409. Endpoints: `POST /api/admin/group-pages/groups`, `DELETE .../groups/{slug}` (400 for built-ins, 409 while users are still assigned).
- **Custom groups default to ZERO pages** (least privilege) — their effective list is only what the admin ticks. They flow through the same `allowed_pages` injection, so no client gating change.
- **Delete must drop the group's `role_pages` override BEFORE removing it from `custom_groups`** — the override reader filters unknown groups, so deleting the group first strands an orphan key that a same-name future group would silently inherit.
- **All group-config mutations (create/delete/PUT pages) serialize via a dedicated pg advisory lock** (`_groups_lock`, endpoint-level only — never inside helpers, or two pooled connections deadlock). Both app_config maps are whole-JSON read-modify-write, so unlocked concurrent admin edits lose updates.
- Role validation on user create/update uses `_is_valid_group` and must **store the lowercased role** — authz compares exact lowercase strings, so a stored "Admin" would silently lose privileges.
- Server-side role gates for data endpoints (crm/finance role lists) intentionally exclude custom groups — a custom group granted such a page sees empty data unless the gate is extended; the Group Access screen warns about this.
