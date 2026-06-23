---
name: Google OAuth org_internal block
description: Why a second company email domain can't Google-sign-in even though it's in the app allowlist
---

# Google sign-in "Error 403: org_internal" for a second domain

Symptom: a user on a SECOND allowed company domain (e.g. `@shopzetu.com`) gets
Google's "Access blocked: <app> can only be used within its organization",
**Error 403: org_internal**, and NO `app_users` row is ever created (Google blocks
them before our `/api/auth/google/callback` runs). Meanwhile every working Google
user is on the FIRST domain (`@vivofashiongroup.com`).

**Cause:** the Google Cloud OAuth **consent screen User type is "Internal"** —
restricted to a single Google Workspace organization. A different Workspace org
(shopzetu.com) is rejected by Google itself. Our app's `ALLOWED_DOMAINS`
allowlist (`clerk_auth.py`) is irrelevant to this — it only matters AFTER Google
calls us back, which never happens here.

**Fix (manual, Google Cloud Console — agent cannot do it):** OAuth consent screen
→ change User type Internal → **External** → **Publish** (status "In production").
We only request `openid email profile` (non-sensitive scopes), so **no Google
verification process is required**; redirect URIs / JS origins need no change.

**After the fix:** the second-domain user signs in → created `pending` → an admin
approves them on the Users page (they see "Awaiting Approval" until then).

**Why:** confirmed live deployment already returned both domains from
`/api/auth/allowed-domains`, so the block was provably Google-side, not code.
