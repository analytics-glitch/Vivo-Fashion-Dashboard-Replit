---
name: Product Workspace preview auth
description: Session-cookie requirements for the Product Workspace when rendered inside the Replit HTTPS preview iframe.
---

The Product Workspace session cookie must be `Secure; SameSite=None` when the request arrives through an HTTPS preview proxy; direct local HTTP can use `SameSite=Lax`.

**Why:** The embedded Replit preview can accept the session bootstrap response but omit a Lax cookie on the following workspace API request, producing the generic “Could not open this room” state even though the API is healthy.

**How to apply:** Derive cookie attributes from `x-forwarded-proto`/HTTPS at session creation, restart the workspace API after changes, and verify the session-to-dashboard request sequence through the preview proxy.