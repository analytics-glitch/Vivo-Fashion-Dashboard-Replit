---
name: Planning card image delivery
description: Performance rule for assortment and other large planning payloads that include product imagery.
---

Large planning endpoints should return a protected, cacheable image URL per style instead of embedding base64 image blobs in the main JSON response.

**Why:** A single planning response can contain thousands of styles. Joining and serializing image bytes inline makes the request slow, memory-heavy, and vulnerable to timeout during background database load.

**How to apply:** Keep the style payload lightweight, add an authenticated image route keyed by the canonical style number, and let cards load images lazily with a visual fallback.