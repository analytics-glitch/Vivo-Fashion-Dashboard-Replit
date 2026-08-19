/*
 * Home teaser image configuration.
 *
 * To refresh a banner photo without changing the Home layout:
 * 1. Upload/replace its 640px and 960px WebP files in
 *    public/assets/brand/home-teasers/.
 * 2. Update only the matching image filenames below if the names changed.
 *
 * The HomeTeaserBanner component consumes this shared shape for all four
 * banners, including responsive srcset and consistent image treatment.
 */
export const HOME_TEASER_BANNERS = {
  community: {
    kicker: "Vivo spotted",
    title: "Vivo Spotted on Our Community",
    description: "The looks, stories and conversations Vivo women are loving right now.",
    cta: "See the community",
    alt: "Two Vivo women wearing white against a green studio backdrop",
    image640: "home-teasers/community-640.webp",
    image960: "home-teasers/community-960.webp",
    objectPosition: "center 34%",
  },
  curators: {
    kicker: "Vivo Edits",
    title: "Curators",
    description: "Sharon, Phinie and Grace share the creator-curated looks shaping their wardrobes.",
    cta: "Explore Vivo Edits",
    alt: "Three Vivo creators in evening looks",
    image640: "home-teasers/curators-640.webp",
    image960: "home-teasers/curators-960.webp",
    objectPosition: "center 30%",
  },
  styleBoards: {
    kicker: "Get inspired",
    title: "Style Boards",
    description: "Mix, match and save your favourite pieces into moodboards for every occasion.",
    cta: "Create a Style Board",
    alt: "Vivo woman in a monochrome editorial look seated in a rust armchair",
    image640: "home-teasers/style-boards-640.webp",
    image960: "home-teasers/style-boards-960.webp",
    objectPosition: "center 40%",
  },
  news: {
    kicker: "Johari News",
    title: "This Month News",
    description: "Stories, style notes and community updates from Vivo Johari.",
    cta: "Read Johari News",
    alt: "Vivo Johari monthly news feature",
    image640: "home-teasers/johari-news-640.webp",
    image960: "home-teasers/johari-news-960.webp",
    objectPosition: "center 34%",
  },
};