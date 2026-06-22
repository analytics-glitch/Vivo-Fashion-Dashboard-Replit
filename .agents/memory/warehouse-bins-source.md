---
name: Warehouse bins sheet source & tab selection
description: How the barcode->bin sync picks its Google Sheet worksheet, and the config trap around it.
---

The warehouse `barcode -> bin` mapping (`warehouse_bins.py`, joined by Replenishment/IBT) is mirrored from a Google Sheet whose tabs include per-country store data, NOT just bins. The bins live on a dedicated **"Bins"** worksheet — do not let the sync default to the first tab.

Tab selection priority (`_resolve_tab`): `WAREHOUSE_BINS_TAB` title → `WAREHOUSE_BINS_GID` (resolved to title via sheet metadata) → first tab. Prefer **gid** over title: the warehouse renames/reorders tabs, gid is stable and matches the `#gid=` in the URL they share. A set-but-unmatched gid raises (refresh→error, prior rows preserved) rather than silently reading the wrong tab.

**Why:** the source sheet has 5 tabs; first-tab default would silently sync a store tab as if it were bins.
**How to apply:** when the warehouse hands over a new bins link, set `WAREHOUSE_BINS_SHEET_ID` + `WAREHOUSE_BINS_GID` (both shared env) to the new id + the `#gid=` from the URL, then force a refresh and confirm `ok:<N>` with a sane nonzero count.

**Config trap — prod needs a REPUBLISH to pick up changed `WAREHOUSE_BINS_*` shared env vars.** Symptom: dev `warehouse_bins` is correct (multi-bin barcodes → comma-joined `bin`) but prod has a *different row count* and ZERO commas with `warehouse_bins_meta.status='ok'`. "ok + wrong tab" (not an error) means prod's runtime `SHEET_GID` was EMPTY, so `_resolve_tab` fell back to the first tab (a per-store tab, one bin per barcode → no commas). A set-but-unmatched GID would instead make refresh→error and preserve prior rows. Diagnose by comparing dev vs prod with a read-only query: `SELECT count(*), count(*) FILTER (WHERE bin LIKE '%,%'), (SELECT refreshed_at/status FROM warehouse_bins_meta WHERE id=1) FROM warehouse_bins`.
Fix = make the shared env vars correct (`WAREHOUSE_BINS_SHEET_ID` + `WAREHOUSE_BINS_GID` together) then **republish** so the prod VM gets them; the bin table then re-extracts on the next staleness window. NOTE the staleness gate keys off `warehouse_bins_meta.refreshed_at` (default 6h via `WAREHOUSE_BINS_REFRESH_SEC`), NOT on VM restart — a republish alone won't re-extract until stale, so lower `WAREHOUSE_BINS_REFRESH_SEC` (e.g. 3600) if you need the correction to land promptly after publish.
Tooling caveat: in `viewEnvVars`, a `secrets:{KEY:true}` entry can simply MIRROR a same-named *shared env var* (no separate secret need exist); `deleteEnvVars({type:'secret'})` on such a key deletes the SHARED env var. If you must consolidate, re-`setEnvVars` the correct shared values afterward (sheet id + gid are non-sensitive — they appear in the share URL).

Multiple bins per barcode (a barcode listed against several rows/bins) are aggregated by `_parse_rows` into a single comma-separated `wb.bin` value (distinct, first-seen order, cells also split on `,;\n`); the endpoints surface it as-is via `COALESCE(NULLIF(wb.bin,''), ss.bin, '')`.
