---
name: Community Find a Store
description: Store locator placement rules, static directory, placeholder contacts
---
- Find a Store is a deliberately SECONDARY service: only under Account/Help & Support (+ help landing) — never in bottom nav, homepage, shop nav, or checkout. PDP shows "check nearby stores" only when the item/size is out of stock, below the primary CTA.
- Data is a static frontend directory (`lib/storeDirectory.js`), not a backend table: canonical POS store list, approximate mall coords for distance sort, and PLACEHOLDER hours/phones (central care line) following the contactInfo.js placeholder convention — Vivo must confirm before launch.
- Geolocation is requested only on the explicit "Use My Location" tap; denied state must keep manual search working.
- delivery/returns page copy is placeholder policy (14-day window, 5–7 day refunds) — confirm with Vivo before publishing.
