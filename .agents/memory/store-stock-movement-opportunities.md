---
name: Store stock movement and colour opportunities
description: Business rules for daily transfer attribution and Store Stock Request colour suggestions.
---

Daily transfer attribution is destination-aware: Acacia, Kigali Heights, and The Oasis Mall retain the legacy warehouse-origin treatment. Other stores count only warehouse-origin movements classified as the warehouse-to-store dispatch leg, which represents Warehouse to Store In Transit.

**Why:** Most stores use a two-leg transit flow, so counting the later Transit to Store movement gives the wrong warehouse dispatch day. The three named stores must retain their established treatment.

**How to apply:** Keep Stock Movement aggregate, daily breakdown, drill-down, and exports on one shared predicate and transfer-day rule. Never count the transit-to-store leg for non-exception stores.

Store Stock Request colour opportunities are separate suggestions, not automatic demand. A candidate requires positive sales for the style in the selected period, sellable warehouse availability, and no evidence that the store previously held that colour/print. Prior evidence includes sales, current stock, or a completed receipt.

**Why:** A colourway can be a valid opportunity even when its exact SKUs have no store sales, but calling a previously held or sold colour “new” misleads staff.

**How to apply:** Group suggestions at style and colour/print, retain requestable SKU/size variants underneath, and enforce the existing warehouse-capacity validation when a suggestion is added to a request.