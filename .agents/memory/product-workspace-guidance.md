---
name: Product Workspace guidance
description: Durable cross-cutting rules for the standalone Product Workspace.
---

- EOS/L10 meeting data is owned by the Product Workspace; migrate legacy public records once, then workspace edits own future status.
- Reference-library content is idempotently seeded, server-admin-gated for edits, and rendered through safe structured tables.
- Startup readiness and identity bootstrap must continue if PostgreSQL is temporarily unavailable; optional DDL cannot block the app shell. Business-critical data migrations must run before the optional-migration queue in the degraded path.
- Every style surface must server-scope to Vivo, Safari by Vivo, Safari, and Zoya. Development and assortment views each use their appropriate authoritative source rather than mixing product domains.
- Date of birth is Settings-admin-only: public team/birthday payloads must never include it.
- Embedded HTTPS previews require Secure/SameSite=None cookies; public feedback stores a canonical style number and colourway.
- Once a Range Plan matrix replacement migration is marked complete, gate incompatible legacy row seeders before they insert. Keep later startup seeding non-destructive for editable plan assumptions and rows.
- Garment-unit metrics are discrete counts: display and headline totals use whole units, while genuinely averaged metrics may retain one decimal. Production-order source quantities can be fractional, so round only after aggregation and keep upstream fractional-row validation separate.
- Weekly Order Plan targets and counts come from workspace plan rows; BI/Odoo orders are optional actuals enrichment and must not prevent the saved plan from rendering.

**Why:** The workspace shares users, product data, and deployment infrastructure with the BI environment, so accidental cross-brand data, private profile leakage, or a startup-time database wait is especially disruptive. A migrated monthly matrix was once joined by retired template rows because the old generic seed ran before checking the completed-migration marker. The full schema initializer can exceed its readiness timeout while still applying DDL, leaving a new column present but its later seed migration unapplied if that migration only lives in the normal path or behind slow optional migrations. The Weekly Order Plan once returned 503 during a BI outage even though its saved target rows were healthy.

**How to apply:** When extending Product Workspace, retain the server-side brand/privacy gates and keep startup/preview behavior resilient before adding new page features. For Range Plan seed-shape changes, use a transactional one-time marker, gate old seeders before insertion, run critical lightweight migrations first in both normal and degraded startup paths, and verify row counts after a second restart. Render saved weekly targets with empty/stale actuals when the BI source is temporarily unavailable.