---
name: Connectors proxy connector_names filter can return empty
description: Replit connectors proxy filtered query returned [] for a healthy connection; token helper must fall back to unfiltered list + client-side name match.
---

The connectors proxy (`https://$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection`) has been observed returning an EMPTY `items` list when queried with `connector_names=google-sheet` even though the unfiltered list shows that exact connection as `healthy` with a valid access token. This silently broke every Google-Sheet-backed feature at once (warehouse bins sync, HR roster, fabric audit log) with "no 'google-sheet' connection configured".

**Why:** The filter behavior changed/regressed platform-side; the connection itself was fine.

**How to apply:** `_connector_access_token` in `hr_attendance.py` (the shared token helper) now falls back to the unfiltered list and matches `connector_name` client-side when the filtered query returns nothing. Any new connector token helper must do the same. Diagnose by comparing filtered vs unfiltered proxy responses before assuming the connection is gone.
