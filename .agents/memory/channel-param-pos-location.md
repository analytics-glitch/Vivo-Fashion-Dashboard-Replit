---
name: "channel" filter param means pos_location_name, not all_sales.channel
description: Why endpoints must filter the global "channel" param against s.pos_location_name even though all_sales also has a separate s.channel column.
---

# The "channel" filter param maps to pos_location_name

`all_sales` has TWO columns that both look like "channel": `s.channel` and
`s.pos_location_name`. The global filter bar's **channel** param carries
`pos_location_name` *values* (e.g. "Vivo Sarit", "Online - Shop Zetu"), NOT
`all_sales.channel` values.

The canonical filter helpers (`build_filters`, `_country_channel_filter`) all
resolve channel as `s.pos_location_name IN (...)`. Any endpoint that instead
writes `s.channel IN (...)` for the channel param will silently return wrong or
empty results, because the param values don't exist in the `channel` column.

**Why:** the breakdown `DIM_REGISTRY` maps the "channel" *dimension* to
`s.channel` for its own grouping purposes, which makes `s.channel` look like the
right column. It is not the column the filter-bar channel param targets. This bit
the Phase 2 size endpoints (`/replenishment/size-breakdown`,
`replenish-by-color` size-mix), which were fixed to use `s.pos_location_name`.

**How to apply:** when filtering by the request's `channel` query param, always
use `s.pos_location_name IN (csv_to_sql(channel))`. Reserve `s.channel` only for
the DIM_REGISTRY breakdown grouping, never for the filter-bar channel param.
