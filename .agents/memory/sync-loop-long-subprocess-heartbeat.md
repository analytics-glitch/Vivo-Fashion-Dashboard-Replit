---
name: Sync-loop long subprocess must keep heartbeat alive
description: Heavy in-cycle extract subprocesses (image bootstraps) starve the sync heartbeat and get killed mid-run by the watchdog; single-commit crawls then never populate prod.
---

# Long in-cycle subprocesses must pulse the sync heartbeat

The incremental sync loop writes a `sync_heartbeat` row at each major step
(per-store, odoo, footfall, inventory, attendance) and a final `ok`. Between
the last per-step beat and the final `ok` there is a stretch with **no
heartbeat** where the heavy image-extract subprocesses run
(`extract_product_images.py`, `extract_shopify_images.py`).

**Rule:** any blocking subprocess launched from the sync cycle that can run
longer than the watchdog staleness window (`SYNC_FRESH_MIN`, ~15 min) MUST keep
the heartbeat fresh while it runs. Use `run_subprocess_with_heartbeat()` (pulses
`sync_heartbeat` from a daemon thread on its own short-lived psycopg2
connection), not a bare `subprocess.run`.

**Why:** a first-time bootstrap crawl of tens of thousands of SKUs exceeds the
staleness window. The watchdog treats the loop as stuck and `restart:sync` kills
the subprocess mid-run. `extract_shopify_images.py` does fetch-all-then
TRUNCATE+repopulate in a SINGLE commit at the very end, so a mid-crawl kill
commits nothing — prod's `product_image_urls` stays empty forever in an
unbreakable loop (it retries every cycle while empty, gets killed every time).
Prod health history confirmed the sync going 18–20 min stale then `restart:sync`
under heavy ops.

**How to apply:** when adding/relocating a slow subprocess into the sync cycle,
wrap it in `run_subprocess_with_heartbeat`. Do NOT share the caller's `conn`
across threads (not thread-safe) — the helper opens its own autocommit conn.

## Related: prod multi-image galleries depend on deployment secrets

The scrollable multi-image lightbox reads `product_image_urls` (Shopify Admin
API gallery). If prod shows only ONE image, the gallery table is empty and the
lightbox falls back to the single Odoo base64 photo (`product_images`). The
gallery bootstrap only runs when all six `SHOPIFY_*` store/token secrets are
present in the **deployment runtime** — workspace secrets do NOT automatically
guarantee deployment availability. Verify empty state with a read-only prod
query `SELECT COUNT(*) FROM product_image_urls`; fix = ensure the six secrets in
the published deployment + republish (the sync loop then bootstraps it).
