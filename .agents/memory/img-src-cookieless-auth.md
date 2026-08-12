---
name: <img src> to gated /api endpoints fails without cookies
description: Direct <img> loads of auth-gated API images 401 in cookie-blocked contexts; use the Bearer blob fallback pattern.
---

**Rule:** A plain `<img src="/api/...">` authenticates ONLY via the httpOnly
session cookie — the Bearer token lives in localStorage and is attached by the
axios client, never by the browser's native image fetch.

**Why:** In cookie-blocked contexts (the Replit workspace preview iframe,
Safari third-party-cookie blocking) the cookie is absent even though the user
is signed in, so image requests 401 and the UI silently degrades to a
placeholder while everything else works.

**How to apply:** Serve gated images through a component that, on img error
for an API URL, retries once through the authenticated API client
(`responseType: "blob"`) and swaps in an object URL — with a bounded LRU cache
and a stale-resolution guard (list rows get reused). The vivo-bi
ProductThumbnail component carries the canonical implementation; new image
surfaces should reuse it rather than raw `<img>` tags.
