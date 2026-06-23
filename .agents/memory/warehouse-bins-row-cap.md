---
name: Warehouse bins sheet row cap
description: The warehouse barcode→bin Google Sheet has tens of thousands of rows; the sync must read the whole grid, not a fixed row cap.
---

The warehouse bin source (a native Google Sheet, "Bins" tab) is much larger than
it looks — tens of thousands of rows (grid capacity ~46k, ~37k populated), with
many duplicate rows per barcode (a barcode can list several bins across rows).

**Rule:** the bin sync must fetch the WHOLE grid. Resolve the tab's
`gridProperties.rowCount` and build the range from it (fallback to a generous
bound when unknown), never a hardcoded `A1:Z<N>` cap.

**Why:** the sync originally fetched `A1:Z20000`. Barcodes past row 20,000 were
silently dropped — e.g. 60066545 (bins K34/K38) lives at rows ~26222 and ~30977.
Symptom was "barcode X has a bin in the sheet but the app says no bin," and the
distinct-bin count was understated (5,491 vs 9,015 after the fix). The Sheets API
omits trailing empty rows, so a high upper bound returns only populated rows —
cheap and safe.

**How to apply:** any reader of a daily-maintained ops Google Sheet that can grow
unbounded should size its fetch range from the tab metadata, not a guessed cap.
Verify after a sync that the row/record count matches the sheet, not a round
number near the old cap.
