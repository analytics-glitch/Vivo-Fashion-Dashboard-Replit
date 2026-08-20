import React, { useEffect, useRef, useState } from "react";
import { ImagePlaceholder, MerchBadge, kes, swatchFor, brandAsset } from "./ui";
import { ShoppingBag, Heart, ChevronDown, Sparkles, SlidersHorizontal, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { useWishlist } from "@/context/WishlistContext";
import { FilterSheet, AppliedChips, emptyFilters, countActive, filtersToParams } from "./ShopFilters";
import { CategoryGrid, GenderToggle, ShopQuickLinks } from "./ShopSections";
import { VivoEditsHome } from "./VivoEdits";
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

/* Editorial product card — image-led, no box chrome: photo, then serif
   two-line name and price on the open cream ground. Colour swatches sit over
   the lower-right of the image so the product gets more visual space. The
   image is the whole tap target; wishlist + quick-add float over the photo
   as SIBLINGS (never nested). The shopping-bag icon opens a lightweight size
   picker overlay so the shopper can add to bag without leaving the grid.

   Colourway swatches: when the server returns a `colourways` array (multiple
   in-stock colourways for the style), tappable dot-swatches appear over the
   image. Tapping one swaps the card thumbnail; opening the card or the size
   picker navigates to that colourway's SKU. */
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
    <div className="group">
      <div className="relative aspect-[3/4] rounded overflow-hidden bg-secondary mb-3">
        <button
          type="button"
          aria-label={`View ${product.style_name}`}
          onClick={open}
          className="w-full h-full text-left cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
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
        </button>

        {/* Colourway swatches are siblings of the image button: they stay
            inside the photo while never nesting an interactive control. */}
        {colourways && colourways.length > 1 && (
          <div
            data-testid={`swatches-${product.sku}`}
            className="absolute bottom-2 right-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap justify-end gap-1 rounded-full bg-background/85 px-1.5 py-1 backdrop-blur shadow-sm"
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
        {(!colourways || colourways.length <= 1) && activeHex && (
          <div
            data-testid={`swatches-${product.sku}`}
            className="absolute bottom-2 right-2 z-10 rounded-full bg-background/85 p-1.5 backdrop-blur shadow-sm"
            aria-label={`Colour: ${activeColor}`}
            title={activeColor}
          >
            <span className="block w-5 h-5 rounded-full border-2 border-border" style={{ background: activeHex }} aria-hidden="true" />
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
      </div>
      <button
        type="button"
        data-testid={`product-card-${product.sku}`}
        onClick={open}
        className="block w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {/* Card reads: name → price. */}
        <h3 className="font-serif text-foreground text-[14px] sm:text-[15px] leading-snug mb-2 line-clamp-2">{product.style_name}</h3>
        <div className="text-[14px] font-medium text-foreground">{kes(product.price)}</div>
      </button>
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

function StyleDnaControl({ hasQuiz, enabled, onToggle, onOpenQuiz }) {
  const activate = () => {
    if (hasQuiz) onToggle(!enabled);
    else onOpenQuiz?.();
  };

  return (
    <button
      type="button"
      data-testid="shop-style-dna"
      role={hasQuiz ? "switch" : undefined}
      aria-checked={hasQuiz ? enabled : undefined}
      aria-label={hasQuiz ? "Curate based on my Style DNA" : "Take the Style Quiz to curate based on my Style DNA"}
      onClick={activate}
      className={`col-span-2 sm:col-span-1 inline-flex items-center gap-2.5 px-3 h-10 rounded-sm border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        hasQuiz
          ? enabled
            ? "border-primary bg-primary/10 text-primary-ink"
            : "border-border bg-background text-foreground hover:bg-secondary"
          : "border-border bg-background text-foreground hover:bg-secondary"
      }`}
    >
      <span className={`relative flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        hasQuiz && enabled ? "bg-primary" : "bg-border"
      }`}>
        <span className={`absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          hasQuiz && enabled ? "translate-x-4" : ""
        }`} />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[11px] font-semibold whitespace-nowrap">Curate based on my Style DNA</span>
        <span className="block text-[10px] text-muted-foreground whitespace-nowrap">
          {hasQuiz ? "From your style quiz results" : "Take the quiz to unlock"}
        </span>
      </span>
    </button>
  );
}

export default function TabShop({ member, onOpenProduct, onOpenTryOn, onOpenPage, onOpenQuiz, onOpenEdit, onOpenEdits }) {
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
  const [facets, setFacets] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState(null); // the sheet's in-progress selection
  const [draftCount, setDraftCount] = useState(null);
  const [counting, setCounting] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [styleDnaOn, setStyleDnaOn] = useState(() => {
    let handoff = false;
    try {
      handoff = sessionStorage.getItem("vivo_shop_style_dna_handoff") === "1";
      if (handoff) sessionStorage.removeItem("vivo_shop_style_dna_handoff");
    } catch { /* private mode */ }
    return handoff || !!member?.quiz_completed;
  });

  const hasStyleDna = !!member?.quiz_completed;
  const styleDnaActive = hasStyleDna && styleDnaOn;

  useEffect(() => {
    if (!shopGenderHandoff) return;
    try { sessionStorage.removeItem("vivo_shop_gender_handoff"); } catch { /* private mode */ }
  }, [shopGenderHandoff]);

  // A completed quiz always starts a fresh Shop visit curated. A shopper can
  // still switch it off for this visit; the dependency only changes when the
  // quiz moves from incomplete to complete (for example, after saving it).
  useEffect(() => {
    if (hasStyleDna) setStyleDnaOn(true);
  }, [hasStyleDna]);

  const filtersKey = JSON.stringify({ filters, searchTerm, styleDnaActive });
  const nActive = countActive(filters);
  // Bumped whenever the query (filters/sort) changes; an in-flight load-more
  // from an older query must never append into the new grid.
  const queryVer = useRef(0);
  const countSeq = useRef(0);

  const load = (offset) => {
    const extra = { limit: PAGE, offset, sort, searchTerm };
    if (styleDnaActive) extra.personalize = true;
    return api.products(filtersToParams(filters, extra));
  };

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
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filtersKey, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawer options are decoration — the shop still works if this fetch fails.
  useEffect(() => {
    api.productFacets().then(setFacets).catch(() => {});
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

  // Anchor target for "Shop the latest pieces" — scrolls to the grid controls.
  const gridTopRef = useRef(null);
  const curatorsRef = useRef(null);
  const scrollToGrid = () => gridTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const scrollToCurators = () => curatorsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      }
    } catch (e) {
      if (ver === queryVer.current) setError(e.message);
    }
    setLoadingMore(false);
  };

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

      <ShopQuickLinks
        onBrowseNew={() => { setFilters(emptyFilters()); setSort("new"); scrollToGrid(); }}
        onOpenDelivery={() => onOpenPage?.("delivery")}
        onOpenQuiz={onOpenQuiz}
        onOpenCurated={scrollToCurators}
      />

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

      {/* Core catalogue controls: Filter, Search, and Sorting. */}
      <div ref={gridTopRef} className="scroll-mt-24" aria-hidden="true" />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 mb-4 sm:flex sm:flex-wrap sm:items-center">
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
        <StyleDnaControl
          hasQuiz={hasStyleDna}
          enabled={styleDnaActive}
          onToggle={setStyleDnaOn}
          onOpenQuiz={onOpenQuiz}
        />
        <form
          data-testid="shop-search"
          onSubmit={(e) => { e.preventDefault(); gridTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
          className="col-span-2 sm:col-auto sm:basis-auto sm:flex-1 flex items-center gap-2 border border-border rounded bg-background px-3 h-10 min-w-0 sm:min-w-[220px] focus-within:ring-2 focus-within:ring-primary/40"
        >
          <Search size={15} className="text-muted-foreground shrink-0" />
          <input
            type="search"
            data-testid="shop-search-input"
            aria-label="Search products"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search styles, colours or categories"
            className="min-w-0 flex-1 bg-transparent outline-none text-[13px] text-foreground placeholder:text-muted-foreground"
          />
          {searchTerm && (
            <button type="button" data-testid="shop-search-clear" onClick={clearSearch} aria-label="Clear product search" className="p-1 text-muted-foreground hover:text-foreground">
              <X size={15} />
            </button>
          )}
        </form>
        <div className="relative shrink-0">
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
      <GenderToggle
        activeGender={activeGender}
        onChange={(id) => setFilters((f) => ({ ...f, gender: id === "all" ? "" : id, cats: [] }))}
      />
      <AppliedChips filters={filters} facets={facets} onChange={setFilters} className="-mt-2 mb-7" />

      {/* Shop by Category stays intact, but becomes a quick-access grid. */}
      <div className="mb-10">
        <CategoryGrid onSelect={pickCategory} compact />
      </div>

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

      {/* The grid now flows directly into creator edits; community looks stay
          in the Community tab rather than interrupting the Shop journey. */}
      <div ref={curatorsRef} className="border-t border-border pt-16 mt-16 scroll-mt-24" data-testid="shop-vivo-edits">
        <VivoEditsHome
          onOpenEdit={onOpenEdit}
          onViewAll={onOpenEdits}
          includeCommunityLooks={false}
          kicker="Vivo Edits"
          title="Curated Looks by creators"
          sub="Sharon, Phinie and Grace share the edits they love."
        />
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
