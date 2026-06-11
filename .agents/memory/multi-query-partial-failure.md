---
name: Multi-query partial-failure state
description: How to compose loading/error state across several parallel queries on one screen so partial API failures aren't hidden.
---

# Multi-query screens must not AND-compose error/loading state

When a screen fires several parallel queries (e.g. React Query) and derives one
page-level `loading`/`errored` flag, compose them with **OR**, not AND:

```ts
// WRONG — only triggers if EVERY query fails / is loading
const errored = aQ.isError && bQ.isError && cQ.isError;
// RIGHT — surfaces any required-query failure
const errored = aQ.isError || bQ.isError || cQ.isError;
```

Or render an explicit per-section loading/error/empty state for each query.

**Why:** AND-composition means one failing query while others succeed renders
partial data as if healthy — sections silently show zeroes/empties. For an
executive BI app that is misleading (looks like "real numbers"), which is worse
than an honest error. Caught in code review of the Vivo mobile screens.

**How to apply:** Any screen with 2+ queries feeding distinct sections. Either
gate the whole page on OR-of-required-queries, or give each section its own
`isLoading → isError → empty → data` ladder (preferred when sections are
independent, e.g. a secondary table under a primary KPI block).
