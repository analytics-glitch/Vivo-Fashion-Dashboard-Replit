import React, { useEffect, useRef, useState } from "react";
import { ImagePlaceholder, MerchBadge, kes, swatchFor, brandAsset } from "./ui";
import { ShoppingBag, Heart, ChevronRight, ChevronDown, Sparkles, SlidersHorizontal, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { useWishlist } from "@/context/WishlistContext";
import { FilterSheet, AppliedChips, emptyFilters, countActive, filtersToParams, MY_SIZE_LABELS } from "./ShopFilters";
import { CategoryGrid, ProductRail, RailCard, PromoBanner, GenderToggle } from "./ShopSections";
import { VivoEditsHome } from "./VivoEdits";
import { useAuth } from "@/context/AuthContext";
import { QuickAddModal } from "./QuickAddModal";

const PAGE = 24;

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
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div
      data-testid={`shop-look-${post.id}`}
      onClick={() => setRevealed((r) => !r)}
      className="relative group rounded overflow-hidden aspect-[3/4] bg-foreground cursor-pointer"
    >
      {post.image_url && !imgFailed ? (
        <img
          src={post.image_url}
          alt={post.caption || "Community look"}
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-60 transition-opacity"
          draggable={false}
        />
      ) : (
        <ImagePlaceholder aspectRatio="h-full w-full opacity-60 group-hover:opacity-40 transition-opacity border-none rounded-none" text="Look" className="rounded-none border-none" />
      )}
      <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/75 via-black/30 to-transparent pointer-events-none" />
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
   SIBLINGS (never nested). The shopping-bag icon opens a lightweight size
   picker overlay so the shopper can add to bag without leaving the grid.

   Colourway swatches: when the server returns a `colourways` array (multiple
   in-stock colourways for the style), tappable dot-swatches appear below the
   name. Tapping one swaps the card thumbnail and colour label; opening the
   card or the size picker navigates to that colourway's SKU. */
function ProductCard({ product, onOpen }) {
  const { has, toggle } = useWishlist();
  // Active colourway: starts at the product itself, updated when a swatch is tapped.
  const [active, setActive] = useState(null); // null = use product defaults
  const [imgFailed, setImgFailed] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);

  // Resolved display values — fall back to the card's product when no swatch chosen.
  const activeSku = active?.sku ?? product.sku;
  const activeColor = active?.color ?? product.color;
  const activeImage = active?.image_url ?? product.image_url;
  const activeHex = swatchFor(activeColor);

  const saved = has(product.sku);  // wishlist tracks the style's primary SKU
  const colourways = product.colourways; // [{sku, color, image_url}] or undefined

  // When a swatch is tapped we swap the displayed colourway without navigating.
  const pickColourway = (e, cw) => {
    e.stopPropagation();
    // Tapping the already-active swatch deselects back to the product default.
    setActive((prev) => (prev?.sku === cw.sku && cw.sku !== product.sku ? null : cw));
    setImgFailed(false);
  };

  const open = () => onOpen(activeSku);

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
              src={activeImage}
              alt={product.style_name}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-[1.02]"
            />
          )}
          <MerchBadge badge={product.badge} testId={`card-badge-${product.sku}`} className="absolute bottom-2.5 left-2.5" />
        </div>
        {/* Card reads: name → colour label → price. The whole card taps. */}
        <h3 className="font-serif text-foreground text-[14px] sm:text-[15px] leading-snug mb-1 line-clamp-2">{product.style_name}</h3>
        {activeColor && (
          <div className="flex items-center gap-1.5 mb-1 min-w-0">
            {activeHex && <span className="w-3 h-3 rounded-full border border-border shrink-0" style={{ background: activeHex }} aria-hidden="true" />}
            <span className="text-[11px] text-muted-foreground truncate">{activeColor}</span>
          </div>
        )}
        <div className="text-[14px] font-medium text-foreground">{kes(product.price)}</div>
      </button>

      {/* Colourway swatches — shown only when the style has multiple colourways.
          Rendered OUTSIDE the main card button so taps don't trigger navigation. */}
      {colourways && colourways.length > 1 && (
        <div
          className="flex flex-wrap gap-1.5 mt-2"
          role="group"
          aria-label={`Colour options for ${product.style_name}`}
        >
          {colourways.slice(0, 6).map((cw) => {
            const hex = swatchFor(cw.color);
            const isActive = activeSku === cw.sku;
            return (
              <button
                key={cw.sku}
                type="button"
                data-testid={`swatch-${product.sku}-${cw.sku}`}
                aria-label={cw.color || "Colour option"}
                aria-pressed={isActive}
                onClick={(e) => pickColourway(e, cw)}
                className={`w-5 h-5 rounded-full border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  isActive
                    ? "border-foreground scale-110"
                    : "border-border hover:border-foreground/50 hover:scale-105"
                }`}
                style={hex ? { background: hex } : { background: "transparent" }}
                title={cw.color}
              >
                {/* Fallback for unnamed/no-hex colours: a tiny colour initial */}
                {!hex && (
                  <span className="flex items-center justify-center w-full h-full text-[8px] font-bold text-muted-foreground uppercase leading-none">
                    {(cw.color || "?")[0]}
                  </span>
                )}
              </button>
            );
          })}
          {colourways.length > 6 && (
            <span className="text-[10px] text-muted-foreground self-center">
              +{colourways.length - 6}
            </span>
          )}
        </div>
      )}

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
          onClick={(e) => { e.stopPropagation(); setQuickAdd(true); }}
          className="w-10 h-10 rounded-full bg-background/85 backdrop-blur flex items-center justify-center text-foreground shadow-sm hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ShoppingBag size={15} strokeWidth={1.5} />
        </button>
      </div>
      {quickAdd && (
        <QuickAddModal
          sku={activeSku}
          productName={product.style_name}
          productImage={activeImage}
          productPrice={product.price}
          onClose={() => setQuickAdd(false)}
          onOpenProduct={onOpen}
        />
      )}
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

function ChosenForYou({ loading, picked, items, member, onOpenProduct, onOpenQuiz }) {
  if (loading) return null;
  if (picked.length > 0) {
    return (
      <div className="mb-12" data-testid="picked-for-you">
        <ProductRail
          kicker="Chosen for You"
          title="Pieces we think you'll love"
          sub="Your Style DNA at work — refreshed weekly when you opt in."
          products={picked}
          onOpenProduct={onOpenProduct}
          testId="picked-for-you"
          idPrefix="pfy"
        />
      </div>
    );
  }
  const chosen = items.slice(4, 12);
  if (chosen.length === 0) return null;
  return (
    <div className="mb-12" data-testid="picked-for-you">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-primary-ink mb-1.5">Chosen for You</div>
          <h2 className="text-2xl font-serif text-foreground">Pieces we think you'll love</h2>
          <p className="text-[13px] text-muted-foreground mt-1">
            {member?.quiz_completed
              ? "Update your Style Quiz and we'll tune these to you."
              : "Take the Style Quiz and we'll tune these to you."}
          </p>
        </div>
        {member && typeof onOpenQuiz === "function" && (
          <button
            type="button"
            data-testid="shop-quiz-cta"
            onClick={onOpenQuiz}
            className="h-11 px-6 rounded bg-foreground text-background font-medium text-[13px] hover:bg-foreground/90 active:scale-[0.98] transition-all inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Sparkles size={14} /> {member?.quiz_completed ? "Update my Style Quiz" : "Take the Style Quiz"}
          </button>
        )}
      </div>
      <div data-testid="picked-for-you-rail" className="flex gap-3 overflow-x-auto hide-scrollbar snap-x -mx-4 px-4 sm:mx-0 sm:px-0 pb-1">
        {chosen.map((p) => <RailCard key={p.sku} p={p} onOpenProduct={onOpenProduct} idPrefix="pfy" />)}
      </div>
    </div>
  );
}

export default function TabShop({ onOpenProduct, onOpenTryOn, onOpenPage, onOpenQuiz, onOpenEdit, onOpenEdits }) {
  const { member } = useAuth();
  const [shopGenderHandoff] = useState(() => {
    try {
      const value = sessionStorage.getItem("vivo_shop_gender_handoff");
      return ["women", "all", "men"].includes(value) ? value : "";
    } catch {
      return "";
    }
  });
  const [filters, setFilters] = useState(() => {
    const next = emptyFilters();
    if (shopGenderHandoff === "all") next.gender = "";
    else if (shopGenderHandoff === "men") next.gender = "men";
    return next;
  });
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
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    if (!shopGenderHandoff) return;
    try { sessionStorage.removeItem("vivo_shop_gender_handoff"); } catch { /* private mode */ }
  }, [shopGenderHandoff]);

  const filtersKey = JSON.stringify({ filters, searchTerm });
  const nActive = countActive(filters);
  // Bumped whenever the query (filters/sort) changes; an in-flight load-more
  // from an older query must never append into the new grid.
  const queryVer = useRef(0);
  const countSeq = useRef(0);

  const load = (offset) =>
    // personalize is a request, not a demand: without a signed-in member and
    // a finished quiz the server returns the curated order (personalized:false)
    // — and an explicit sort always wins over the Style-DNA re-rank.
    api.products(filtersToParams(filters, { limit: PAGE, offset, sort, personalize: true, searchTerm }));

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
    api.styledForYouStatus()
      .then((status) => {
        if (!on || !status.opted_in) { if (on) setPicked([]); return null; }
        return api.products({ limit: 8, personalize: true });
      })
      .then((d) => { if (on && d) setPicked(d.personalized ? (d.items || []) : []); })
      .catch(() => { if (on) setPicked([]); });
    return () => { on = false; };
  }, [member?.quiz_completed, (member?.style_dna || []).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Community Looks" — real community posts (photo + tagged pieces) from
  // the public feed, replacing the old placeholder tiles. A look qualifies
  // only if it has BOTH a photo and at least one tagged live product.
  const [looks, setLooks] = useState([]);
  useEffect(() => {
    let on = true;
    api.feed(30)
      .then((d) => {
        if (!on) return;
        const qualified = (d.items || []).filter(
          (p) => p.image_url && (p.tagged || []).length > 0 && p.post_type !== "question"
        );
        setLooks(qualified.slice(0, 2));
      })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  // Anchor target for "Shop the latest pieces" — scrolls to the grid controls.
  const gridTopRef = useRef(null);
  const scrollToGrid = () => gridTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const clearSearch = () => setSearchTerm("");

  // A category tile filters the grid when the live catalogue has a matching
  // category; otherwise it just shows the full collection.
  // "Men's" is a special tile that switches the gender toggle rather than a
  // category — it clears any active category so the full men's range shows.
  const pickCategory = (label) => {
    if (label === "Men's") {
      setFilters((f) => ({ ...f, cats: [], gender: "men" }));
      return;
    }
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
  const activeGender = filters.gender || "all"; // "all" | "women" | "men"

  return (
    <div className="animate-in fade-in duration-500">
      {/* Seasonal hero — moved from Home (Home-vs-Shop rewire spec §4).
          The "Shop the edit" CTA now lives here, atop the collection. */}
      <section data-testid="shop-hero" className="relative rounded overflow-hidden bg-secondary mb-10 -mx-4 sm:mx-0">
        <div className="aspect-[4/5] sm:aspect-[12/5] relative">
          {/* Art-directed hero crops: swirl-print dress on the bench. Two separate
              exports (not one image scaled) — desktop 1920×800 (2.4:1, retina 2x
              via srcSet), mobile 1000×1250 (4:5, tighter on the model). */}
          <picture>
            <source
              media="(min-width: 640px)"
              srcSet={`${brandAsset("hero-desktop.jpg")} 1x, ${brandAsset("hero-desktop@2x.webp")} 2x`}
            />
            <img
              src={brandAsset("hero-mobile.jpg")}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
            />
          </picture>
          <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-black/70 via-black/25 to-transparent pointer-events-none" />
          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-8 text-white">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/80 mb-1.5">This season's edit</div>
            <h2 className="font-serif text-2xl sm:text-3xl leading-tight mb-4 text-white">Pieces made for the sun</h2>
            <button
              data-testid="hero-shop-now"
              onClick={() => { setFilters(emptyFilters()); /* defaults to Women's */ }}
              className="h-11 px-6 rounded bg-white text-neutral-900 font-medium text-[13px] hover:bg-white/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Shop the edit
            </button>
          </div>
        </div>
      </section>

      {/* Unified quiz/picks entry: the same Style DNA powers the general
          collection order and the optional weekly curated rail. */}
      <ChosenForYou
        loading={loading}
        picked={picked}
        items={items}
        member={member}
        onOpenProduct={onOpenProduct}
        onOpenQuiz={onOpenQuiz}
      />

      {/* Live Collection block — now a real anchor into the product grid
          (Shop Fixes spec: it must earn its place, not duplicate the hero CTA). */}
      <div className="mb-10 text-center space-y-2">
        <h2 className="text-3xl font-serif text-foreground">The Live Collection</h2>
        {personalized && (
          <div data-testid="shop-personalized-hint" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-primary-ink mt-2">
            <Sparkles size={13} /> Sorted for your Style DNA
          </div>
        )}
        <button
          type="button"
          data-testid="live-collection-anchor"
          onClick={scrollToGrid}
          className="block mx-auto text-muted-foreground text-sm uppercase tracking-widest hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Shop the latest pieces ↓
        </button>
      </div>

      {/* Shop-local search is intentionally separate from the app-wide header
          search/navigation control. */}
      <form
        data-testid="shop-search"
        onSubmit={(e) => { e.preventDefault(); gridTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
        className="mb-10 flex items-center gap-2 border border-border rounded bg-background px-3 h-12 focus-within:ring-2 focus-within:ring-primary/40"
      >
        <Search size={17} className="text-muted-foreground shrink-0" />
        <input
          type="search"
          data-testid="shop-search-input"
          aria-label="Search products"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search styles, colours or categories"
          className="min-w-0 flex-1 bg-transparent outline-none text-[14px] text-foreground placeholder:text-muted-foreground"
        />
        {searchTerm && (
          <button type="button" data-testid="shop-search-clear" onClick={clearSearch} aria-label="Clear product search" className="p-1 text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        )}
        <button type="submit" className="h-8 px-3 rounded bg-foreground text-background text-[12px] font-medium">Search</button>
      </form>

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

      {/* Promotional banner — shared with the Home discovery lead-in. */}
      <PromoBanner />


      {/* Filter + sort controls for the same unified Shop catalogue. */}
      <div ref={gridTopRef} className="scroll-mt-24" aria-hidden="true" />
      {/* Gender toggle — Women's / All / Men's. Sits above the filter row so
          it's always visible and clearly separate from drawer-based filters. */}
      <GenderToggle
        activeGender={activeGender}
        onChange={(id) => setFilters((f) => ({ ...f, gender: id === "all" ? "" : id, cats: [] }))}
      />
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
      {/* Category pills — quick single-category shortcuts into the same
          catalogue that the Shop search and Style DNA ordering use. */}
      <div className="flex gap-2 mb-10 overflow-x-auto hide-scrollbar pb-2 px-1">
        {chips.map((b) => (
          <button
            key={b}
            data-testid={`shop-filter-${b}`}
            onClick={() => setFilters((f) => ({ ...f, cats: b === "All" ? [] : [b] }))}
            className={`px-5 py-2 rounded-sm text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              activeCat === b
                ? "bg-foreground text-background shadow-sm"
                : "bg-background text-muted-foreground hover:bg-secondary border border-border"
            }`}
          >
            {b}
          </button>
        ))}
      </div>

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

      {/* "Fresh off the floor" removed (Shop Fixes spec): it duplicated the
          first rows of the default newest-first grid. The "Newest first" sort
          covers new arrivals. */}

      {/* Shoppable UGC — REAL community posts with a photo and tagged live
          pieces (Shop Fixes spec: the old tiles rendered empty placeholders).
          Hidden entirely when no qualifying looks exist. */}
      {!loading && looks.length > 0 && (
        <div className="border-t border-border pt-16">
          <div className="mb-10 text-center space-y-2">
            <h2 className="text-2xl font-serif text-foreground">Community Looks</h2>
            <p className="text-muted-foreground text-[11px] uppercase tracking-widest">Shop how others wear it</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {looks.map((post) => (
              <ShoppableLook
                key={post.id}
                post={post}
                tagged={(post.tagged || []).slice(0, 2).map((t) => ({
                  sku: t.sku,
                  style_name: t.name,
                  price: t.price,
                  image_url: `/api/community/product-image/${encodeURIComponent(t.sku)}`,
                  color: "",
                  category: "",
                }))}
                onOpen={onOpenProduct}
              />
            ))}
          </div>
        </div>
      )}

      {/* Vivo Edits — creator/editorial section, with its own clear header
          divider so it reads as a distinct block on Shop too. */}
      <div className="border-t border-border pt-16 mt-16" data-testid="shop-vivo-edits">
        <VivoEditsHome onOpenEdit={onOpenEdit} onViewAll={onOpenEdits} />
      </div>

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
