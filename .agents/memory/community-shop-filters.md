---
name: Community Shop filters & sorting
description: Filter/sort contract for the community products endpoint + drawer UI
---
- The Style-DNA re-rank is a string replace on the DEFAULT order clause ("ORDER BY c.launch DESC NULLS LAST"); it must stay byte-stable and the quiz lookup is skipped entirely for explicit sorts (explicit sort wins, personalized:false).
- **Why:** a user who picks "price low to high" must get exactly that; re-ranking on top would silently lie.
- Shared products cache serves ONLY pristine requests (no filter params, no count_only, sort new/best; key includes sort). Any filtered request bypasses it — badges still stamped at response time.
- Colour filtering is server-side keyword BUCKETS over noisy color_print values (facets + WHERE share COMMUNITY_COLOR_BUCKETS); size filter = EXISTS over sibling SKUs with stock; price bands/sorts are allowlisted server constants — never interpolate client values.
- count_only=1 returns {total} off the same WHERE so the drawer's "Show N styles" can never disagree with the applied grid.
- Quiz size_range → concrete sizes map (incl. split sizes like 1X/2X) ships in the facets payload so the server owns that canon; "My size" chip just applies it.
- Restock alerts use canonical style+colour product identity plus an optional variant identity; active partial unique indexes deduplicate member and lowercased guest-email subscriptions independently.
- **Why:** a PDP can be opened through any sibling size SKU, so raw request SKUs cannot reliably identify a whole-product subscription.
- **How to apply:** email is deliverable through the shared retail SMTP sender. Keep push requests pending until the native consent flow gains server-addressable push-token registration; never mark that channel delivered from consent alone.
