import React, { useEffect, useState } from "react";
import { posts } from "./mockData";
import { ImagePlaceholder } from "./ui";
import { ShoppingCart, Heart } from "@phosphor-icons/react";
import { api } from "@/lib/api";

const PAGE = 24;

function ShoppableLook({ post }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      data-testid={`shop-look-${post.id}`}
      onClick={() => setRevealed((r) => !r)}
      className="relative group rounded-2xl overflow-hidden aspect-[4/3] bg-black cursor-pointer"
    >
      <ImagePlaceholder aspectRatio="h-full w-full opacity-70 group-hover:opacity-50 transition-opacity" className="rounded-none" />
      <div
        className={`absolute top-4 right-4 bg-white/95 backdrop-blur text-[#2c2a29] text-xs font-bold px-3 py-1.5 rounded-full shadow-lg transition-opacity duration-300 ${
          revealed ? "opacity-0" : "opacity-100 group-hover:opacity-0"
        }`}
      >
        Shop this look →
      </div>
      <div className="absolute inset-0 flex flex-col justify-end p-6">
        <div
          className={`transform transition-all duration-300 ${
            revealed ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
          } group-hover:translate-y-0 group-hover:opacity-100`}
        >
          <div className="text-white font-medium mb-4 drop-shadow-md line-clamp-2">"{post.caption}"</div>
          <div className="flex gap-3 overflow-x-auto hide-scrollbar">
            {post.taggedProducts?.map((prod) => (
              <div key={prod.id} className="bg-white/95 backdrop-blur rounded-xl p-2 flex items-center gap-3 min-w-[200px] shadow-lg">
                <div className="w-10 h-10 bg-[#ebdcd0] rounded flex items-center justify-center text-xs">📸</div>
                <div className="flex-grow">
                  <div className="text-xs font-bold text-[#2c2a29] truncate max-w-[120px]">{prod.name}</div>
                  <div className="text-xs text-[#c25e30] font-bold">KES {prod.price.toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductCard({ product }) {
  const [wishlist, setWishlist] = useState(false);
  const [inCart, setInCart] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const lowStock = product.soh > 0 && product.soh <= 5;

  return (
    <div className="group flex flex-col bg-white rounded-2xl overflow-hidden shadow-[0_2px_10px_rgba(44,42,41,0.04)] hover:-translate-y-1 transition-all duration-300">
      <div className="relative">
        {imgFailed ? (
          <ImagePlaceholder aspectRatio="aspect-[3/4]" className="rounded-none" />
        ) : (
          <div className="aspect-[3/4] bg-[#ebdcd0] overflow-hidden">
            <img
              src={product.image_url}
              alt={product.style_name}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"
            />
          </div>
        )}
        <button
          data-testid="wishlist-btn"
          onClick={() => setWishlist(!wishlist)}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/80 backdrop-blur flex items-center justify-center text-[#c25e30] shadow-sm hover:bg-white transition-colors"
        >
          {wishlist ? <span>❤</span> : <Heart weight="bold" size={18} />}
        </button>
        {lowStock && (
          <span className="absolute bottom-3 left-3 bg-[#2c2a29]/85 backdrop-blur text-white text-[11px] font-bold px-2.5 py-1 rounded-full">
            Only {product.soh} left
          </span>
        )}
      </div>
      <div className="p-4 sm:p-5 flex flex-col flex-grow">
        <div className="text-xs font-bold uppercase tracking-widest text-[#a8a199] mb-1">{product.category}</div>
        <h3 className="font-bold text-[#2c2a29] text-sm sm:text-base leading-snug mb-1 flex-grow">{product.style_name}</h3>
        {product.color && (
          <div className="text-xs text-[#7a746e] mb-2 truncate">{product.color}</div>
        )}
        <div className="font-extrabold text-[#c25e30] mb-4">KES {Math.round(product.price).toLocaleString()}</div>

        <button
          data-testid="add-to-cart-btn"
          onClick={() => setInCart(true)}
          disabled={inCart}
          className={`w-full py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all ${
            inCart
              ? "bg-[#e8dfd5] text-[#7a746e]"
              : "bg-[#2c2a29] text-white hover:bg-[#1a1918]"
          }`}
        >
          {inCart ? "Added to Cart" : <><ShoppingCart weight="bold" size={16} /> Add to Cart</>}
        </button>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-[0_2px_10px_rgba(44,42,41,0.04)]">
      <div className="aspect-[3/4] bg-[#ebdcd0] animate-pulse" />
      <div className="p-4 space-y-2.5">
        <div className="h-3 w-1/3 bg-[#f0e9e1] rounded animate-pulse" />
        <div className="h-4 w-4/5 bg-[#f0e9e1] rounded animate-pulse" />
        <div className="h-4 w-1/2 bg-[#f0e9e1] rounded animate-pulse" />
      </div>
    </div>
  );
}

export default function TabShop() {
  const [filter, setFilter] = useState("All");
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = async (category, offset) => {
    const d = await api.products({ category: category === "All" ? "" : category, limit: PAGE, offset });
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
      {/* Category filters (live from the catalogue) */}
      <div className="flex gap-2 mb-8 overflow-x-auto hide-scrollbar pb-2">
        {chips.map((b) => (
          <button
            key={b}
            data-testid={`shop-filter-${b}`}
            onClick={() => setFilter(b)}
            className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${
              filter === b
                ? "bg-[#2c2a29] text-white shadow-md"
                : "bg-white text-[#7a746e] hover:bg-[#f5ece4] border border-[#f0e9e1]"
            }`}
          >
            {b}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-6 rounded-xl bg-[#fdecea] border border-[#f5c6c0] text-[#b3261e] text-sm font-medium px-4 py-3">
          Couldn't load the boutique right now — {error}
        </div>
      )}

      {/* Product Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6 lg:gap-8 mb-8">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : items.map((p) => <ProductCard key={p.sku} product={p} />)}
        {!loading && !error && items.length === 0 && (
          <div className="col-span-full py-12 text-center text-[#7a746e]">
            Nothing in this category right now — check back soon.
          </div>
        )}
      </div>

      {!loading && hasMore && (
        <div className="text-center mb-16">
          <button
            data-testid="btn-load-more"
            onClick={loadMore}
            disabled={loadingMore}
            className="px-8 py-3 rounded-xl font-bold text-sm bg-white border border-[#e8dfd5] text-[#2c2a29] hover:bg-[#f5ece4] transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more styles"}
          </button>
        </div>
      )}

      {/* Shoppable UGC (sample community content) */}
      <div>
        <h2 className="text-2xl font-bold text-[#2c2a29] mb-6">Shoppable Looks from the Community</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {posts.slice(0, 2).map((post) => (
            <ShoppableLook key={post.id} post={post} />
          ))}
        </div>
      </div>
    </div>
  );
}
