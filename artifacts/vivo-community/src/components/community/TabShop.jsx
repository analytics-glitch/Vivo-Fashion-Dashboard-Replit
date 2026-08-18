import React, { useEffect, useRef, useState } from "react";
import { posts } from "./mockData";
import { ImagePlaceholder, MerchBadge, kes, swatchFor, brandAsset } from "./ui";
import { ShoppingBag, Heart, ChevronRight, ChevronDown, Sparkles, SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { useWishlist } from "@/context/WishlistContext";
import { FilterSheet, AppliedChips, emptyFilters, countActive, filtersToParams, MY_SIZE_LABELS } from "./ShopFilters";
import { CategoryGrid, ProductRail } from "./ShopSections";
import { StyledForYouShop } from "./StyledForYou";
import { useAuth } from "@/context/AuthContext";

const PAGE = 24;

/* Promotional banner — moved here from the homepage. Editable in one place:
   change SHOP_PROMO to swap in delivery offers, sales, new collections or
   store openings. */
const SHOP_PROMO = {
  kicker: "For a limited time",
  title: "Free delivery over KES 5,000",
  sub: "Nairobi, Kigali and Kampala — straight to your door.",
  image: "promo.jpg",
};
function PromoBanner() {
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

// What the wishlist stores about a piece (a display snapshot — live stock
// and sizes are fetched fresh on the Wishlist page).
const wishPayload = (p) => ({
  sku: p.sku,
  name: p.style_name,
  price: p.price,
  image: p.image_url,
  color: p.color || "",
  category: p.category || "",
});

function LookWishButton({ prod }) {
  const { has, toggle } = useWishlist();
  const saved = has(prod.sku);
  return (
    <button
      data-testid={`look-wish-${prod.sku}`}
      aria-label={saved ? `Remove ${prod.style_name} from wishlist` : `Add ${prod.style_name} to wishlist`}
      aria-pressed={saved}
      onClick={(e) => { e.stopPropagation(); toggle(wishPayload(prod)); }}
      className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Heart size={15} strokeWidth={1.5} className={saved ? "fill-primary text-primary-ink" : ""} />
    </button>
  );
}

function ShoppableLook({ post, tagged, onOpen }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      data-testid={`shop-look-${post.id}`}
      onClick={() => setRevealed((r) => !r)}
      className="relative group rounded overflow-hidden aspect-[3/4] bg-foreground cursor-pointer"
    >
      <ImagePlaceholder aspectRatio="h-full w-full opacity-60 group-hover:opacity-40 transition-opacity border-none rounded-none" text="Look" className="rounded-none border-none" />
      <div
        className={`absolute top-4 right-4 bg-background/90 backdrop-blur text-foreground text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-sm shadow-sm transition-opacity duration-300 ${
          revealed ? "opacity-0" : "opacity-100 group-hover:opacity-0"
        }`}
      >
        Shop this look
      </div>
      <div className="absolute inset-0 flex flex-col justify-end p-6">
        <div
          className={`transform transition-all duration-500 ease-out ${
            revealed ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
          } group-hover:translate-y-0 group-hover:opacity-100`}
        >
          <div className="text-white/90 font-medium mb-4 text-[15px] drop-shadow-md line-clamp-2">"{post.caption}"</div>
          <div className="flex flex-col gap-2">
            {tagged.map((prod) => (
              <div
                key={prod.sku}
                className="bg-background/95 backdrop-blur rounded p-2 pr-1.5 flex items-center gap-2 shadow-md border border-border/50"
              >
                <button
                  data-testid={`shop-look-product-${prod.sku}`}
                  onClick={(e) => { e.stopPropagation(); onOpen(prod.sku); }}
                  className="flex items-center gap-3 flex-grow min-w-0 text-left rounded hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <img
                    src={prod.image_url}
                    alt=""
                    loading="lazy"
                    className="w-12 h-12 object-contain rounded shrink-0 border border-border bg-secondary"
                  />
                  <div className="flex-grow min-w-0">
                    <div className="text-[13px] font-medium text-foreground truncate">{prod.style_name}</div>
                    <div className="text-xs text-primary-ink font-medium mt-0.5">{kes(prod.price)}</div>
                  </div>
                  <ChevronRight size={14} className="text-muted-foreground shrink-0" />
                </button>
                <LookWishButton prod={prod} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Editorial product card — image-led, no box chrome: photo, then serif
   two-line name, colour swatch and price on the open cream ground. The image
   is the whole tap target; wishlist + quick-add float over the photo as
   SIBLINGS (never nested). Quick-add opens the piece — bag adds always go
   through the detail page where she picks her size (unchanged rule). */
function ProductCard({ product, onOpen }) {
  const { has, toggle } = useWishlist();
  const [imgFailed, setImgFailed] = useState(false);
  const saved = has(product.sku);
  const hex = swatchFor(product.color);

  const open = () => onOpen(product.sku);

  return (
    <div className="group relative">
      <button
        type="button"
        data-testid={`product-card-${product.sku}`}
        onClick={open}
        className="flex flex-col w-full text-left cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="relative aspect-[3/4] rounded overflow-hidden bg-secondary mb-3">
          {imgFailed ? (
            <ImagePlaceholder aspectRatio="aspect-[3/4]" text={product.style_name} className="rounded-none border-none h-full" />
          ) : (
            <img
              src={product.image_url}
              alt={product.style_name}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-[1.02]"
            />
          )}
          <MerchBadge badge={product.badge} testId={`card-badge-${product.sku}`} className="absolute bottom-2.5 left-2.5" />
        </div>
        {/* Card reads: name → colour swatch → price. The whole card taps. */}
        <h3 className="font-serif text-foreground text-[14px] sm:text-[15px] leading-snug mb-1 line-clamp-2">{product.style_name}</h3>
        {product.color && (
          <div className="flex items-center gap-1.5 mb-1 min-w-0">
            {hex && <span className="w-3 h-3 rounded-full border border-border shrink-0" style={{ background: hex }} aria-hidden="true" />}
            <span className="text-[11px] text-muted-foreground truncate">{product.color}</span>
          </div>
        )}
        <div className="text-[14px] font-medium text-foreground">{kes(product.price)}</div>
      </button>
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5">
        <button
          data-testid="wishlist-btn"
          onClick={() => toggle(wishPayload(product))}
          aria-label={saved ? `Remove ${product.style_name} from wishlist` : `Add ${product.style_name} to wishlist`}
          aria-pressed={saved}
          className="w-10 h-10 rounded-full bg-background/85 backdrop-blur flex items-center justify-center shadow-sm hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Heart size={16} className={saved ? "fill-primary text-primary-ink" : "text-foreground"} strokeWidth={1.5} />
        </button>
        <button
          data-testid={`card-quickadd-${product.sku}`}
          aria-label={`Quick add ${product.style_name}`}
          onClick={open}
          className="w-10 h-10 rounded-full bg-background/85 backdrop-blur flex items-center justify-center text-foreground shadow-sm hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ShoppingBag size={15} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div>
      <div className="aspect-[3/4] bg-secondary rounded animate-pulse mb-3" />
      <div className="space-y-2">
        <div className="h-4 w-4/5 bg-secondary rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-secondary rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function TabShop({ onOpenProduct, onOpenTryOn, onOpenPage }) {
  const { member } = useAuth();
  // Styled-for-You view — entered via the pill here or the home rail's
  // "View All" (a tap-set sessionStorage hand-off, consumed once).
  const [sfyMode, setSfyMode] = useState(() => {
    try {
      const v = sessionStorage.getItem("vivo_shop_sfy") === "1";
      sessionStorage.removeItem("vivo_shop_sfy");
      return v;
    } catch { return false; }
  });
  const [filters, setFilters] = useState(emptyFilters());
  const [sort, setSort] = useState("new");
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [personalized, setPersonalized] = useState(false);
  const [facets, setFacets] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState(null); // the sheet's in-progress selection
  const [draftCount, setDraftCount] = useState(null);
  const [counting, setCounting] = useState(false);
  const [sizeRange, setSizeRange] = useState(null); // Style-Quiz size_range id

  const filtersKey = JSON.stringify(filters);
  const nActive = countActive(filters);
  // Bumped whenever the query (filters/sort) changes; an in-flight load-more
  // from an older query must never append into the new grid.
  const queryVer = useRef(0);
  const countSeq = useRef(0);

  const load = (offset) =>
    // personalize is a request, not a demand: without a signed-in member and
    // a finished quiz the server returns the curated order (personalized:false)
    // — and an explicit sort always wins over the Style-DNA re-rank.
    api.products(filtersToParams(filters, { limit: PAGE, offset, sort, personalize: true }));

  useEffect(() => {
    queryVer.current += 1;
    let alive = true;
    setLoading(true);
    setError("");
    load(0)
      .then((d) => {
        if (!alive) return;
        setItems(d.items);
        setCats(d.categories || []);
        setHasMore(d.has_more);
        setPersonalized(!!d.personalized);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filtersKey, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawer options + her quiz size range, once. Both are decoration — the
  // shop works fine if either fetch fails.
  useEffect(() => {
    api.productFacets().then(setFacets).catch(() => {});
    api.styleQuiz().then((d) => setSizeRange(d?.answers?.size_range || null)).catch(() => {});
  }, []);

  // Live "Show N styles" count while she tweaks the drawer selection. The
  // total is sort-independent; the seq guard drops out-of-order responses.
  useEffect(() => {
    if (!sheetOpen || !draft) return;
    setCounting(true);
    const my = ++countSeq.current;
    const t = setTimeout(() => {
      api.productsCount(filtersToParams(draft))
        .then((r) => { if (my === countSeq.current) setDraftCount(r.total); })
        .catch(() => { if (my === countSeq.current) setDraftCount(null); })
        .finally(() => { if (my === countSeq.current) setCounting(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [sheetOpen, JSON.stringify(draft)]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Pieces we think you'll love" — her Style DNA re-ranks the live
  // catalogue server-side; members who skipped the quiz get a curated slice
  // of the collection instead, so the rail is never empty. (Moved here from
  // the homepage — this is Shop content.)
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    if (!member?.quiz_completed) { setPicked([]); return; }
    let on = true;
    api.products({ limit: 8, personalize: true })
      .then((d) => { if (on) setPicked(d.personalized ? (d.items || []) : []); })
      .catch(() => {});
    return () => { on = false; };
  }, [member?.quiz_completed, (member?.style_dna || []).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // A category tile filters the grid when the live catalogue has a matching
  // category; otherwise it just shows the full collection.
  const pickCategory = (label) => {
    setSfyMode(false);
    const l = label.toLowerCase();
    const match = cats.find((c) => {
      const n = (c.name || "").toLowerCase();
      return n === l || n.includes(l) || l.includes(n);
    });
    setFilters((f) => ({ ...f, cats: match ? [match.name] : [] }));
  };

  const loadMore = async () => {
    const ver = queryVer.current;
    setLoadingMore(true);
    try {
      const d = await load(items.length);
      if (ver === queryVer.current) {
        setItems((prev) => [...prev, ...d.items]);
        setHasMore(d.has_more);
        setPersonalized(!!d.personalized);
      }
    } catch (e) {
      if (ver === queryVer.current) setError(e.message);
    }
    setLoadingMore(false);
  };

  const mySizes = (facets && sizeRange && facets.size_ranges?.[sizeRange]) || null;
  const mySizeOn = !!mySizes && mySizes.length === filters.sizes.length && mySizes.every((s) => filters.sizes.includes(s));
  const activeCat = filters.cats.length === 1 ? filters.cats[0] : filters.cats.length === 0 ? "All" : null;
  const chips = ["All", ...cats.slice(0, 8).map((c) => c.name)];

  return (
    <div className="animate-in fade-in duration-500">
      {/* Seasonal hero — moved from Home (Home-vs-Shop rewire spec §4).
          The "Shop the edit" CTA now lives here, atop the collection. */}
      <section data-testid="shop-hero" className="relative rounded overflow-hidden bg-secondary mb-10 -mx-4 sm:mx-0">
        <div className="aspect-[4/5] sm:aspect-[21/9] relative">
          <img
            src={brandAsset("hero.jpg")}
            alt=""
            className="w-full h-full object-cover object-[center_20%]"
            draggable={false}
          />
          <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-black/70 via-black/25 to-transparent pointer-events-none" />
          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-8 text-white">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/80 mb-1.5">This season's edit</div>
            <h2 className="font-serif text-2xl sm:text-3xl leading-tight mb-4 text-white">Pieces made for the sun</h2>
            <button
              data-testid="hero-shop-now"
              onClick={() => { setSfyMode(false); setFilters(emptyFilters()); }}
              className="h-11 px-6 rounded bg-white text-neutral-900 font-medium text-[13px] hover:bg-white/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Shop the edit
            </button>
          </div>
        </div>
      </section>

      <div className="mb-10 text-center space-y-2">
        <h2 className="text-3xl font-serif text-foreground">The Live Collection</h2>
            {personalized && (
              <div data-testid="shop-personalized-hint" className="flex items-center gap-1.5 text-[12px] font-medium text-primary-ink mt-2">
                <Sparkles size={13} /> Sorted for your Style DNA
              </div>
            )}
        <p className="text-muted-foreground text-sm uppercase tracking-widest">Shop the latest pieces</p>
      </div>

      {/* Virtual Try-On entry */}
      {typeof onOpenTryOn === "function" && (
        <button
          type="button"
          data-testid="shop-tryon-banner"
          onClick={onOpenTryOn}
          className="w-full mb-10 rounded border border-border bg-secondary/50 hover:bg-secondary transition-colors p-5 sm:p-6 flex items-center gap-4 text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="w-11 h-11 rounded-full bg-background border border-border flex items-center justify-center text-primary-ink shrink-0">
            <Sparkles size={18} strokeWidth={1.5} />
          </span>
          <span className="flex-grow min-w-0">
            <span className="block font-serif text-lg text-foreground leading-tight">Virtual Try-On</span>
            <span className="block text-[13px] text-muted-foreground mt-0.5">See any piece on you — a fun AI preview, private to you.</span>
          </span>
          <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-primary-ink group-hover:translate-x-0.5 transition-transform">Try it →</span>
        </button>
      )}

      {/* Shop by Category — editorial tiles (moved from the homepage) */}
      <div className="mb-10">
        <CategoryGrid onSelect={pickCategory} />
      </div>

      {/* Promotional banner — moved from the homepage (community-first brief).
          Edit SHOP_PROMO to swap in sales, new collections or store openings. */}
      <PromoBanner />


      {/* Filter + sort controls (hidden in the Styled-for-You view) */}
      {!sfyMode && (
      <div className="flex flex-wrap items-center gap-2 mb-4 px-1">
        <button
          type="button"
          data-testid="shop-filter-open"
          onClick={() => { setDraft(filters); setDraftCount(null); setSheetOpen(true); }}
          className={`inline-flex items-center gap-2 px-4 h-10 rounded-sm border text-[12px] font-bold uppercase tracking-wider whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            nActive > 0
              ? "border-primary text-primary-ink bg-primary/5"
              : "border-border bg-background text-foreground hover:bg-secondary"
          }`}
        >
          <SlidersHorizontal size={14} strokeWidth={2} />
          Filter
          {nActive > 0 && (
            <span data-testid="shop-filter-count" className="min-w-5 h-5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
              {nActive}
            </span>
          )}
        </button>
        {mySizes && (
          <button
            type="button"
            data-testid="shop-my-size"
            aria-pressed={mySizeOn}
            onClick={() => setFilters((f) => ({ ...f, sizes: mySizeOn ? [] : [...mySizes] }))}
            className={`inline-flex items-center px-4 h-10 rounded-sm border text-[12px] font-bold uppercase tracking-wider whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              mySizeOn
                ? "border-primary text-primary-ink bg-primary/5"
                : "border-border bg-background text-foreground hover:bg-secondary"
            }`}
          >
            My size · {MY_SIZE_LABELS[sizeRange] || sizeRange}
          </button>
        )}
        <div className="ml-auto relative shrink-0">
          <select
            data-testid="shop-sort"
            aria-label="Sort styles"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="appearance-none h-10 pl-4 pr-9 rounded-sm border border-border bg-background text-[12px] font-bold uppercase tracking-wider text-foreground hover:bg-secondary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {(facets?.sorts || [
              { id: "new", label: "Newest first" },
              { id: "price_asc", label: "Price low to high" },
              { id: "price_desc", label: "Price high to low" },
              { id: "best", label: "Best sellers" },
            ]).map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground" />
        </div>
      </div>
      )}

      {/* Category pills — quick single-category shortcut into the same filter
          model. Members also get the Styled-for-You collection here. */}
      <div className="flex gap-2 mb-10 overflow-x-auto hide-scrollbar pb-2 px-1">
        {member && (
          <button
            data-testid="shop-filter-styled-for-you"
            onClick={() => setSfyMode(true)}
            className={`px-5 py-2 rounded-sm text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              sfyMode
                ? "bg-foreground text-background shadow-sm"
                : "bg-background text-primary-ink hover:bg-secondary border border-border"
            }`}
          >
            <Sparkles size={11} /> Styled for You
          </button>
        )}
        {chips.map((b) => (
          <button
            key={b}
            data-testid={`shop-filter-${b}`}
            onClick={() => { setSfyMode(false); setFilters((f) => ({ ...f, cats: b === "All" ? [] : [b] })); }}
            className={`px-5 py-2 rounded-sm text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              !sfyMode && activeCat === b
                ? "bg-foreground text-background shadow-sm"
                : "bg-background text-muted-foreground hover:bg-secondary border border-border"
            }`}
          >
            {b}
          </button>
        ))}
      </div>

      {sfyMode ? (
        <StyledForYouShop onOpenProduct={onOpenProduct} onEditPrefs={() => onOpenPage?.("styleprefs")} />
      ) : (<>
      <AppliedChips filters={filters} facets={facets} onChange={setFilters} className="-mt-4 mb-8" />

      {error && (
        <div className="mb-8 rounded bg-destructive/5 border border-destructive/20 text-destructive text-[13px] font-medium px-4 py-3">
          Couldn't load the collection right now — {error}
        </div>
      )}

      {/* Product Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6 mb-12">
        {loading
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)
          : items.map((p) => <ProductCard key={p.sku} product={p} onOpen={onOpenProduct} />)}
        {!loading && !error && items.length === 0 && (
          <div className="col-span-full py-20 text-center text-muted-foreground flex flex-col items-center gap-3">
            <ShoppingBag size={32} className="opacity-20" />
            {nActive > 0 ? (
              <>
                <p>Nothing matches just yet — try removing a filter.</p>
                <button
                  type="button"
                  data-testid="empty-clear-filters"
                  onClick={() => setFilters(emptyFilters())}
                  className="text-[13px] font-medium text-primary-ink hover:underline"
                >
                  Clear all filters
                </button>
              </>
            ) : (
              <p>Nothing in this category right now — check back soon.</p>
            )}
          </div>
        )}
      </div>

      {!loading && hasMore && (
        <div className="text-center mb-20">
          <button
            data-testid="btn-load-more"
            onClick={loadMore}
            disabled={loadingMore}
            className="px-8 h-11 rounded border border-border bg-background text-foreground font-medium text-[13px] uppercase tracking-wider hover:bg-secondary transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {loadingMore ? "Loading…" : "Load More Styles"}
          </button>
        </div>
      )}

      {/* Fresh off the floor — New This Week rail (moved from the homepage,
          per Sharon). Shows on the pristine catalogue only (no filters AND
          the default "new" sort), so filtered or re-sorted views stay
          focused on those results. */}
      {!loading && sort === "new" && nActive === 0 && items.length > 0 && (
        <div className="mb-16">
          <ProductRail
            kicker="New This Week"
            title="Fresh off the floor"
            sub="The newest pieces in the live collection."
            products={items.slice(0, 8)}
            onOpenProduct={onOpenProduct}
            testId="shop-new-this-week"
            idPrefix="ntw"
          />
        </div>
      )}

      {/* Chosen for You — Style-DNA rail (moved from the homepage) */}
      {(() => {
        const chosen = picked.length > 0 ? picked : items.slice(4, 12);
        return !loading && chosen.length > 0 ? (
          <div className="mb-16">
            <ProductRail
              kicker="Chosen for You"
              title={picked.length > 0 ? "Your Style DNA at work" : "Pieces we think you'll love"}
              sub={picked.length > 0 ? "Pieces chosen from what you told us you love." : "Take the Style Quiz and we'll tune these to you."}
              products={chosen}
              onOpenProduct={onOpenProduct}
              testId="picked-for-you"
              idPrefix="pfy"
            />
          </div>
        ) : null;
      })()}

      {/* Shoppable UGC — looks tagged with live pieces from the collection */}
      {!loading && items.length > 0 && (
        <div className="border-t border-border pt-16">
          <div className="mb-10 text-center space-y-2">
            <h2 className="text-2xl font-serif text-foreground">Community Looks</h2>
            <p className="text-muted-foreground text-[11px] uppercase tracking-widest">Shop how others wear it</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {posts.slice(0, 2).map((post, i) => (
              <ShoppableLook
                key={post.id}
                post={post}
                tagged={items.slice(i * 2, i * 2 + 2)}
                onOpen={onOpenProduct}
              />
            ))}
          </div>
        </div>
      )}

      </>)}

      <FilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        facets={facets}
        draft={draft}
        setDraft={setDraft}
        count={draftCount}
        counting={counting}
        onApply={(d) => { setFilters(d); setSheetOpen(false); }}
      />
    </div>
  );
}
