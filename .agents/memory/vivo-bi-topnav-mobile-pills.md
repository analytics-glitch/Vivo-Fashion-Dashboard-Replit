---
name: vivo-bi TopNav mobile pills
description: Top-bar status pills must self-hide on small screens or the whole page scrolls horizontally on phones; first suspect for mobile-width overflow.
---

# vivo-bi TopNav — mobile overflow rule

- Every status pill in the TopNav utility row (components/Sidebar.jsx) must hide on
  small screens: either its own `hidden lg:inline-flex` (the established pill pattern)
  or a `<span className="hidden md:contents">` wrapper around the component.
- The brand block must stay shrinkable (`min-w-0` + truncate, **no `shrink-0`**).

**Why:** the nav sits outside any horizontal scroll container, so an over-wide pill row
inflates `document.scrollWidth` and the entire page pans sideways on phones (~124px
overflow at 402px was caused by the LiveViewers avatar stack + Cache pill, the only two
without responsive hiding). Inner `overflow-x-auto` strips (hub tab bars) are fine and
are NOT the culprit for page-level overflow.

**How to apply:** when adding any new top-bar pill/control, give it responsive hiding
up front. When e2e reports mobile `scrollWidth > clientWidth`, inspect TopNav first,
not the page content.
