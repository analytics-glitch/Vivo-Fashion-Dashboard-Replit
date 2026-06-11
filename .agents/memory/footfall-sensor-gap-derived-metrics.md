---
name: footfall sensor-gap distorts derived per-visitor metrics
description: Why conversion / sales-per-visitor go absurd for stores whose footfall sensor was down, and how to gate them.
---

`/api/footfall` sums `total_sales` over ALL days in the window but `total_footfall` only over days the sensor reported. So any store with `sensor_gap_days > 0` has an **inflated** `sales/visitor` (sales numerator counts gap-day revenue the footfall denominator never saw), and conversion is computed on a smaller clean sample.

**Why it matters:** a store with the sensor down most of the period (e.g. The Oasis Mall, 26/30 gap days) shows nonsense like KES 20,000 sales/visitor and a high conversion — pure artifact, not performance. Plotting it on a quadrant or coloring it green in a heatmap actively lies.

**How to apply:** when building store-comparison visuals from footfall, treat conversion AND sales-per-visitor as **unreliable** when `sensor_gap_days >= ~25%` of the window (and always when footfall=0, e.g. Online channels). Drop those stores from a conversion scatter / mute (hatch) the cells in a heatmap rather than rendering a value. Use `clean_conversion_rate` (already excludes gap days) over `conversion_rate`. Basket/ABV stays reliable regardless (it's sales/orders, no footfall). Mirrors the existing low-volume rule (orders < 10 unreliable).
