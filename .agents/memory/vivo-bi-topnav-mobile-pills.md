---
name: vivo-bi mobile top-bar pills
description: Persistent TopNav and FilterBar pills must self-hide on small screens or the whole page scrolls horizontally on phones.
---

# vivo-bi persistent bars — mobile overflow rule

- Every status pill in persistent TopNav and FilterBar utility rows must hide on
  small screens: either its own `hidden lg:inline-flex` (the established pill pattern)
  or a `<span className="hidden md:contents">` wrapper around the component.
- The brand block must stay shrinkable (`min-w-0` + truncate, **no `shrink-0`**).

**Why:** these bars sit outside horizontal scroll containers, so an over-wide utility row
inflates the document width and makes the entire page pan sideways. Inner
`overflow-x-auto` strips are isolated and do not cause page-level overflow.

**How to apply:** when adding any new top-bar pill/control, give it responsive hiding
up front. When e2e reports mobile `scrollWidth > clientWidth`, inspect persistent
TopNav and FilterBar controls first, not the page content.
