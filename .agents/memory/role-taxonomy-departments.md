---
name: Role taxonomy = 8 department groups
description: The app's user roles are business department groups, not technical roles; legacy codes are migrated on boot.
---

# Role taxonomy

User roles are **business department groups**, not the old technical roles. The
canonical set (api_pg.py `VALID_ROLES`, mirrored in vivo-bi
`src/lib/permissions.js` ROLE_OPTIONS):

`product_development, retail, warehouse, store_manager, leadership,
customer_service, marketing, admin`

**Why:** non-technical staff pick a role from the approval / create-user dropdown;
the old codes (viewer/analyst/exec/manager/hr) were meaningless to them.

**How to apply:**
- Retired codes are mapped on boot by `LEGACY_ROLE_MAP` (viewer→store_manager;
  analyst/exec/manager/hr→leadership) via the idempotent `_migrate_legacy_roles`
  startup hook. Any new role check must use the NEW codes — do not reintroduce
  viewer/analyst/exec/manager/hr in gates.
- Server-side gates (the real boundary; client nav is bypassable):
  - `/api/crm/*` → customer_service, marketing, leadership, admin
  - `/api/social/*` → marketing, leadership, admin
  - `/api/admin/*` → admin only
  - HR (`hr_attendance.py`): writers/global-view = admin + leadership (+ retail
    for global view); plain store_manager is branch-scoped read-only.
  - Standalone vivo-crm (`crm_clienteling.py`) mirrors the CRM allow-list.
- `DEFAULT_NEW_ROLE = "store_manager"` (lowest access) is the self-signup landing
  role; admin re-assigns at approval.
- admin = full access; last-admin guard is unchanged (see rbac-last-admin-toctou).
