---
name: Mobile Overview filter mapping
description: How the Expo Overview's segmented control and period deltas map onto the existing /api endpoints.
---

# Mobile Overview filter mapping

The Expo Overview reuses the same `/api` endpoints as the web dashboard. Two non-obvious mapping decisions:

## All / Retail / Online segmented control maps to `country`, not `channel`
The backend's `channel` query param filters on `pos_location_name` (the literal POS terminal names), so it cannot express the concept of "Retail vs Online". Instead the segmented control maps to the `country` param:
- All → `""`
- Retail → `"Kenya,Uganda,Rwanda"`
- Online → `"Online"`

**Why:** "Online" is modeled as a country/channel value in the sales data; physical-store countries are the retail bucket. There is no `pos_location_name` value that cleanly separates retail from online.

**How to apply:** If you add channel-style segments to mobile, route them through `country`, not `channel`. Endpoints that ignore `country` (e.g. footfall) won't honor the segment — check the per-endpoint filter contract first.

## Period deltas require two /api/kpis calls
`/api/kpis` has no built-in comparison field. The Overview's "vs <compare>" deltas are computed client-side by firing two calls — the current range and a shifted compare range (yesterday / last_month / last_year via `compareRange()` in `lib/api.ts`) — then `pctDelta = ((cur - prev) / prev) * 100`.

**Why:** Keeping the comparison client-side avoids changing the shared backend contract used by the web app.

**How to apply:** Any new compare period must be added to `COMPARES` + `compareRange()`; guard against `prev === 0` to avoid Infinity/NaN deltas.
