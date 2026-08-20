---
name: Immutable public media URLs
description: Safe cache-key rules for publicly served, replaceable image assets.
---

Public image responses marked `immutable` must accept only an exact, canonical,
positive generation identifier matching the currently stored asset version.
Reject missing, stale, malformed, and speculative generations instead of
silently serving the current bytes.

**Why:** A stable URL with year-long immutable caching can otherwise serve
different bytes after a replacement, so browsers or CDNs can retain prior
artwork or pre-cache incorrect future artwork.

**How to apply:** Whenever mutable public media receives long-lived caching,
issue its versioned URL from a public manifest, bump the stored version on each
replacement, and validate the requested generation before returning the bytes.