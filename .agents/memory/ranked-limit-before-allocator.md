---
name: Ranked LIMIT upstream of a fair-share allocator
description: Why a top-N cap before a shared-pool allocation step both hides rows and misallocates the pool.
---

**Rule:** never put a small ranked LIMIT (e.g. top-N by units sold) upstream of a step that allocates a shared pool (warehouse fair-share capping) across the returned rows. The cap must be a generous safety bound far above the realistic row universe, with a `truncated`/`row_cap` flag in the response when it is ever hit.

**Why:** the Store Gaps view once capped at 300 rows ranked by units sold across ~6k qualifying gaps — 90%+ of valid slower-selling gaps silently vanished from both UI and XLSX export, AND tiny warehouse pools were allocated to the wrong store because the allocator couldn't see the true top-selling competitors for a SKU.

**How to apply:** any endpoint that ranks + limits + then allocates/caps per group must run the allocation over the full qualifying set. If display volume is a concern, paginate client-side (or server-side) — never shrink the allocator's input. Exports must always request the maximum cap, independent of the display page size.
