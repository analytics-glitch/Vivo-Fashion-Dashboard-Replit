import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, ShoppingBag } from "lucide-react";
import { api } from "@/lib/api";
import { useCart } from "@/context/CartContext";
import { kes, MAX_PER_ORDER } from "./ui";

// Mirror the PDP helper (never shows the raw "F" size code to shoppers).
const displaySize = (s) => (s === "F" ? "One Size" : s);

/**
 * Lightweight size-picker overlay that lets a shopper add a piece to their bag
 * directly from a grid card or rail card, without navigating to the full PDP.
 *
 * Portaled to <body> so no transformed ancestor can trap the fixed positioning
 * (see overlay-portal-stacking memory note).
 *
 * Props:
 *   sku           — the style-level SKU to fetch sizes for
 *   productName   — optimistic name shown while the detail loads
 *   productImage  — optimistic image shown while the detail loads
 *   productPrice  — optimistic price shown while the detail loads
 *   onClose       — close the overlay without adding
 *   onOpenProduct — (sku) → navigate to the full PDP
 */
export function QuickAddModal({ sku, productName, productImage, productPrice, onClose, onOpenProduct }) {
  const { add } = useCart();
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [selSize, setSelSize] = useState(null);
  const [hint, setHint]       = useState(false);
  const hintTimer = React.useRef(null);

  // Dismiss on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setDetail(null);
    setSelSize(null);
    api.product(sku)
      .then((d)  => { if (alive) { setDetail(d); setLoading(false); } })
      .catch(()  => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sku]);

  const handleAdd = () => {
    if (!detail?.in_stock) return;
    if (!selSize) {
      setHint(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(false), 2200);
      return;
    }
    add({
      key:          selSize.sku,
      sku:          detail.sku,
      name:         detail.name,
      color:        detail.color        || "",
      style_number: detail.style_number || "",
      size:         displaySize(selSize.size),
      qty:          1,
      price:        detail.price,
      image:        detail.images?.[0]  || productImage || "",
      maxStock:     MAX_PER_ORDER,
    });
    onClose();
  };

  const thumbSrc = detail?.images?.[0] || productImage;
  const displayName  = detail?.name  ?? productName;
  const displayPrice = detail?.price ?? productPrice;

  return createPortal(
    /* Backdrop — clicking it closes the modal */
    <div
      data-testid="quickadd-overlay"
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" aria-hidden="true" />

      {/* Panel — stop clicks here from bubbling to the backdrop */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Quick add ${displayName}`}
        className="relative w-full sm:max-w-sm bg-background rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 animate-in slide-in-from-bottom-4 sm:zoom-in-95 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X size={15} />
        </button>

        {/* Compact product summary */}
        <div className="flex gap-3 mb-4 pr-8">
          {thumbSrc && (
            <img
              src={thumbSrc}
              alt=""
              className="w-14 h-[74px] object-contain rounded-lg bg-secondary shrink-0"
            />
          )}
          <div className="min-w-0 flex flex-col justify-center">
            <div className="font-serif text-foreground text-[14px] leading-snug line-clamp-2 mb-1">
              {displayName}
            </div>
            <div className="text-[13px] font-medium text-foreground">{kes(displayPrice)}</div>
          </div>
        </div>

        {/* Size picker */}
        {loading ? (
          /* Skeleton while the sizes load */
          <div className="flex gap-2 mb-5">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 flex-1 bg-secondary rounded-lg animate-pulse" />
            ))}
          </div>
        ) : !detail?.in_stock ? (
          <p className="text-[13px] text-muted-foreground text-center py-2 mb-4">
            This piece is currently out of stock.
          </p>
        ) : (
          <>
            <div
              className={`text-[11px] font-bold uppercase tracking-wider mb-2 transition-colors ${
                hint ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {hint ? "Please pick a size" : "Select size"}
            </div>
            <div className="flex flex-wrap gap-2 mb-5">
              {detail.sizes.map((s) => {
                const oos = !s.in_stock;
                const sel = selSize?.sku === s.sku;
                return (
                  <button
                    key={s.sku}
                    data-testid={`quickadd-size-${s.sku}`}
                    disabled={oos}
                    onClick={() => { setSelSize(s); setHint(false); }}
                    aria-pressed={sel}
                    className={[
                      "h-10 px-3 min-w-[2.75rem] rounded-lg text-[13px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      oos
                        ? "border-border text-muted-foreground/40 line-through cursor-not-allowed"
                        : sel
                        ? "border-foreground bg-foreground text-background shadow-sm"
                        : "border-border hover:border-foreground/60",
                    ].join(" ")}
                  >
                    {displaySize(s.size)}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Add to Bag CTA */}
        <button
          data-testid="quickadd-confirm"
          disabled={!detail?.in_stock || loading}
          onClick={handleAdd}
          className="w-full h-12 rounded-xl bg-foreground text-background font-medium text-[13px] flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary mb-2.5"
        >
          <ShoppingBag size={15} strokeWidth={1.5} />
          Add to Bag
        </button>

        {/* Fallback to full PDP */}
        <button
          data-testid="quickadd-view-details"
          onClick={() => { onClose(); onOpenProduct?.(sku); }}
          className="w-full text-center text-[12px] text-muted-foreground hover:text-foreground transition-colors py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          View full details →
        </button>
      </div>
    </div>,
    document.body
  );
}
