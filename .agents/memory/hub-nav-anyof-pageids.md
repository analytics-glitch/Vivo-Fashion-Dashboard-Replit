---
name: Merged hub nav needs OR-permission
description: When pages merge into a tabbed hub, nav/home visibility must OR over all tab pageIds, not just the hub's own id
---

Rule: when several standalone pages become tabs of one hub route, the route gate AND the nav/home tile must both accept ANY of the constituent pageIds (`anyOfPageIds`), and each tab is individually filtered with `canAccessPage`.

**Why:** roles like retail/store_manager hold only tab-level pageIds (e.g. `replenishments`, `store-flow`) without the hub id (`inventory`). Filtering nav by the hub id alone silently removes their only entry point even though the route's `anyOfPageIds` would let them in (caught by architect review during the Inventory Management / Production Pipeline merges).

**How to apply:** put `anyOfPageIds: [...]` on the nav item in `navItems.jsx`; `Sidebar.jsx` and `Home.jsx` filters honor it (`anyOfPageIds.some(canAccessPage)` else `t.id`). Keep old pageIds alive in permissions.js + api_pg.py mirrors so existing grants keep working; old routes redirect to `?tab=` deep links.
