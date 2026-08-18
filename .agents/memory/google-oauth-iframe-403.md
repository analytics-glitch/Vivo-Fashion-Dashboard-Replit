---
name: Google sign-in generic 403 inside preview iframe
description: Google refuses to render accounts.google.com in an iframe; login must break out to top window
---

# Google generic "403. That's an error / you do not have access to this page"

Symptom: clicking "Sign in with Google" inside the Replit workspace preview
pane (an embedded iframe) shows Google's bare 403 page. Server logs show the
`/api/auth/google/login` 307 fired normally — the block is Google refusing to
render its sign-in page in an iframe. Distinct from **org_internal** (that one
says "Access blocked… within its organization", see
google-oauth-org-internal.md).

**Fix:** the login handler detects `window.self !== window.top` and navigates
`window.top.location.href` (fallback `window.open(_blank)`) instead of the
iframe location. Implemented in vivo-bi Login.jsx `googleSignIn`.

**How to apply:** any new app with Google OAuth that can be used from the
workspace preview needs the same break-out; also valid user advice: open the
preview in a new tab.
