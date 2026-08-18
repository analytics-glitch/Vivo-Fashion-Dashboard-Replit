---
name: Merch core empty-universe poison + deep-dive pct crash
description: Two failure modes behind "Style Deep Dive is broken" reports — an SWR-cached empty style universe and a render crash on styles with cost data.
---

**Rule 1:** The unfiltered `/api/merch/styles` universe can never legitimately be empty (~3.5k styles). Any cache layer over it (SWR core cache, single-flight, background refresh) must refuse to store an empty result — raise from the compute fn so *every* write site (sync + bg refresh) is covered, not just the read wrapper.
**Why:** A transient DB failure once computed `[]`, the SWR grace window kept re-serving it, and every merch surface (Deep Dive search dropdown showed "No matching styles") stayed blank until a process restart.
**How to apply:** Guard lives in `_fetch_styles_core_cached`'s compute closure. If a similar SWR cache is added for another "can't-be-empty" universe, use the same raise-inside-compute pattern.

**Rule 2:** "Page crashes when using the style search" reports can actually be a *selected-style render* crash, not the search itself. The Gross Margin Waterfall crash (`pct` not destructured in the price-ladder `.map`) only fired for styles WITH cost data, so it looked intermittent/search-related.
**How to apply:** When repro'ing "crashes while typing", drive the flow to an actual style selection (pick a style with cost data) and assert the error boundary is absent — page errors alone miss boundary-caught render crashes. E2E: `e2e/deepdive-search-repro.spec.js`; also note substring search means "maxi dress" matches but "dress maxi" doesn't.
