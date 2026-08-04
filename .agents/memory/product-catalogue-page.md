---
name: Product Catalogue page
description: Catalogue (ex-Gallery) page contract — launch-date fallback, cost exclusion, facet buckets, page id kept as "gallery".
---

## Rules

- **Page id stays `gallery`** (permissions, grants, redirects); only labels say "Product Catalogue". Renaming the id breaks existing role grants.
- **Launch date = COALESCE(catalogue column, first sale)**: `all_products_clean.style_launch_date` is TEXT and fully unpopulated (0 rows as of Aug 2026), so cards/popup fall back to MIN sale_date over the style+colour's sibling SKUs (`sale_kind IN ('sale','order')`). `launch_source` says which one won. If the column ever gets populated, the catalogue value automatically wins — keep that order.
- **Cost is deliberately EXCLUDED from the catalogue popup.** Costing data stays behind its allowlist-gated page; the catalogue is visible to viewer/retail roles. Never add cost/margin fields here without re-checking who can see the page.
- **Facet buckets:** blank category/product_type group as literal `'Uncategorised'` via `COALESCE(NULLIF(TRIM(col),''),'Uncategorised')` — the search filters understand the same bucket name, so both sides must keep the identical expression.
- **Popup price = modal (most common) across sizes, tie → lowest** — never MAX (foreign-currency leak duplicates KES prices as UGX/RWF).
- **Card/popup grain = style + colour**, expanded server-side via the same sibling helper the image endpoints use.

**Why:** user asked for a customer-facing-quality product catalogue with full attributes; these choices keep it consistent with the rest of the dashboard's canons (SOH 3-way split, modal price) while staying safe for broad roles.

**How to apply:** any new field on the catalogue card/popup goes through `/api/gallery/search` or `/api/gallery/style-card`; keep the run_query sanitised-literal pattern for filters (term strips quotes, category values `''`-escape).
