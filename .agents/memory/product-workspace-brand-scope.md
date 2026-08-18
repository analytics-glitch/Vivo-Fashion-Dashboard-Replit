---
name: Product Workspace brand scope
description: The workspace's server-authoritative product universe is limited to four exact brands
---

Product Workspace style views and metrics must use the exact brand allowlist: Vivo, Safari by Vivo, Safari, and Zoya. Apply it in server SQL for both `pd_styles` and `all_products_clean`; do not rely on client-side filters.

**Why:** The workspace is a focused Vivo Fashion Group planning surface, and UI-only filtering allowed disallowed styles to leak through alternate routes such as feedback search, dashboards, and catalogue facets.

**How to apply:** Keep the shared predicate alongside existing PLM status or catalogue active/retired filters. Return the same four-brand list for brand dropdown facets, even if one approved brand has no current rows.