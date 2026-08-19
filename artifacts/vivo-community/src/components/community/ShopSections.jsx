import React, { useState } from "react";
import { Heart, ShoppingBag, ChevronRight } from "lucide-react";
import { ImagePlaceholder, MerchBadge, kes, brandAsset, SectionHeader } from "./ui";
import { useWishlist } from "@/context/WishlistContext";
import { QuickAddModal } from "./QuickAddModal";

/* Shared image-led shop sections — the product rail and the "Shop by
   Category" editorial grid. All live on the Shop tab now, including the
   "New This Week" rail (moved off the homepage per Sharon). */

const SWATCH_HEX = {
  black: "#1f1f1f", white: "#f5f5f2", cream: "#efe7d8", beige: "#d9c7ab", brown: "#7a5236",
  tan: "#c8a06a", navy: "#22304d", blue: "#3f6ab5", "light blue": "#a9c6e8", green: "#3f6d4e",
  olive: "#6b6b3a", yellow: "#e5c33c", mustard: "#d0a12c", orange: "#e0662a", red: "#b03030",
  maroon: "#6e2432", burgundy: "#6e2432", wine: "#5d1f30", pink: "#e2a3b6", purple: "#7757a8",
  lilac: "#b9a3d6", grey: "#9a9a9a", gray: "#9a9a9a", multi: "#c9a0e0",
};
const swatchFor = (color) => {
  const c = String(color || "").toLowerCase();
  for (const [name, hex] of Object.entries(SWATCH_HEX)) if (c.includes(name)) return hex;
  return "";
};

/* Product rail card — image-led with wishlist heart, colour swatch and a
   quick-add affordance. Tapping the bag icon opens the lightweight size
   picker overlay so she can add to bag without leaving the rail. */
export function RailCard({ p, onOpenProduct, idPrefix = "rail" }) {
  const { has, toggle } = useWishlist();
  const saved = has(p.sku);
  const [imgOk, setImgOk] = useState(true);
  const [quickAdd, setQuickAdd] = useState(false);
  const hex = swatchFor(p.color);
  return (
    <div className="w-[170px] sm:w-[200px] shrink-0 snap-start relative group">
      <button
        data-testid={`${idPrefix}-card-${p.sku}`}
        onClick={() => onOpenProduct?.(p.sku)}
        className="w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="relative aspect-[3/4] rounded overflow-hidden bg-secondary mb-2.5">
          {imgOk ? (
            <img
              src={p.image_url}
              alt={p.style_name}
              loading="lazy"
              onError={() => setImgOk(false)}
              className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-[1.02]"
            />
          ) : (
            <ImagePlaceholder aspectRatio="h-full" text={p.style_name} className="rounded-none border-none" />
          )}
          <MerchBadge badge={p.badge} testId={`${idPrefix}-badge-${p.sku}`} className="absolute bottom-2 left-2" />
        </div>
        <div className="font-serif text-[13px] leading-snug text-foreground line-clamp-2 mb-1">{p.style_name}</div>
        <div className="flex items-center gap-2 mb-0.5">
          {p.color && (
            <span className="flex items-center gap-1.5 min-w-0">
              {hex && <span className="w-3 h-3 rounded-full border border-border shrink-0" style={{ background: hex }} aria-hidden="true" />}
              <span className="text-[11px] text-muted-foreground truncate">{p.color}</span>
            </span>
          )}
        </div>
        <div className="text-[13px] font-medium text-foreground">{kes(p.price)}</div>
      </button>
      <div className="absolute top-2 right-2 flex flex-col gap-1.5">
        <button
          data-testid={`${idPrefix}-wish-${p.sku}`}
          aria-label={saved ? `Remove ${p.style_name} from wishlist` : `Add ${p.style_name} to wishlist`}
          aria-pressed={saved}
          onClick={() => toggle({ sku: p.sku, name: p.style_name, price: p.price, image: p.image_url, color: p.color || "", category: p.category || "" })}
          className="w-9 h-9 rounded-full bg-background/85 backdrop-blur flex items-center justify-center text-foreground hover:bg-background transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Heart size={15} strokeWidth={1.5} className={saved ? "fill-primary text-primary-ink" : ""} />
        </button>
        <button
          data-testid={`${idPrefix}-quickadd-${p.sku}`}
          aria-label={`Quick add ${p.style_name}`}
          onClick={(e) => { e.stopPropagation(); setQuickAdd(true); }}
          className="w-9 h-9 rounded-full bg-background/85 backdrop-blur flex items-center justify-center text-foreground hover:bg-background transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ShoppingBag size={14} strokeWidth={1.5} />
        </button>
      </div>
      {quickAdd && (
        <QuickAddModal
          sku={p.sku}
          productName={p.style_name}
          productImage={p.image_url}
          productPrice={p.price}
          onClose={() => setQuickAdd(false)}
          onOpenProduct={onOpenProduct}
        />
      )}
    </div>
  );
}

export function ProductRail({ kicker, title, sub, products, onOpenProduct, onSeeAll, testId, idPrefix }) {
  const items = (products || []).slice(0, 10);
  if (!items.length) return null;
  return (
    <section data-testid={testId}>
      <SectionHeader kicker={kicker} title={title} sub={sub} action={onSeeAll ? "Shop all" : undefined} onAction={onSeeAll} actionTestId={`${idPrefix}-see-all`} />
      <div className="flex gap-3 overflow-x-auto hide-scrollbar snap-x -mx-4 px-4 sm:mx-0 sm:px-0 pb-1">
        {items.map((p) => <RailCard key={p.sku} p={p} onOpenProduct={onOpenProduct} idPrefix={idPrefix} />)}
      </div>
    </section>
  );
}

/* Shared delivery promotion — used on Shop and as the Home discovery lead-in.
   Keep the content and art direction in one place so both surfaces stay
   visually identical. */
const SHOP_PROMO = {
  kicker: "For a limited time",
  title: "Free delivery over KES 5,000",
  sub: "Nairobi, Kigali and Kampala — straight to your door.",
  image: "promo.jpg",
};

export function PromoBanner() {
  return (
    <section data-testid="shop-promo-banner" className="-mx-4 sm:mx-0 relative overflow-hidden sm:rounded bg-foreground mb-10">
      <img
        src={brandAsset(SHOP_PROMO.image)}
        alt=""
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover object-[center_30%] opacity-80"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/45 to-black/20 pointer-events-none" />
      <div className="relative p-6 sm:p-8 max-w-md text-white">
        <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/75 mb-2">{SHOP_PROMO.kicker}</div>
        <h3 className="font-serif text-2xl sm:text-3xl leading-tight mb-1.5 text-white">{SHOP_PROMO.title}</h3>
        <p className="text-[13px] text-white/85">{SHOP_PROMO.sub}</p>
      </div>
    </section>
  );
}

export function GenderToggle({ activeGender = "women", onChange }) {
  const tabs = [
    { id: "women", label: "Women's" },
    { id: "all", label: "All" },
    { id: "men", label: "Men's" },
  ];
  return (
    <div className="flex items-center justify-center mb-4" data-testid="shop-gender-toggle">
      <div className="inline-flex rounded-sm border border-border overflow-hidden">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            data-testid={`shop-gender-${id}`}
            aria-pressed={activeGender === id}
            onClick={() => onChange?.(id)}
            className={`px-5 h-9 text-[12px] font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
              activeGender === id
                ? "bg-foreground text-background"
                : "bg-background text-muted-foreground hover:bg-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Shop by Category — editorial grid on the uploaded campaign
   photography. Whole tile is the tap target; `onSelect(label)` decides what
   a tap does (filter the shop grid, or navigate into Shop from elsewhere).
   The Men's tile is a special entry that triggers the gender filter rather
   than a category filter — TabShop's pickCategory() handles the distinction. */
export const CATEGORY_TILES = [
  { label: "Workwear", img: "cat-workwear.jpg" },
  { label: "Dresses", img: "cat-dresses.jpg" },
  { label: "Everyday", img: "cat-everyday.jpg" },
  { label: "Activewear", img: "cat-active.jpg" },
  { label: "Men's", img: "cat-mens.jpg", kicker: "For him" },
];
export function CategoryGrid({ onSelect, compact = false }) {
  const gridClass = compact
    ? "grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-4"
    : "grid grid-cols-2 gap-3 sm:gap-4";
  const tileClass = compact
    ? "relative rounded overflow-hidden aspect-[4/5] bg-secondary group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    : "relative rounded overflow-hidden aspect-[3/4] bg-secondary group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
  return (
    <section data-testid="shop-category-grid">
      <SectionHeader kicker="Explore" title="Shop by Category" />
      <div className={gridClass}>
        {CATEGORY_TILES.map((t) => (
          <button
            key={t.label}
            data-testid={`shop-cat-tile-${t.label.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}
            onClick={() => onSelect?.(t.label)}
            className={tileClass}
          >
            <img
              src={brandAsset(t.img)}
              alt={t.label}
              loading="lazy"
              className="w-full h-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.03]"
              draggable={false}
            />
            <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/65 to-transparent pointer-events-none" />
            <div className="absolute bottom-0 left-0 p-4">
              {t.kicker && (
                <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-white/70 mb-0.5">{t.kicker}</span>
              )}
              <span className={`font-serif text-white ${compact ? "text-base sm:text-lg" : "text-lg sm:text-xl"}`}>{t.label}</span>
              <span className="block text-[11px] text-white/80 mt-0.5 flex items-center gap-1">Shop now <ChevronRight size={11} /></span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
