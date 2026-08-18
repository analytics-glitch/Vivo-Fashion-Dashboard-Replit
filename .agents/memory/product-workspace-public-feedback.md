---
name: Product Workspace public feedback
description: Source-of-truth and compatibility rules for the public /feedback capture flow.
---

The public feedback form is a linear, mobile-first capture flow. Style search and colourway options come from the allowed active/retired catalogue rows in `public.all_products_clean`, with product imagery resolved through `product_image_map` and `product_images`. Persist canonical `style_number` and `colourway`; keep the legacy sentiment and urgency fields as fixed compatibility values for the existing inbox.

**Why:** Feedback often refers to a colourway and may target a catalogue style that has no workspace `styles` row. A workspace-only foreign key or free-text fallback loses the product identity needed for reliable product decisions.

**How to apply:** Keep the public route open, enforce the allowed brand/status scope server-side, require a catalogue style selection, load colourways only after style selection, and preserve the existing confirmation state and reviewer payload shape. Product image columns may contain raw base64 (including `/9j/` JPEG values), so public image payloads must normalize them to data URIs before rendering.