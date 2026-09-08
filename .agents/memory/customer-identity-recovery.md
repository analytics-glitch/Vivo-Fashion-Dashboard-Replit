---
name: Customer identity recovery
description: Durable handoff, source-scoped readiness, and cold-publication rules for customer feed recovery.
---

Customer profile ingestion must enqueue a store-qualified pending marker in the same transaction as its raw upsert. Consumers acknowledge only the exact queue version they processed, and only after canonical publication commits.

**Why:** Raw ingestion and canonical publication are separate transactions. Without a versioned pending handoff, a crash or concurrent re-enqueue can advance the source watermark while permanently losing the canonical update.

**How to apply:** Preserve partial profile fields, refresh facts by `(store_id, customer_id)`, replay pending markers after failures, and condition acknowledgements on their queue timestamp.

Recovery publication may enforce readiness on the sources being repaired while continuing to report unrelated legacy gaps and ambiguous matches.

**Why:** Longstanding unresolved records in an unrelated source must not prevent a recovered source with zero unmatched sales from publishing, but hiding those unrelated gaps would make the snapshot misleading.

**How to apply:** Keep global reconciliation in diagnostics; use source-scoped readiness only for an explicitly bounded recovery. Allocate first-time person IDs above the locked registry maximum in batches, then realign the backing sequence.