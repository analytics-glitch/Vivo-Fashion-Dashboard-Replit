export const MERCHANDISING_CATEGORIES = [
  'Tops',
  'Dresses',
  'Bottoms',
  'Outerwear',
  'Skirts',
  'Accessories',
  "Men's",
] as const;

export type MerchandisingCategory = typeof MERCHANDISING_CATEGORIES[number];

export const FISCAL_WEEKS_2026 = [
  { value: '2026-08-30', label: 'Wk 35 (Aug 24 – Aug 30) (Q3)' },
  { value: '2026-09-06', label: 'Wk 36 (Aug 31 – Sep 6) (Q3)' },
  { value: '2026-09-13', label: 'Wk 37 (Sep 7 – Sep 13) (Q3)' },
  { value: '2026-09-20', label: 'Wk 38 (Sep 14 – Sep 20) (Q3)' },
  { value: '2026-09-27', label: 'Wk 39 (Sep 21 – Sep 27) (Q3)' },
  { value: '2026-10-04', label: 'Wk 40 (Sep 28 – Oct 4) (Q4)' },
  { value: '2026-10-11', label: 'Wk 41 (Oct 5 – Oct 11) (Q4)' },
  { value: '2026-10-18', label: 'Wk 42 (Oct 12 – Oct 18) (Q4)' },
  { value: '2026-10-25', label: 'Wk 43 (Oct 19 – Oct 25) (Q4)' },
  { value: '2026-11-01', label: 'Wk 44 (Oct 26 – Nov 1) (Q4)' },
  { value: '2026-11-08', label: 'Wk 45 (Nov 2 – Nov 8) (Q4)' },
  { value: '2026-11-15', label: 'Wk 46 (Nov 9 – Nov 15) (Q4)' },
  { value: '2026-11-22', label: 'Wk 47 (Nov 16 – Nov 22) (Q4)' },
  { value: '2026-11-29', label: 'Wk 48 (Nov 23 – Nov 29) (Q4)' },
  { value: '2026-12-06', label: 'Wk 49 (Nov 30 – Dec 6) (Q4)' },
  { value: '2026-12-13', label: 'Wk 50 (Dec 7 – Dec 13) (Q4)' },
  { value: '2026-12-20', label: 'Wk 51 (Dec 14 – Dec 20) (Q4)' },
  { value: '2026-12-27', label: 'Wk 52 (Dec 21 – Dec 27) (Q4)' },
] as const;

export const MERCHANDISING_SUBCATEGORIES: Record<MerchandisingCategory, readonly string[]> = {
  Tops: [
    'Bodysuits',
    'Fitted Tops',
    'Kaftan Tops',
    'Loose & Oversized Tops',
    'Loose Tops',
    'Midriff & Crop Tops',
    'Relaxed Tops',
    'T-shirts & Tank Tops',
  ],
  Dresses: [
    'Kaftan Dresses',
    'Knee Length Dresses',
    'Maxi Dresses',
    'Midi & Capri Dresses',
    'Short & Mini Dresses',
  ],
  Bottoms: [
    'Culottes & Capri Pants',
    'Full Length Pants',
    'Jumpsuits & Playsuits',
    'Leggings',
    'Shorts & Skorts',
  ],
  Outerwear: [
    'Hoodies & Sweatshirts',
    'Jackets & Coats',
    'Sweaters & Ponchos',
    'Waterfalls & Kimonos',
  ],
  Skirts: [
    'Knee Length Skirts',
    'Maxi Skirts',
    'Midi & Capri Skirts',
    'Short & Mini Skirts',
  ],
  "Men's": ["Men's Tops", "Men's Bottoms", "Men's Outerwear"],
  Accessories: [
    'Accessories',
    'Bangles & Bracelets',
    'Belts',
    'Body Mists & Fragrances',
    'Earrings',
    'Necklaces',
    'Rings',
    'Scarves',
  ],
};

export function subcategoriesForCategory(category: string): readonly string[] {
  return MERCHANDISING_SUBCATEGORIES[category as MerchandisingCategory] || [];
}