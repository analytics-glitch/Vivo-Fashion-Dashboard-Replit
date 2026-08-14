// =============================================================================
// VIVO NEWS — editorial stories for the "What's new at Vivo" section on the
// Home tab. Each story gets a card in the feed and a full article view at
// ?page=news-{id}.
//
// HOW TO ADD / EDIT A STORY (marketing / admin — no code changes needed):
//   1. Add an entry at the TOP of the list (cards show newest first).
//   2. `id` must be a unique slug — it becomes the article URL (?page=news-id).
//   3. `image`: paste a public photo URL (campaign shot, store photo) to use a
//      real image on the card + article. Leave null and the house-style
//      typographic cover below is used instead — both look at home in the feed.
//   4. `body` is an array of plain paragraphs; keep them short and warm.
//   5. `cover` styles the typographic fallback: tone "orange" | "charcoal" |
//      "cream", `mark` is the big serif word/figure, `sub` the small line
//      under it. Ignored when `image` is set.
// =============================================================================

export const NEWS = [
  {
    id: "vivo-turns-15",
    event_id: "fifteen-years-celebration",
    kicker: "Milestone",
    date: "May 2026",
    headline: "Fifteen years of Vivo — and this is just the beginning",
    teaser:
      "Since 2011 we've grown from one small Nairobi store into a family across East Africa. This May we celebrated fifteen years of dressing her boldly — thank you for every step.",
    image: null,
    cover: { tone: "orange", mark: "15", sub: "years of Vivo · 2011–2026" },
    body: [
      "In 2011, Vivo opened its doors with a simple belief: African women deserve fashion made for them — designed here, cut for real curves, and worn with pride.",
      "Fifteen years later, that one small store has grown into East Africa's leading womenswear brand, with stores across Kenya, Rwanda and Uganda, our own production floor in Nairobi, and collections designed in-house from first sketch to final stitch.",
      "In May we marked the milestone the only way we know how — with you. Celebrations ran across every store: anniversary looks, surprise treats for members, and more than a few happy tears from teammates who've been here since day one.",
      "To every woman who has worn Vivo to a boardroom, a wedding, a first date or an ordinary Tuesday — asante sana. You are the brand. Here's to the next fifteen.",
    ],
  },
  {
    id: "galleria-store",
    event_id: "galleria-styling-evening",
    kicker: "New Store",
    date: "August 2026",
    headline: "Karibu Galleria — our newest store is open",
    teaser:
      "Langata Road, we're home. Come find the full collection, fitting rooms made for taking your time, and a team that can't wait to meet you.",
    image: null,
    cover: { tone: "charcoal", mark: "Karibu", sub: "Now open · Galleria Mall" },
    body: [
      "The doors are open at Galleria Mall. Our newest store brings the full Vivo experience to Langata Road — new drops, member favourites and the pieces you've been eyeing online, all in one bright, easy space.",
      "Expect generous fitting rooms (bring the armful — we insist), stylists who genuinely love a challenge, and first looks at collections as they land.",
      "If you're nearby, come say hello. Mention your Community membership at the till and the team will make sure your points land where they belong.",
    ],
  },
  {
    id: "junction-tailoring",
    event_id: "junction-perfect-fit",
    kicker: "New Service",
    date: "July 2026",
    headline: "Made for you: tailoring arrives at The Junction",
    teaser:
      "A nip at the waist, a perfect hem — our new in-store tailoring service means your fit is exactly that: yours.",
    image: null,
    cover: { tone: "cream", mark: "Made for you", sub: "Tailoring · The Junction Mall" },
    body: [
      "Fit is everything. It's why our pieces are cut for real curves — and why we're now taking it one step further. Our store at The Junction Mall offers an in-house tailoring service.",
      "Buy a piece and have it adjusted to you: hems, waists, straps, sleeves. Small changes, big difference — and most adjustments are ready within days.",
      "It's fashion the way it should be: made for you, not the other way around. Ask the team at The Junction on your next visit.",
    ],
  },
  {
    id: "moi-avenue-refresh",
    event_id: "myvivostory-photo-afternoon",
    kicker: "Store News",
    date: "June 2026",
    headline: "Moi Avenue, but make it brand new",
    teaser:
      "Our city-centre classic just got a head-to-toe refresh — brighter, roomier, and even easier to shop.",
    image: null,
    cover: { tone: "charcoal", mark: "Refreshed", sub: "Moi Avenue · Nairobi CBD" },
    body: [
      "Moi Avenue is where so many Vivo stories start — a lunch-break browse that turns into a favourite dress. This season we gave the store the refresh it deserves.",
      "The new space is brighter and easier to move through, with a bigger fitting area, a dedicated new-arrivals corner and more room for the pieces you love most.",
      "Same heartbeat, same team you know by name — just with much better lighting. Next time you're in town, pass by and see her new look.",
    ],
  },
];

export const newsPageId = (id) => `news-${id}`;
export const isNewsPageId = (v) =>
  typeof v === "string" && v.startsWith("news-") && NEWS.some((n) => newsPageId(n.id) === v);
export const newsFromPageId = (v) => NEWS.find((n) => newsPageId(n.id) === v) || null;
