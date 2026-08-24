---
name: PD Flow stage persistence
description: Keep manually moved PD Flow styles from reverting when the API restarts or is republished.
---

# PD Flow stage persistence

**Rule:** Treat Excel/JSON imports as bootstrap data only. They may insert missing
PD styles and refresh non-lifecycle metadata, but must never overwrite the
`current_stage`, status, completion state, or stage-entered time of an existing
style. When repairing a prior overwrite, derive lifecycle state from each
style's latest append-only movement record; styles with no movement history keep
their imported initial state.

**Why:** An old Excel snapshot was reapplied during API boot, so a republish
silently put manually moved styles back into the snapshot's stages. The movement
log is the durable audit trail of the actual work, while the import is only a
historical starting point.

**How to apply:** Any future PD import must be insert-only for lifecycle fields.
If operational lifecycle state needs recovery in a new environment, reconcile
from the latest movement at startup and make the reconciliation idempotent.