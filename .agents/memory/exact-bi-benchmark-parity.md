---
name: Exact BI benchmark parity
description: How to prevent live ingestion from invalidating exact before-and-after endpoint comparisons.
---

Exact-output performance benchmarks must use an immutable historical period, a transactionally frozen database snapshot, or a captured source watermark that both runs can reproduce. Do not use the current live sales period for a hard byte-for-byte parity gate.

**Why:** The sales sync can add valid rows between baseline and candidate runs. That changes current-period customers, transactions, sales, and derived conversion even when the candidate SQL is semantically equivalent, forcing an inconclusive hard stop.

**How to apply:** Choose a closed historical window and confirm its source watermark is stable before the baseline. If current-period behavior must be covered, benchmark both implementations against the same database snapshot rather than sequentially against the live tables.