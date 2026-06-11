---
name: Intraday "Projected Today" forecast
description: How the Overview end-of-day projection is computed (non-linear shape curve + AI blend) and why an empirical curve isn't possible.
---

# Overview "Projected Today" end-of-day projection

The live end-of-day projection (shown only when the date filter = today, Africa/Nairobi) is **non-linear** and **AI-assisted**.

## Method
1. **Intraday shape curve** (client, `Overview.jsx` `INTRADAY_CURVE` + `curveFraction`): a fixed cumulative-revenue-by-clock-hour curve for the 9:00 AM–8:30 PM trading window (slow morning, midday bump, strong afternoon/evening). `curveProjected = todayRev / fractionCompletedByNow`. This replaces the old linear `todayRev / clockElapsed`, which over-counts mid-day because clock time ≠ revenue progress.
2. Regularize toward the same-DOW average early in the day: `projected = w*curveProjected + (1-w)*dowRef`, `w = shapeFraction` (trust today's actual more as the day fills).
3. **AI blend**: client POSTs the deterministic features to `POST /api/analytics/projection-ai`; backend `_projection_ai_core` runs `_chat_llm` (reuses the OpenAI AI integration) → strict JSON `{projected, low, high, confidence, rationale}`, validated + clamped (`>= so_far`, ceiling cap). Final = `wAi*ai + (1-wAi)*deterministic`, `wAi` from AI confidence. AI calls throttled to 5-min buckets; result tagged with its bucket so a stale estimate is never blended into a later window, and cleared on error/unavailable (deterministic fallback).

## Why no empirical intraday curve
**Why:** `all_sales` has only `sale_date` (TEXT, date-only) — no per-order time-of-day. `loaded_at` reflects sync **batch** times (today often loads in a single batch), not when sales happened, so you CANNOT reconstruct historical "what a past Thursday looked like at 2:45 PM". The intraday shape must be a model/assumption (the fixed curve) or supplied by the LLM, not derived from sale timestamps.
**How to apply:** If asked to make the curve data-driven, you'd need to persist periodic intraday snapshots (timestamp, cumulative today-revenue) going forward and build an empirical per-DOW curve over time — a new snapshot table, not derivable from current data.
