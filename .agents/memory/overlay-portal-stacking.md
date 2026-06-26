---
name: Full-screen overlays must portal to body
description: Why ProductGallery/lightbox overlays render via createPortal(document.body) instead of inline
---

Full-screen `fixed inset-0 z-[...]` overlays (e.g. ProductGallery image lightbox) must be rendered via `createPortal(node, document.body)`, NOT inline in the component tree.

**Why:** When such an overlay is mounted inside a table cell (or any subtree under an ancestor with `transform`/`filter`/`backdrop-filter`/`will-change`/`contain`), the ancestor becomes the containing block for `position: fixed`, trapping the overlay in that ancestor's stacking context. Its high z-index (200) then no longer competes at the document root, so a `position: sticky` table header (z-20 in its own context) can paint ON TOP of the overlay. Symptom seen: clicking a product photo in the Product Analysis Styles table opened the gallery but the sticky column-header row showed over the image.

**How to apply:** Any new modal/lightbox/overlay that must cover the whole viewport should portal to `document.body`. This app is client-rendered Vite (no SSR), so direct `document.body` is safe; if SSR is ever added, guard with `typeof document !== 'undefined'`.
