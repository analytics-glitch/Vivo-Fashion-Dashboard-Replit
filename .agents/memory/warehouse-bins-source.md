---
name: Warehouse bins sheet source & tab selection
description: How the barcode->bin sync picks its Google Sheet worksheet, and the config trap around it.
---

The warehouse `barcode -> bin` mapping (`warehouse_bins.py`, joined by Replenishment/IBT) is mirrored from a Google Sheet whose tabs include per-country store data, NOT just bins. The bins live on a dedicated **"Bins"** worksheet — do not let the sync default to the first tab.

Tab selection priority (`_resolve_tab`): `WAREHOUSE_BINS_TAB` title → `WAREHOUSE_BINS_GID` (resolved to title via sheet metadata) → first tab. Prefer **gid** over title: the warehouse renames/reorders tabs, gid is stable and matches the `#gid=` in the URL they share. A set-but-unmatched gid raises (refresh→error, prior rows preserved) rather than silently reading the wrong tab.

**Why:** the source sheet has 5 tabs; first-tab default would silently sync a store tab as if it were bins.
**How to apply:** when the warehouse hands over a new bins link, set `WAREHOUSE_BINS_SHEET_ID` + `WAREHOUSE_BINS_GID` (both shared env) to the new id + the `#gid=` from the URL, then force a refresh and confirm `ok:<N>` with a sane nonzero count.

**Config trap:** a *secret* named `WAREHOUSE_BINS_SHEET_ID` also exists alongside the *shared env var* of the same name. The shared env var wins at dev runtime; standardize on one source and make sure prod has BOTH `WAREHOUSE_BINS_SHEET_ID` and `WAREHOUSE_BINS_GID` set together, or prod can drift to the old sheet / first tab.

Multiple bins per barcode (a barcode listed against several rows/bins) are aggregated by `_parse_rows` into a single comma-separated `wb.bin` value (distinct, first-seen order, cells also split on `,;\n`); the endpoints surface it as-is via `COALESCE(NULLIF(wb.bin,''), ss.bin, '')`.
