---
name: Community Virtual Try-On architecture
description: Invariants of the vivo-community Virtual Try-On feature (photos, looks, allowance, worker thread, privacy gates).
---

Rules that must survive future edits:

- **Worker never holds a pool connection during generation.** `_tryon_worker` (daemon thread): borrow conn → read inputs → RELEASE → call `_generate_tryon` (~10s+) → borrow again → write. Re-coupling these starves the shared api_pg pool.
- **`_generate_tryon` is the single AI point.** Demo mode (PIL composite, labeled) when Gemini env is missing or `TRYON_DEMO_MODE=1`; swap providers only inside this function.
- **Allowance:** weekly by tier — Tsavorite 3 / Ruby 5 / Tanzanite 10; week boundary = `date_trunc('week', now() AT TIME ZONE 'Africa/Nairobi')`; `failed` looks never count; look creation AND the 12-photo cap check are serialized by `SELECT … FOR UPDATE` on the member row (unlocked count+insert was raceable; one `pending` at a time → 409). Stale pending healed to failed after 5 min.
  - The user refers to the top tier as "Diamond" — it is **Tanzanite** in the real ladder; don't invent a 4th tier.
- **Privacy gates:** photos owner-only; look images owner-or-`is_shared`; shared feed exposes username only (never phone/full name). Photos & mockups private by default; sharing is explicit opt-in per look.
- **Member-gated images in the frontend** cannot use plain `<img src>` (Bearer token in localStorage) — `authImage.js` fetches with the header into a session-lived blob-URL cache; delete flows must call `dropAuthImage`.
- **Copy is spec-fixed** (framing line, photo-privacy line) — marked in TryOnView.jsx; never claim accurate fit.
- Consent/terms version lockstep moved to 0.9.5 (backend constant + published set + legalData LEGAL_META) when the try-on privacy bullet was added.
- Prod note: published deployment needs the `AI_INTEGRATIONS_GEMINI_*` secrets in its deployment env (Republish after provisioning) or the feature runs in labeled demo mode.

**Why:** the pool-starvation and privacy rules are invisible in a quick read of any single route; the tier alias caused naming confusion in the original request.
