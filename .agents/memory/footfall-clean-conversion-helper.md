---
name: Shared footfall clean-conversion helper
description: One backend helper is the sole source of per-store clean conversion; consumers join by store name; the Footfall page's pixels are a client-side variant.
---

Rule: any surface showing store conversion must consume the shared clean-conversion helper (the function the /api/footfall route wraps) — never re-derive it from raw footfall tables. Its contract: day-level footfall×sales join on canonical sensor names, distinct-transaction orders, sensor-gap days excluded from the clean rate, and the rate suppressed (None) when gap days exceed 25% of the window.

**Why:** multiple surfaces (Footfall page, Stock Movement's conversion column) display the same metric; the suppression rule is a business contract — an unreliable counter must show "—", never a plausible-looking fake rate — and independent derivations of footfall metrics have drifted before.

**How to apply:**
- Consumers join helper rows by store name; a canonical sensor name that stops matching a POS name silently degrades that store to "—" (the footfall feed has renamed stores before) — treat "reliable footfall store missing from a consumer" as a drift signal, not noise.
- The Footfall page table renders a client-side variant (authoritative order count ÷ footfall, same suppression flag) that can differ from the helper's clean rate by ≲0.1pp; parity checks must compare against the helper's clean rate, not page pixels.
- The helper copies rows before its suppression pass because the query layer returns cached rows by reference; keep that copy when editing it.
- Uganda stores have counters too — don't assume Kenya-only when sanity-checking country scopes.
- When direct-calling FastAPI route fns in verification scripts, pass every Query param explicitly (omitted params stay as truthy Query objects and break string ops).
