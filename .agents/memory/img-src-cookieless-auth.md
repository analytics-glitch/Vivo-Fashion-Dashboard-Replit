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

## Reload trap (found via Community App slot images e2e, fixed)
The axios GET wrapper used to cache blob responses like JSON: in-memory the
Blob worked, but the sessionStorage persistence layer JSON.stringifies cached
payloads, degrading a Blob to `{}`. After a reload within the 5-min TTL the
rehydrated `{}` made `URL.createObjectURL` throw inside fetchAuthedBlob, which
then memoized the URL in BLOB_FAILED for the whole session.
**Symptom signature:** authed image renders fine on first visit, reverts to
placeholder permanently after a reload, and the network/log trail shows ONLY
the native `<img>` 401 — the blob retry never hits the wire (served from the
poisoned cache).
**Guard:** the api.get wrapper now bypasses the response cache for any
non-JSON `responseType`; blob consumers (fetchAuthedBlob's object-URL LRU)
do their own caching. Keep that bypass if the cache layer is reworked.
