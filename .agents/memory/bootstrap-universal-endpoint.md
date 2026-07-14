---
name: /api/bootstrap universal lookups
description: One-TTL bootstrap endpoint rule — never a filter parameter
---
`GET /api/bootstrap` bundles ONLY truly-universal lookups (active locations, active POS channel+country, countries, allowed email domains) with one 3600s SWR-cached TTL story.

**Rule (user-mandated):** it must NEVER take a filter parameter. If data varies by anything the filter bar can set (country/channel/dates) or by who asks (role/identity), it does not belong here — add a separate endpoint. Identity stays on `/api/auth/me` (short-lived, coherent with group-access edits).

**Why:** mixed-TTL grab-bag endpoints degrade to the shortest-lived piece and identity data going stale is a security-relevant coherence bug; SWR softens the latency penalty but not coherence.

**How to apply:** the filter bar (`filters.jsx`) reads `active_pos` from `/bootstrap` (client axios layer dedupes + 5-min caches). Do not confuse with `/api/bootstrap/overview`, which is a FILTERED overview batch. Accepted nuance: SWR recompute may seal stale-in-grace sub-lookups for another hour (~2h worst case — immaterial for store-opens-timescale data).
