// =============================================================================
// VIVO REELS — the in-app shelf for the short vertical videos the team already
// makes for TikTok / Instagram. Surfaces as "Fresh from Vivo" on the Home tab.
//
// HOW TO ADD A REAL REEL (marketing / admin — no code changes needed):
//   1. Host the video somewhere public. The same MP4 exported for TikTok/IG
//      works as-is (vertical 9:16, ideally under ~60s). A public object-storage
//      or CDN URL is perfect.
//   2. Paste that URL into `video_url` below — or add a new entry at the TOP
//      of the list (the row shows reels in array order, newest first).
//   3. Optional: `poster` = a public image URL (usually a video frame) shown
//      on the tile and while the player warms up. Leave null to keep the
//      house-style typographic tile.
//   4. Entries with `video_url: null` still render as styled teaser tiles and
//      open the player in "on its way" mode — nothing breaks while content
//      is being gathered.
//
// Field guide:
//   id        unique slug (used for like-tracking; don't reuse)
//   title     short serif headline on the tile + player
//   caption   one-liner under the player title (the TikTok caption works)
//   duration  display string like "0:27"
//   likes     seed count shown next to the heart (in-app likes add to it)
//   tone      tile style when there's no poster: "charcoal" | "cream" | "orange"
//             (use "orange" sparingly — one per row keeps it premium)
// =============================================================================

export const REELS = [
  {
    id: "reel-fitting-room",
    title: "POV: the fitting room said yes",
    caption: "When the wrap dress fits on the FIRST try.",
    duration: "0:22",
    likes: 214,
    tone: "charcoal",
    video_url: null,
    poster: null,
  },
  {
    id: "reel-kaftan-5-ways",
    title: "5 ways to wear one kaftan",
    caption: "Work, brunch, beach, dinner, repeat.",
    duration: "0:41",
    likes: 178,
    tone: "cream",
    video_url: null,
    poster: null,
  },
  {
    id: "reel-new-drop",
    title: "Sister, the DRAPE",
    caption: "New arrivals just landed and we're not okay.",
    duration: "0:19",
    likes: 342,
    tone: "orange",
    video_url: null,
    poster: null,
  },
  {
    id: "reel-behind-seams",
    title: "Behind the seams",
    caption: "A day on the Vivo production floor in Nairobi.",
    duration: "0:58",
    likes: 96,
    tone: "cream",
    video_url: null,
    poster: null,
  },
  {
    id: "reel-office-blazer",
    title: "One blazer, three personalities",
    caption: "Style It 3 Ways — office edition.",
    duration: "0:34",
    likes: 121,
    tone: "charcoal",
    video_url: null,
    poster: null,
  },
  {
    id: "reel-team-trend",
    title: "The team tries the trend",
    caption: "Head office attempts the viral sleeve tuck.",
    duration: "0:27",
    likes: 205,
    tone: "charcoal",
    video_url: null,
    poster: null,
  },
];
