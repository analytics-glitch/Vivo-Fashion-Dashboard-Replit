// src/components/community/mockData.js
export const currentUser = {
  id: "u1",
  name: "Wanjiku M.",
  username: "wanjiku.m",
  initials: "WM",
  tier: "Tanzanite",
  points: 1250,
  joined: "April 2021",
  styleDNA: ["Bold & Polished", "Event-Ready", "Comfort-First"],
  quizCompleted: true,
  following: 42,
  orders: 15,
};

export const products = [
  { id: "p1", name: "Zawadi Wrap Dress", brand: "Vivo", price: 4500, liked: false },
  { id: "p2", name: "Nairobi Nights Co-ord Set", brand: "Safari", price: 6200, liked: true },
  { id: "p3", name: "Amani Flowy Maxi", brand: "Zoya", price: 5500, liked: false },
  { id: "p4", name: "Mara Print Kaftan", brand: "Safari", price: 3800, liked: false },
  { id: "p5", name: "Everyday Essential Denim", brand: "Vivo", price: 3200, liked: false },
  { id: "p6", name: "Lamu Sunset Gown", brand: "Zoya", price: 7800, liked: true },
];

export const challenges = [
  {
    id: "c1",
    title: "#MyVivoStory",
    description: "Share why your Vivo piece makes you feel good. Earn 50 points when your story is published — plus a chance to be This Week's Jewel.",
    deadline: "4 days left",
    points: 50,
    entries: 128,
    isFlagship: true,
  },
  {
    id: "c2",
    title: "Style It 3 Ways",
    description: "Show us how you style one piece for work, weekend, and evening. Earn 75 points when your entry goes live.",
    deadline: "2 days left",
    points: 75,
    entries: 45,
    isFlagship: false,
  },
];

export const posts = [
  {
    id: "post1",
    author: { username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false },
    caption: "This wrap dress makes me feel like royalty at every meeting! Paired it with some simple gold accessories. #MyVivoStory",
    likes: 42,
    comments: 8,
    taggedProducts: [products[0]],
    isLiked: false,
    time: "2h ago"
  },
  {
    id: "post2",
    author: { username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true },
    caption: "Weekend ready in the Mara Print Kaftan. So comfortable yet so chic. Perfect for brunch with the girls.",
    likes: 115,
    comments: 24,
    taggedProducts: [products[3]],
    isLiked: true,
    time: "5h ago"
  },
  {
    id: "post3",
    author: { username: "zawadi.t", initials: "ZT", tier: "Tsavorite", showTier: false },
    caption: "Finally found denim that fits my curves perfectly! Thank you Vivo ❤️",
    likes: 18,
    comments: 2,
    taggedProducts: [products[4]],
    isLiked: false,
    time: "1d ago"
  }
];

// `id` doubles as the stable image-slot key (community-board-<id>-tile-N) —
// keep ids unchanged when renaming titles or uploaded photos will detach.
export const styleBoards = [
  { id: "office-to-evening", title: "Office to Evening", items: 12, followers: "3.2k" },
  { id: "weekend-errands", title: "Weekend Errands", items: 8, followers: "1.9k" },
  { id: "vacation-ready", title: "Vacation Ready", items: 15, followers: "4.7k" },
  { id: "curvy-confident", title: "Curvy & Confident", items: 21, followers: "6.1k" },
  { id: "monochrome-magic", title: "Monochrome Magic", items: 9, followers: "2.4k" },
  { id: "print-mixing-101", title: "Print Mixing 101", items: 11, followers: "1.2k" },
];

// Privacy: leaderboard ranks by weekly contribution activity, never points
// balances; tier badges show only for members who opted in (showTier).
export const leaderboard = [
  { rank: 1, username: "nyambura.k", initials: "NK", tier: "Tanzanite", showTier: true, contributions: 23 },
  { rank: 2, username: "amina_h", initials: "AH", tier: "Ruby", showTier: false, contributions: 19 },
  { rank: 3, username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true, contributions: 16 },
  { rank: 4, username: "wanjiku.m", initials: "WM", tier: "Tanzanite", showTier: false, contributions: 12 },
  { rank: 5, username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false, contributions: 9 },
];
