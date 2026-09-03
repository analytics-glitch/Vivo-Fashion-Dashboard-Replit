---
name: Style Development board cards
description: Durable visual and field-visibility rules for the Style Development kanban cards.
---

Style Development board cards are garment-first rather than density-first: use a full-width portrait image at roughly 4:5, followed by a two-line left-aligned style name, a labelled style number, one compact timing line, and separate chips for pattern maker, type, tier, and status. Missing or failed images must become a plain neutral block without visible alt text or broken-image UI. Blocked and over-standard are icon markers, never text concatenated into another field. Supporting metadata visibility is user-customizable, but image, name, and style number remain the stable card identity.

**Why:** The design team explicitly prefers the clean, readable shape of its Airtable kanban and values seeing the garment over fitting more short rows into each column. Compact cards made images unusably small and caused independent metadata to run together.

**How to apply:** Keep columns about 260–300px wide with horizontal board scrolling and vertical scrolling inside columns. Preserve left alignment and generous whitespace. New card fields belong below the style identity, should default on only when broadly useful, and should be added to the existing card-field chooser rather than forced into every user's view.