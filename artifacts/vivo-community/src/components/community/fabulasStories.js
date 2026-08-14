// #FabulasAtAnyAge — Vivo's real campaign with Fab-U-Las Living (a
// perimenopause & menopause platform): women over 50 telling their stories
// wearing Vivo. Editorial serif treatment, quote-led.
//
// IMAGE UPLOAD POINT: drop the real campaign photos into
//   artifacts/vivo-community/public/assets/fabulas/
// using the exact filenames below (fabulas-51.jpg … fabulas-64.jpg).
// Until a file exists, the app shows a warm tonal placeholder with the
// age + quote overlaid — nothing breaks while photos are pending.

export const FABULAS_SERIES = {
  hashtag: "#FabulasAtAnyAge",
  partner: "Fab-U-Las Living",
  header: "#FabulasAtAnyAge — celebrating the women who make Vivo",
  intro:
    "A Vivo campaign with Fab-U-Las Living, celebrating women over 50 telling their stories wearing Vivo — every chapter, every curve, every voice.",
};

const img = (file) => `${import.meta.env.BASE_URL}assets/fabulas/${file}`;

// Placeholder palettes rotate so the strip feels editorial even before the
// photography lands: warm terracotta, soft sage, dusty rose.
export const FABULAS_STORIES = [
  {
    id: "f51",
    age: 51,
    headline: "Fab-U-Las at 51",
    quote: "Happiness is a choice.",
    outfit: "Flowing black printed co-ord set",
    image: img("fabulas-51.jpg"),
    palette: "terracotta",
    body: [
      "At 51 I stopped waiting for permission to feel wonderful. Happiness is a choice — I make it every morning, somewhere between the first cup of tea and choosing what to wear.",
      "This co-ord moves the way I want my days to move: easy, deliberate, a little dramatic when the wind agrees.",
    ],
  },
  {
    id: "f53",
    age: 53,
    headline: "Fab-U-Las at 53",
    quote: "Inspire. Influence. Impact. Innovate.",
    outfit: "Red, black and white print off-shoulder maxi",
    image: img("fabulas-53.jpg"),
    palette: "rose",
    body: [
      "Four words carry me: inspire, influence, impact, innovate. At 53 I know exactly what I'm here to do — and I intend to be well dressed while doing it.",
      "An off-shoulder maxi in a print this bold isn't a risk. It's a statement of intent.",
    ],
  },
  {
    id: "f54",
    age: 54,
    headline: "Fab-U-Las at 54",
    quote: "Finding your V.O.I.C.E. — Vision, Opportunity, Identity, Calling, Experience.",
    outfit: "Navy, green and yellow print dress with a navy longline cardigan",
    image: img("fabulas-54.jpg"),
    palette: "sage",
    body: [
      "V.O.I.C.E. — Vision, Opportunity, Identity, Calling, Experience. It took me five decades to gather all five letters, and I wouldn't hand back a single year.",
      "I wore this print the day I finally said mine out loud.",
    ],
  },
  {
    id: "f55",
    age: 55,
    headline: "Fab-U-Las at 55",
    quote: "Passionate about Africa's potential, Women's value and Nature's abundance.",
    outfit: "Navy wrap dress with yellow floral print, gold cuff",
    image: img("fabulas-55.jpg"),
    palette: "terracotta",
    body: [
      "Three passions anchor me: Africa's potential, women's value, nature's abundance. At 55, I've learned they're the same story told three ways.",
      "A wrap dress that holds you well is like a conviction — you stand differently in it.",
    ],
  },
  {
    id: "f56",
    age: 56,
    headline: "Fab-U-Las at 56",
    quote: "Passionate about Africa Dressing Herself & Africa Dressing The World.",
    outfit: "Blue ikat-print longline kimono",
    image: img("fabulas-56.jpg"),
    palette: "sage",
    body: [
      "Africa dressing herself, then Africa dressing the world — that's the future I get dressed for every day.",
      "This ikat kimono goes where I go: boardrooms, markets, departure lounges. It has never once been the least interesting thing in the room.",
    ],
  },
  {
    id: "f62",
    age: 62,
    headline: "Fab-U-Las at 62",
    quote: "Choose love always.",
    outfit: "Blue and orange print trench over an orange dress",
    image: img("fabulas-62.jpg"),
    palette: "rose",
    body: [
      "Sixty-two years have taught me one instruction worth keeping: choose love. Always. For people, for yourself, for the life you actually have.",
      "Orange is love's colour, I think — this trench gets me stopped on the street by strangers who leave smiling.",
    ],
  },
  {
    id: "f64",
    age: 64,
    headline: "Fab-U-Las at 64",
    quote: "Navigate life's chapters with a compass of gratitude, and every step becomes a triumph.",
    outfit: "Emerald green print blouse with wide-leg trousers",
    image: img("fabulas-64.jpg"),
    palette: "terracotta",
    body: [
      "Gratitude is my compass. Point it at any chapter — the tender ones too — and every step turns into a triumph.",
      "At 64 I wear emerald green because subtlety is a choice, and some days I choose otherwise.",
    ],
  },
];

// Deterministic daily rotation for the Home feed slot — every member sees
// the same feature on the same day, and it moves through the whole series.
export function fabulasOfTheDay() {
  const day = Math.floor(Date.now() / 86400000);
  return FABULAS_STORIES[day % FABULAS_STORIES.length];
}
