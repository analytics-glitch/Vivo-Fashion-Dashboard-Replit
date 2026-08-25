---
name: Product Workspace guidance
description: Durable cross-cutting rules for the standalone Product Workspace.
---

- EOS/L10 meeting data is owned by the Product Workspace; migrate legacy public records once, then workspace edits own future status.
- Reference-library content is idempotently seeded, server-admin-gated for edits, and rendered through safe structured tables.
- Startup readiness and identity bootstrap must continue if PostgreSQL is temporarily unavailable; optional DDL cannot block the app shell.
- Every style surface must server-scope to Vivo, Safari by Vivo, Safari, and Zoya. Development and assortment views each use their appropriate authoritative source rather than mixing product domains.
- Date of birth is Settings-admin-only: public team/birthday payloads must never include it.
- Embedded HTTPS previews require Secure/SameSite=None cookies; public feedback stores a canonical style number and colourway.

**Why:** The workspace shares users, product data, and deployment infrastructure with the BI environment, so accidental cross-brand data, private profile leakage, or a startup-time database wait is especially disruptive.

**How to apply:** When extending Product Workspace, retain the server-side brand/privacy gates and keep startup/preview behavior resilient before adding new page features.