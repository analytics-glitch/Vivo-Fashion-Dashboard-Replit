// src/components/community/mockData.js
export const currentUser = {
  id: "u1",
  name: "Wanjiku M.",
  username: "wanjiku.m",
  initials: "WM",
  tier: "Tanzanite",
  points: 1250,
  joined: "April 2021",
  styleDNA: ["Bold Prints", "Flowy Fits", "Earth Tones"],
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
    description: "Show us how you style one piece for work, weekend, and evening. The most versatile looks win — and you'll earn 75 points when your entry goes live.",
    deadline: "2 days left",
    points: 75,
    entries: 45,
    isFlagship: false,
  },
];

// Feed posts. `variant` varies the card layout so the feed doesn't repeat:
// "standard" 4:5 · "square" 1:1 · "landscape" 4:3 · "quote" (no image).
// `visual` picks the placeholder treatment: "light" (cream) | "dark" (charcoal).
export const posts = [
  {
    id: "post1",
    author: { username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false },
    caption: "This wrap dress makes me feel like royalty at every meeting. Paired it with some simple gold accessories. #MyVivoStory",
    likes: 42,
    comments: 8,
    taggedProducts: [products[0]],
    isLiked: false,
    time: "2h ago",
    variant: "standard",
    visual: "light",
  },
  {
    id: "post2",
    author: { username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true },
    caption: "Weekend ready in the Mara Print Kaftan. So comfortable yet so chic. Perfect for brunch with the girls.",
    likes: 115,
    comments: 24,
    taggedProducts: [products[3]],
    isLiked: true,
    time: "5h ago",
    variant: "standard",
    visual: "dark",
  },
  {
    id: "post3",
    author: { username: "zawadi.t", initials: "ZT", tier: "Tsavorite", showTier: false },
    caption: "Finally found denim that fits perfectly. Thank you Vivo.",
    likes: 18,
    comments: 2,
    taggedProducts: [products[4]],
    isLiked: false,
    time: "1d ago",
    variant: "square",
    visual: "light",
  },
  {
    id: "post4",
    author: { username: "amina_h", initials: "AH", tier: "Ruby", showTier: false },
    caption: "Bought my first Vivo piece for my graduation in 2019. Six years later, half my wardrobe is Vivo — and every piece has a story.",
    likes: 87,
    comments: 12,
    taggedProducts: [],
    isLiked: false,
    time: "8h ago",
    variant: "quote",
    visual: "light",
  },
  {
    id: "post5",
    author: { username: "njeri.styles", initials: "NS", tier: "Tsavorite", showTier: false },
    caption: "Print mixing scares people. Do it anyway.",
    likes: 64,
    comments: 9,
    taggedProducts: [products[3]],
    isLiked: false,
    time: "10h ago",
    variant: "square",
    visual: "dark",
  },
  {
    id: "post6",
    author: { username: "wambui_k", initials: "WK", tier: "Tanzanite", showTier: true },
    caption: "The new tailoring service at The Junction hemmed my jumpsuit while I had coffee upstairs. This is the future.",
    likes: 143,
    comments: 31,
    taggedProducts: [],
    isLiked: false,
    time: "14h ago",
    variant: "standard",
    visual: "light",
  },
  {
    id: "post7",
    author: { username: "fatuma.noor", initials: "FN", tier: "Ruby", showTier: false },
    caption: "Girls' trip to Diani officially sorted. Sun, sand and the Lamu Sunset Gown.",
    likes: 201,
    comments: 27,
    taggedProducts: [products[5]],
    isLiked: false,
    time: "1d ago",
    variant: "landscape",
    visual: "dark",
  },
  {
    id: "post8",
    author: { username: "kui_m", initials: "KM", tier: "Tsavorite", showTier: false },
    caption: "Office look of the day. The co-ord set does all the work — I just show up.",
    likes: 58,
    comments: 6,
    taggedProducts: [products[1]],
    isLiked: false,
    time: "1d ago",
    variant: "square",
    visual: "light",
  },
  {
    id: "post9",
    author: { username: "sanaa.j", initials: "SJ", tier: "Tanzanite", showTier: true },
    caption: "Vivo fit notes never lie. Ordered my usual size on members' advice and it fits like it was made for me.",
    likes: 76,
    comments: 10,
    taggedProducts: [],
    isLiked: false,
    time: "2d ago",
    variant: "quote",
    visual: "light",
  },
  {
    id: "post10",
    author: { username: "lydia.a", initials: "LA", tier: "Ruby", showTier: false },
    caption: "Date night in the Lamu Sunset Gown. He was speechless, I was comfortable. Everybody won.",
    likes: 167,
    comments: 22,
    taggedProducts: [products[5]],
    isLiked: false,
    time: "2d ago",
    variant: "standard",
    visual: "dark",
  },
  {
    id: "post11",
    author: { username: "muthoni.g", initials: "MG", tier: "Tsavorite", showTier: false },
    caption: "Saturday market run in my everyday denim — softest pair I own, and it goes with everything.",
    likes: 41,
    comments: 4,
    taggedProducts: [products[4]],
    isLiked: false,
    time: "3d ago",
    variant: "landscape",
    visual: "light",
  },
  {
    id: "post12",
    author: { username: "rehema.o", initials: "RO", tier: "Tanzanite", showTier: false },
    caption: "Turned forty this weekend and wore THE dress. Growing bolder, not older.",
    likes: 289,
    comments: 45,
    taggedProducts: [],
    isLiked: false,
    time: "3d ago",
    variant: "standard",
    visual: "light",
  },
];

export const styleBoards = [
  { title: "Office to Evening", items: 12, followers: "3.2k" },
  { title: "Weekend Errands", items: 8, followers: "1.9k" },
  { title: "Vacation Ready", items: 15, followers: "4.7k" },
  { title: "Curvy & Confident", items: 21, followers: "6.1k" },
  { title: "Monochrome Magic", items: 9, followers: "2.4k" },
  { title: "Print Mixing 101", items: 11, followers: "1.2k" },
];

// Privacy: leaderboard ranks by weekly contribution activity (posts, comments,
// challenge entries) — never by points balance. Tier shows only when the
// member opted in (showTier).
export const leaderboard = [
  { rank: 1, username: "nyambura.k", initials: "NK", tier: "Tanzanite", showTier: true, contributions: 23 },
  { rank: 2, username: "amina_h", initials: "AH", tier: "Ruby", showTier: false, contributions: 19 },
  { rank: 3, username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true, contributions: 16 },
  { rank: 4, username: "wanjiku.m", initials: "WM", tier: "Tanzanite", showTier: false, contributions: 12 },
  { rank: 5, username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false, contributions: 9 },
];
// ---------------------------------------------------------------------------
// Community fit notes (demo community layer — same as posts/challenges above).
// Deterministic per product so a PDP always shows the same profile.
// ---------------------------------------------------------------------------
export const fitProfiles = [
  { small: 11, true: 76, large: 13, verdict: "True to size" },
  { small: 33, true: 58, large: 9, verdict: "Runs small — size up" },
  { small: 7, true: 61, large: 32, verdict: "Runs generous" },
];

export const fitComments = [
  { username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false, size: "M", text: "Fits exactly like my usual M — the waist sits just right." },
  { username: "nyambura.k", initials: "NK", tier: "Tanzanite", showTier: true, size: "1X", text: "Ordered my usual size and it drapes beautifully through the hips." },
  { username: "wanjiru.m", initials: "WM", tier: "Tsavorite", showTier: false, size: "L", text: "A touch roomy through the bust for me, but I love the flow." },
  { username: "zawadi.t", initials: "ZT", tier: "Ruby", showTier: false, size: "2X", text: "True to size, and the fabric has a lovely weight to it." },
  { username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true, size: "S", text: "I sized up for a relaxed fit and it worked perfectly." },
];

export function fitFor(sku) {
  let h = 0;
  for (const ch of String(sku || "")) h = (h * 31 + ch.charCodeAt(0)) % 997;
  const profile = fitProfiles[h % fitProfiles.length];
  const comments = [0, 1, 2].map((i) => fitComments[(h + i * 2) % fitComments.length]);
  const seen = new Set();
  return {
    ...profile,
    comments: comments.filter((c) => !seen.has(c.username) && seen.add(c.username)),
  };
}
