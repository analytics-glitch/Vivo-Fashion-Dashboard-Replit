---
name: Product Workspace user privacy
description: Privacy boundary for workspace user profile fields and birthday reporting
---

`workspace_users.date_of_birth` is an admin-Settings-only field. Public identity/team responses and Meet the Team/profile payloads must omit the date entirely; the home birthday endpoint may return only the celebrant's name and role after comparing month and day server-side.

**Why:** A birthday banner needs the month/day signal, but exposing the stored date in a shared user/profile payload violates the workspace requirement that DOB remain visible only to the admin editing modal.

**How to apply:** Keep DOB conditional on an authenticated admin Settings response, never select or serialize it in public team/directory routes, and use a separate server-side month/day query for birthday banners.