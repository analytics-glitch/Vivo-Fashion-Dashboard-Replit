---
name: SKU-with-slash breaks image path-param routes
description: Why product-image endpoints 404 (showing the coloured-initials placeholder) for some products but not others.
---

Many catalog SKUs embed the size directly, and some sizes contain a slash:
`V1025018BLA1X/2X` (size `1X/2X`), `...M/L`, `...XS/S`. Single-size styles (`...CREAF`, size `F`) have no slash.

A FastAPI/Starlette route param `{sku}` compiles to regex `[^/]+`, which CANNOT match a `/`.
The frontend builds `/api/product-image/<quote(sku)>` → `%2F`; the ASGI server decodes `%2F`→`/`
before routing, so the slashed SKU becomes two path segments and the route fails to match → 404.
The gallery/thumbnail UIs treat 404 as "no image" and fall back to the coloured-initials placeholder.

**Symptom:** a product that DOES have stored images shows the placeholder, while visually-similar
products render fine — the difference is whether the chosen representative SKU contains a slash.

**Fix:** declare the param as `{sku:path}` on every SKU-keyed image route
(`/api/product-image/{sku:path}`, `/api/product-images/{sku:path}`). `:path` matches `/`.
These specific routes are registered well before the SPA catch-all, so no ordering conflict.

**Why it matters:** any future endpoint that takes a raw SKU as a URL path segment has the same
trap. Prefer `:path` for SKU path params, or pass the SKU as a query param instead.
