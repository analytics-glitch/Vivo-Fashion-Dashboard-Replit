---
name: Clerk dev SignIn blank in screenshot tool
description: Why Clerk's <SignIn>/<SignUp> shows a blank page in the app-preview screenshot tool even when it works for real users
---

When a Clerk **development** instance renders `<SignIn>` / `<SignUp>`, the app-preview
screenshot tool often captures only the surrounding page background (a blank card area)
even though Clerk loaded successfully and there are no JS errors.

**Why:** Clerk dev instances need a "dev browser" handshake (cookie/JWT sync via the
`*.accounts.dev` Frontend-API domain). The screenshot tool uses a fresh, ephemeral,
iframe-like browser session each capture, so the handshake + clerk-js's async mount of
the component into its portal node doesn't finish before the frame is captured. Waiting
10s+ does not reliably help.

**How to apply:** Do NOT conclude the auth UI is broken from a blank screenshot. Verify
it actually mounted via other signals:
- Console shows `Clerk: Clerk has been loaded with development keys` and NO errors.
- Once the form is in the DOM, the browser logs a `[DOM] Input elements should have
  autocomplete attributes (suggested: "current-password")` warning — that warning means
  Clerk's password input is rendered, i.e. the SignIn form mounted.
- `pnpm --filter @workspace/<app> run typecheck` is clean and the providers render
  (the page background paints).
Real users in the actual Replit preview pane (with a persistent cookie jar) see the form.
This mirrors the existing HMR fast-refresh screenshot ghost — trust console/DOM over a
transient screenshot.
