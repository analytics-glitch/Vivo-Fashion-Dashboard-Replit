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
