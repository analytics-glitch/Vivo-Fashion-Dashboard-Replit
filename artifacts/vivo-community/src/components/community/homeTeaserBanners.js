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
    kicker: "Our Influencers",
    title: "Styled by Our Influencers",
    description: "Real looks from the creators who bring Vivo to life.",
    cta: "See their looks",
    disclosure: "In partnership with Vivo",
    alt: "Three Vivo creators in evening looks",
    image640: "home-teasers/curators-640.webp",
    image960: "home-teasers/curators-960.webp",
    objectPosition: "center 30%",
  },
  styleBoards: {
    kicker: "STYLE BOARDS",
    title: "Style Boards, Curated by Us",
    description: "Mood boards and outfit inspiration, put together by the Vivo team.",
    cta: "See the boards",
    alt: "Vivo woman in a monochrome editorial look seated in a rust armchair",
    image640: "home-teasers/style-boards-640.webp",
    image960: "home-teasers/style-boards-960.webp",
    objectPosition: "center 40%",
  },
  challenges: {
    kicker: "CHALLENGES",
    title: "Join a Challenge",
    description: "Style prompts, community missions, and rewards for taking part.",
    cta: "See the challenges",
    alt: "Vivo women sharing a style moment together",
    image640: "home-teasers/challenges-640.webp",
    image960: "home-teasers/challenges-960.webp",
    objectPosition: "center 48%",
  },
  news: {
    kicker: "Johari News",
    title: "This Month in Johari",
    description: "Milestones, new stores and what's next for Vivo.",
    cta: "Read the news",
    alt: "Vivo Johari monthly news feature",
    image640: "home-teasers/johari-news-640.webp",
    image960: "home-teasers/johari-news-960.webp",
    objectPosition: "center 34%",
  },
};