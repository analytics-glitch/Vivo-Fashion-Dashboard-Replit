---
name: Role taxonomy = 9 department groups
description: The app's user roles are business department groups, not technical roles; legacy codes are migrated on boot.
---

# Role taxonomy

User roles are **business department groups**, not the old technical roles. The
canonical set (api_pg.py `VALID_ROLES`, mirrored in vivo-bi
`src/lib/permissions.js` ROLE_OPTIONS):

`product_development, retail, warehouse, store_manager, leadership,
customer_service, marketing, hr, admin`

**Why:** non-technical staff pick a role from the approval / create-user dropdown;
the old codes (viewer/analyst/exec/manager) were meaningless to them. `hr` is now
a real, selectable department (HR page only), no longer a retired legacy code.

**How to apply:**
- Retired codes are mapped on boot by `LEGACY_ROLE_MAP` (viewer→store_manager;
  analyst/exec/manager→leadership) via the idempotent `_migrate_legacy_roles`
  startup hook. `hr` is NO LONGER in that map (it's canonical). Any new role check
  must use the NEW codes — do not reintroduce viewer/analyst/exec/manager in gates.
- Page access (frontend static map `ROLE_PAGES`): `feedback` is admin-only;
  `hr` role = `['hr']` only. Page hiding is cosmetic except the server-gated
  surfaces below.
- Server-side gates (the real boundary; client nav is bypassable):
  - `/api/crm/*` → customer_service, marketing, leadership, admin
  - `/api/social/*` → marketing, leadership, admin
  - `/api/admin/*` → admin only
  - `/api/hr` middleware gate → admin, leadership, store_manager, retail, hr
  - HR (`hr_attendance.py`): writers (`_WRITER_ROLES`) + global-view
    (`_GLOBAL_VIEW_ROLES`) = admin, leadership, hr (+ retail for global view);
    plain store_manager is branch-scoped read-only.
  - Standalone vivo-crm (`crm_clienteling.py`) mirrors the CRM allow-list.
- `DEFAULT_NEW_ROLE = "store_manager"` (lowest access) is the self-signup landing
  role; admin re-assigns at approval.
- admin = full access; last-admin guard is unchanged (see rbac-last-admin-toctou).
