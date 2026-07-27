---
name: 4-Point inspection score width
description: Which width feeds the fabric 4-Point pts/100 sq.yd score
---
The 4-Point inspection score width comes ONLY from the inspector's own ticket
measurements: `cuttable_width_cm` (priority, width_source='cuttable') else
`manual_width_cm` (width_source='manual'). The receiving sheet's
`width_measured_m` is displayed as reference on the ticket but must NEVER feed
the score.

**Why:** user explicitly reversed the earlier "sheet width is authoritative"
design (Jul 2026) — the inspection measures the roll independently; the ASTM
4-Point standard also scores on usable (cuttable) width.

**How to apply:** any change to `_insp_enforce_source_width`, the client
recalc in the inspection modal, or new score consumers must keep this order.
The one-time `insp_score_width_from_sheet_v1` migration predates this and is
historical only — do not re-run or imitate it. Per-yard cap: located defects
group by floor(location_yd), max 4 pts/yard (`_insp_total_points`).

## Extended 4-Point rules (ASTM alignment)
- Defect scoring lives in `_insp_defect_points` / `_insp_total_points` (server) mirrored by `inspDefectPoints`/recalc in the fabric dashboard — change BOTH or live score drifts from the saved one.
- Holes: ≤1" = 2 pts, >1" or unsized = 4 (conservative). Running defects: 4 pts × yards run (`_insp_run_span`), capped at inspected yards; they SATURATE each yard they cross w.r.t. the 4-pts/yard cap. Selvedge-flagged defects score 0 but stay on the ticket.
- Old submitted tickets keep stored scores — never rescore historic tickets when rules change.
- Lot (delivery average) acceptance: avg pts/100 sq.yd of latest Submitted ticket per roll per sheet (`_insp_lot_summaries`), limit = fabric_receiving_sheets.lot_acceptable_limit (NULL → 20). Surfaced on po-batches (lots_scored/lots_failed), po-batch-detail (sheet+group `lot`), and the approve-delivery response/audit.
