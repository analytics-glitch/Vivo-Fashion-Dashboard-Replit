export const STYLE_LIBRARY_CATEGORIES = [
  "Tops",
  "Dresses",
  "Bottoms",
  "Outerwear",
  "Skirts",
  "Accessories",
  "Men's",
];

export const STYLE_LIBRARY_SUBCATEGORIES = {
  Tops: [
    "Bodysuits",
    "Fitted Tops",
    "Kaftan Tops",
    "Loose & Oversized Tops",
    "Loose Tops",
    "Midriff & Crop Tops",
    "Relaxed Tops",
    "T-shirts & Tank Tops",
  ],
  Dresses: [
    "Kaftan Dresses",
    "Knee Length Dresses",
    "Maxi Dresses",
    "Midi & Capri Dresses",
    "Short & Mini Dresses",
  ],
  Bottoms: [
    "Culottes & Capri Pants",
    "Full Length Pants",
    "Jumpsuits & Playsuits",
    "Leggings",
    "Shorts & Skorts",
  ],
  Outerwear: [
    "Hoodies & Sweatshirts",
    "Jackets & Coats",
    "Sweaters & Ponchos",
    "Waterfalls & Kimonos",
  ],
  Skirts: [
    "Knee Length Skirts",
    "Maxi Skirts",
    "Midi & Capri Skirts",
    "Short & Mini Skirts",
  ],
  "Men's": ["Men's Tops", "Men's Bottoms", "Men's Outerwear"],
  Accessories: [
    "Accessories",
    "Bangles & Bracelets",
    "Belts",
    "Body Mists & Fragrances",
    "Earrings",
    "Necklaces",
    "Rings",
    "Scarves",
  ],
};

export const subcategoriesForLibraryCategory = (category) =>
  STYLE_LIBRARY_SUBCATEGORIES[category] || [];