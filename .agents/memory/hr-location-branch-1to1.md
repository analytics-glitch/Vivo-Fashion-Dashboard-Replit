---
name: HR attendance location vs branch filter
description: vivo-hr location filter is a 3-bucket super-group of branch; combining it with a specific branch can contradict and return zero rows.
---
In `vivo_attendance`, `location` is a coarse super-group with exactly 3 values — `HQ`, `Stores`, `Shopzetu` — and `branch_name` -> `location` is effectively 1:1 (HQ->HQ, "Shopzetu HQ"->Shopzetu, every retail store->Stores).

The vivo-hr frontend injects the active Location filter (often `Stores`) into EVERY `/api/hr/*` request. So drilling into a branch whose location isn't the active one (e.g. branch=HQ while location=Stores) ANDs two contradictory predicates and the endpoint returns `[]` ("HQ shows no data").

**Rule:** when a concrete `branch` is supplied, the `location` filter is redundant and must be dropped. This is handled centrally in `hr_attendance.py` `_filters()` (skip the location predicate when a non-"all" branch value is present). Don't reintroduce location+branch AND-ing in new endpoints.

**Why:** branch fully determines location, so location can only narrow to the same row set or to nothing — never usefully.
