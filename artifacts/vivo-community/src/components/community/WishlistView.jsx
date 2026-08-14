import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Heart, ShoppingBag, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { ImagePlaceholder, btnPrimary, kes, MAX_PER_ORDER } from "./ui";

const displaySize = (s) => (s === "F" ? "One Size" : s);

// Short-lived client cache of product details so reopening the wishlist
// doesn't refetch every line (the server caches too, but each hit still
// counts against the public throttle). Bounded so it can't grow unchecked.
const detailCache = new Map(); // sku -> { at, data }
const DETAIL_TTL = 60_000;
const HYDRATE_CONCURRENCY = 4;

/* ------------------------------------------------------------------ */
/* Size chooser — a wishlist piece has no size yet, so moving it to    */
/* the bag asks for one (unless the piece is genuinely one-size).      */
/* ------------------------------------------------------------------ */

function SizePickModal({ detail, onPick, onClose }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    const prev = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const els = panelRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!els || !els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      data-testid="size-pick-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Choose a size for ${detail.name}`}
      onClick={onClose}
      className="fixed inset-0 z-[80] bg-foreground/40 backdrop-blur-sm flex items-end sm:items-center justify-center animate-in fade-in duration-200"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-background w-full sm:max-w-md rounded-t sm:rounded p-6 sm:p-8 animate-in slide-in-from-bottom-4 duration-300"
      >
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-serif text-2xl text-foreground">Choose your size</h3>
          <button
            ref={closeRef}
            data-testid="size-pick-close"
            aria-label="Close size chooser"
            onClick={onClose}
            className="w-11 h-11 -mr-2 -mt-2 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-muted-foreground text-[13px] mb-6 line-clamp-1">{detail.name}</p>
        <div className="flex flex-wrap gap-2 mb-2">
          {detail.sizes.map((s) => {
            const dead = !s.in_stock;
            return (
              <button
                key={s.sku}
                data-testid={`size-pick-${s.size}`}
                disabled={dead}
                onClick={() => onPick(s)}
                className={`min-w-[52px] h-11 px-3 rounded border text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                  dead
                    ? "border-border/60 bg-secondary/40 text-muted-foreground/50 line-through cursor-not-allowed"
                    : "border-border bg-background text-foreground hover:border-foreground"
                }`}
              >
                {displaySize(s.size)}
              </button>
            );
          })}
        </div>
        <p className="text-[12px] text-muted-foreground mt-4">
          Tap a size and it goes straight to your bag.
        </p>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Wishlist line                                                       */
/* ------------------------------------------------------------------ */

function StockLine({ det }) {
  if (!det || det.state === "loading") {
    return <span className="inline-block h-3 w-24 bg-secondary rounded animate-pulse" aria-label="Checking stock" />;
  }
  if (det.state === "err") {
    return <span className="text-[12px] text-muted-foreground">Couldn't check stock right now</span>;
  }
  const d = det.data;
  if (!d.in_stock) return <span className="text-[12px] font-medium text-muted-foreground">Out of stock</span>;
  const avail = (d.sizes || []).filter((s) => s.in_stock);
  // Refined scarcity only — exact badge phrase, never counts or "almost gone"
  // embellishments; shown only when every size still available runs low.
  if (avail.length > 0 && avail.every((s) => s.low)) {
    return <span className="text-[12px] font-medium text-primary-ink">Selling fast</span>;
  }
  return <span className="text-[12px] font-medium text-foreground/70">In stock</span>;
}

function WishLine({ item, det, onOpen, onMove, onRemove }) {
  const [imgFailed, setImgFailed] = useState(false);
  const image = det?.data?.images?.[0] || item.image || "";
  const price = det?.data?.price ?? item.price;
  const canMove = det?.state === "ok" && det.data.in_stock;

  return (
    <div data-testid={`wishlist-line-${item.sku}`} className="flex gap-4 py-6">
      <button
        onClick={onOpen}
        aria-label={`View ${item.name}`}
        className="w-24 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {image && !imgFailed ? (
          <img
            src={image}
            alt={item.name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="w-24 aspect-[3/4] object-contain rounded-sm bg-secondary"
          />
        ) : (
          <ImagePlaceholder aspectRatio="aspect-[3/4]" text="" className="w-24" />
        )}
      </button>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              onClick={onOpen}
              className="text-left font-serif text-[15px] text-foreground leading-snug line-clamp-2 hover:underline underline-offset-4 decoration-border rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {item.name}
            </button>
            {item.color && <div className="text-[12px] text-muted-foreground mt-1 truncate">{item.color}</div>}
            <div className="text-[14px] font-medium text-foreground mt-1.5">{kes(price)}</div>
            <div className="mt-1.5"><StockLine det={det} /></div>
          </div>
          <button
            data-testid={`wishlist-remove-${item.sku}`}
            aria-label={`Remove ${item.name} from wishlist`}
            onClick={onRemove}
            className="w-11 h-11 -mt-2 -mr-2 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Trash2 size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="mt-auto pt-3">
          <button
            data-testid={`wishlist-move-${item.sku}`}
            disabled={!canMove}
            onClick={onMove}
            className="h-10 px-5 rounded bg-primary text-primary-foreground text-[13px] font-medium inline-flex items-center gap-2 transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <ShoppingBag size={14} /> Move to Bag
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function WishlistView({ onBack, onShop, onOpenProduct }) {
  const { items, count, remove } = useWishlist();
  const { add } = useCart();
  const mountedRef = useRef(true);
  const inFlight = useRef(new Set());
  const [picker, setPicker] = useState(null); // {item, data} while choosing size
  // sku -> {state: "loading"|"ok"|"err", data} — seeded from the short-lived
  // module cache so reopening the page doesn't refetch everything.
  const [details, setDetails] = useState(() => {
    const seed = {};
    const now = Date.now();
    items.forEach((i) => {
      const c = detailCache.get(i.sku);
      if (c && now - c.at < DETAIL_TTL) seed[i.sku] = { state: "ok", data: c.data };
    });
    return seed;
  });

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Live stock + sizes per saved piece (needed for stock status and for
  // Move to Bag). Fetched through a small worker pool so a long list can't
  // burst-fan-out against the public PDP throttle. NOTE: in-flight fetches
  // must survive effect re-runs (they're keyed off inFlight, and only an
  // unmount — via mountedRef — stops their results from landing).
  useEffect(() => {
    const missing = items.filter((i) => !details[i.sku] && !inFlight.current.has(i.sku));
    if (!missing.length) return;
    missing.forEach((m) => inFlight.current.add(m.sku));
    setDetails((d) => {
      const next = { ...d };
      missing.forEach((m) => { if (!next[m.sku]) next[m.sku] = { state: "loading" }; });
      return next;
    });
    let idx = 0;
    const worker = async () => {
      while (idx < missing.length) {
        const m = missing[idx++];
        try {
          const data = await api.product(m.sku);
          if (detailCache.size > 300) detailCache.clear(); // bound the cache
          detailCache.set(m.sku, { at: Date.now(), data });
          if (mountedRef.current) setDetails((d) => ({ ...d, [m.sku]: { state: "ok", data } }));
        } catch {
          if (mountedRef.current) setDetails((d) => ({ ...d, [m.sku]: { state: "err" } }));
        } finally {
          inFlight.current.delete(m.sku);
        }
      }
    };
    Array.from({ length: Math.min(HYDRATE_CONCURRENCY, missing.length) }, worker);
  }, [items, details]);

  const commit = (item, data, sizeRow) => {
    add({
      key: sizeRow.sku,
      sku: data.sku,
      name: data.name,
      color: data.color,
      size: displaySize(sizeRow.size),
      qty: 1,
      price: data.price,
      image: data.images?.[0] || item.image || "",
      maxStock: MAX_PER_ORDER,
    });
    remove(item.sku); // it moved — a move, not a copy
    setPicker(null);
  };

  const moveToBag = (item) => {
    const det = details[item.sku];
    if (det?.state !== "ok" || !det.data.in_stock) return;
    const sizes = det.data.sizes || [];
    // Genuinely one-size pieces skip the chooser; everything else asks.
    if (sizes.length === 1 && sizes[0].in_stock) commit(item, det.data, sizes[0]);
    else setPicker({ item, data: det.data });
  };

  return (
    <div data-testid="wishlist-view" className="animate-in fade-in duration-500 max-w-3xl mx-auto">
      <button
        data-testid="wishlist-back"
        onClick={onBack}
        className="flex items-center gap-2 min-h-[44px] mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <ArrowLeft size={15} /> Continue shopping
      </button>
      <h2 className="font-serif text-3xl text-foreground mb-8">
        Your Wishlist{count > 0 ? ` (${count})` : ""}
      </h2>

      {items.length === 0 ? (
        <div data-testid="wishlist-empty" className="text-center py-16 max-w-sm mx-auto">
          <Heart size={32} strokeWidth={1.2} className="mx-auto mb-5 text-muted-foreground/40" />
          <h3 className="font-serif text-xl text-foreground mb-2">Your wishlist is empty</h3>
          <p className="text-muted-foreground text-[14px] leading-relaxed mb-8">
            Tap the heart on any piece you love and it will wait for you here.
          </p>
          <button onClick={onShop} className={btnPrimary}>Explore the Collection</button>
        </div>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {items.map((item) => (
            <WishLine
              key={item.sku}
              item={item}
              det={details[item.sku]}
              onOpen={() => onOpenProduct(item.sku)}
              onMove={() => moveToBag(item)}
              onRemove={() => remove(item.sku)}
            />
          ))}
        </div>
      )}

      {items.length > 0 && (
        <p className="text-[12px] text-muted-foreground leading-relaxed mt-6 text-center">
          Saved on this device · Stock shown live, so favourites can sell through — move the ones you love
        </p>
      )}

      {picker && (
        <SizePickModal
          detail={picker.data}
          onPick={(sizeRow) => commit(picker.item, picker.data, sizeRow)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
