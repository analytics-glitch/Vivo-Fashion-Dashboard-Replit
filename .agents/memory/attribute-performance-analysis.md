---
name: Attribute performance analysis
description: Durable rules for merchandising attribute comparisons and product-master attribute availability.
---

The attribute analysis must filter null, empty, and whitespace-only dimension values before grouping; it must never create an “Unknown” bucket. Aggregates stay at style grain and use weighted full-price/SOR calculations where row-level denominators are available.

**Why:** Product-master attributes are not uniformly populated, and treating missing values as a group makes comparisons look complete while mixing unlike data.

**How to apply:** When adding a dimension, expose its canonical product-master field through both merch style SQL paths and keep the UI’s included/excluded counts tied to the same populated-field predicate. If no authoritative source exists, leave the dimension explicitly unpopulated and track source mapping as follow-up work rather than guessing.

The fabric buying summary is always active-style-only, defaults to weighted Period SOR descending, and presents SOH, average WOC, weighted full-price share, revenue, and units; WOC below 8 weeks is amber and below 4 weeks is red.

**Why:** Buying decisions need a finished-goods view that is not diluted by retired styles, while low cover must be visible alongside strong sell-through.

**How to apply:** Keep the summary independent of the retired toggle and preserve sortable columns so buyers can switch from “buy more” signals to stock, revenue, or units without changing the populated-fabric universe.