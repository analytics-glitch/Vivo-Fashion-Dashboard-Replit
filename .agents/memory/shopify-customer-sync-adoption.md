---
name: Shopify customer sync adoption
description: Bootstrap and supervision rules for market-specific Shopify customer profiles.
---

**Rule:** A Shopify customer source is not considered adopted merely because a sync-state row exists. Bootstrap remains incomplete until a successful run has reconciled the full existing raw market into the BI read model. Later runs may update changed IDs only.

**Why:** A failed first attempt still records its error state. Treating row existence as success lets the next retry advance incrementally while older raw profiles remain missing or stale indefinitely.

**How to apply:** Key adoption on a successful completion marker, preserve each market's watermark independently, and make the full transformer use the same complete profile projection as the incremental path.

**Rule:** A daemon worker's heartbeat must be monitored independently and must never substitute for the main sync heartbeat.

**Why:** A dead customer-profile thread can hide inside a healthy sync process, while letting its heartbeat drive main health would mask a stalled sales/inventory cycle.

**How to apply:** Beat at run start, page progress, and retry waits; monitor that dedicated heartbeat to restart the containing sync process when stale.