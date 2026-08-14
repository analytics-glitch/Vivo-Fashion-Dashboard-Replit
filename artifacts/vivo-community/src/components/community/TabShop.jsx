import React, { useEffect, useState } from "react";
import { posts } from "./mockData";
import { ImagePlaceholder, MerchBadge, kes } from "./ui";
import { ShoppingBag, Heart, ChevronRight, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useWishlist } from "@/context/WishlistContext";

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

function ProductCard({ product, onOpen }) {
  const { has, toggle } = useWishlist();
  const [imgFailed, setImgFailed] = useState(false);
  const saved = has(product.sku);

  const open = () => onOpen(product.sku);

  return (
    <div className="group relative flex flex-col bg-card rounded overflow-hidden hover:shadow-md transition-all duration-500 ease-out">
      {/* The whole card body is one real button (keyboard + SR friendly); the
          wishlist control is a SIBLING, not nested inside it. The card only
          opens the piece — adding to the bag happens on the detail page. */}
      <button
        type="button"
        data-testid={`product-card-${product.sku}`}
        onClick={open}
        className="flex flex-col flex-grow w-full text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
      <div className="relative aspect-[3/4] bg-secondary overflow-hidden">
        {imgFailed ? (
          <ImagePlaceholder aspectRatio="aspect-[3/4]" text={product.style_name} className="rounded-none border-none h-full" />
        ) : (
          <img
            src={product.image_url}
            alt={product.style_name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-contain"
          />
        )}
        <MerchBadge badge={product.badge} testId={`card-badge-${product.sku}`} className="absolute bottom-3 left-3" />
      </div>
      <div className="p-4 flex flex-col flex-grow bg-card border border-t-0 border-border">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">{product.category}</div>
        <h3 className="font-serif text-foreground text-[15px] leading-snug mb-1 flex-grow line-clamp-2">{product.style_name}</h3>
        {product.color && (
          <div className="text-xs text-muted-foreground mb-3 truncate">{product.color}</div>
        )}
        <div className="flex items-center justify-between">
          <div className="font-medium text-foreground">{kes(product.price)}</div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-primary-ink flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            View <ChevronRight size={12} />
          </span>
        </div>
      </div>
      </button>
      <button
        data-testid="wishlist-btn"
        onClick={() => toggle(wishPayload(product))}
        aria-label={saved ? `Remove ${product.style_name} from wishlist` : `Add ${product.style_name} to wishlist`}
        aria-pressed={saved}
        className="absolute top-2 right-2 z-10 w-11 h-11 rounded-full bg-background/80 backdrop-blur flex items-center justify-center shadow-sm hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Heart size={16} className={saved ? "fill-primary text-primary-ink" : "text-foreground"} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-card rounded overflow-hidden border border-border">
      <div className="aspect-[3/4] bg-secondary animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-2 w-1/3 bg-secondary rounded animate-pulse" />
        <div className="h-4 w-4/5 bg-secondary rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-secondary rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function TabShop({ onOpenProduct, onOpenTryOn }) {
  const [filter, setFilter] = useState("All");
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [personalized, setPersonalized] = useState(false);

  const load = async (category, offset) => {
    // personalize is a request, not a demand: without a signed-in member and
    // a finished quiz the server returns the curated order (personalized:false).
    const d = await api.products({ category: category === "All" ? "" : category, limit: PAGE, offset, personalize: true });
    setPersonalized(!!d.personalized);
    return d;
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    load(filter, 0)
      .then((d) => {
        if (!alive) return;
        setItems(d.items);
        setCats(d.categories || []);
        setHasMore(d.has_more);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filter]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const d = await load(filter, items.length);
      setItems((prev) => [...prev, ...d.items]);
      setHasMore(d.has_more);
    } catch (e) {
      setError(e.message);
    }
    setLoadingMore(false);
  };

  const chips = ["All", ...cats.slice(0, 8).map((c) => c.name)];

  return (
    <div className="animate-in fade-in duration-500">
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

      {/* Category filters */}
      <div className="flex gap-2 mb-10 overflow-x-auto hide-scrollbar pb-2 px-1">
        {chips.map((b) => (
          <button
            key={b}
            data-testid={`shop-filter-${b}`}
            onClick={() => setFilter(b)}
            className={`px-5 py-2 rounded-sm text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              filter === b
                ? "bg-foreground text-background shadow-sm"
                : "bg-background text-muted-foreground hover:bg-secondary border border-border"
            }`}
          >
            {b}
          </button>
        ))}
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
            <p>Nothing in this category right now — check back soon.</p>
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
    </div>
  );
}
