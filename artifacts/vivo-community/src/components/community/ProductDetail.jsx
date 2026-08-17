import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Heart, ShoppingBag, Ruler, X, ChevronDown, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { Avatar, TierBadge, ImagePlaceholder, MerchBadge, QtyStepper, btnPrimary, btnSecondary, kes, MAX_PER_ORDER } from "./ui";
import { fitFor } from "./mockData";

const displaySize = (s) => (s === "F" ? "One Size" : s);

/* ------------------------------------------------------------------ */
/* Gallery                                                             */
/* ------------------------------------------------------------------ */

/** Full-size photo overlay — fashion shots are tall, so the grid letterboxes
 *  them and this shows every pixel. Portaled to <body> so no transformed
 *  ancestor can trap the fixed positioning. */
function Lightbox({ src, alt, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    const prev = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (prev && typeof prev.focus === "function") prev.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      data-testid="pdp-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} — full size`}
      onClick={onClose}
      className="fixed inset-0 z-[90] bg-foreground/95 flex items-center justify-center p-4 sm:p-10 cursor-zoom-out animate-in fade-in duration-200"
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        ref={closeRef}
        data-testid="pdp-lightbox-close"
        aria-label="Close full-size photo"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 w-11 h-11 rounded-full bg-background/10 text-background flex items-center justify-center hover:bg-background/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
      >
        <X size={20} />
      </button>
    </div>,
    document.body
  );
}

function Gallery({ images, name, wish, onWish }) {
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState({});
  const [zoom, setZoom] = useState(null); // src currently open full-size
  const scroller = useRef(null);

  useEffect(() => { setActive(0); setFailed({}); setZoom(null); }, [images]);

  const good = images.filter((_, i) => !failed[i]);
  const markFailed = (i) => {
    setFailed((f) => ({ ...f, [i]: true }));
    // If the failed image is the one open full-size, close the lightbox so
    // it never shows a broken photo.
    setZoom((z) => (z === images[i] ? null : z));
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !el.clientWidth) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    if (idx !== active) setActive(idx);
  };
  const scrollTo = (i) => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setActive(i);
  };

  const wishBtn = (
    <button
      data-testid="pdp-wishlist"
      aria-label={wish ? "Remove from wishlist" : "Add to wishlist"}
      aria-pressed={wish}
      onClick={onWish}
      className="absolute top-3 right-3 z-10 w-11 h-11 rounded-full bg-background/85 backdrop-blur flex items-center justify-center shadow-sm hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Heart size={18} strokeWidth={1.5} className={wish ? "fill-primary text-primary-ink" : "text-foreground"} />
    </button>
  );

  if (good.length === 0) {
    return (
      <div className="relative" data-testid="pdp-gallery">
        {wishBtn}
        <ImagePlaceholder aspectRatio="aspect-[3/4]" text={name} />
      </div>
    );
  }

  return (
    <div data-testid="pdp-gallery">
      {/* Mobile: swipeable, snap per image; tap opens full-size */}
      <div className="lg:hidden relative">
        {wishBtn}
        <div
          ref={scroller}
          onScroll={onScroll}
          className="flex overflow-x-auto snap-x snap-mandatory hide-scrollbar rounded bg-secondary"
        >
          {good.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`${name} — photo ${i + 1}`}
              loading={i === 0 ? "eager" : "lazy"}
              onError={() => markFailed(images.indexOf(src))}
              onClick={() => setZoom(src)}
              className="w-full shrink-0 snap-center aspect-[3/4] object-contain cursor-zoom-in"
            />
          ))}
        </div>
        {good.length > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4">
            {good.map((_, i) => (
              <button
                key={i}
                aria-label={`Go to photo ${i + 1}`}
                onClick={() => scrollTo(i)}
                className="w-11 h-11 -mx-3 flex items-center justify-center focus-visible:outline-none group"
              >
                <span className={`block w-2 h-2 rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-primary ${i === active ? "bg-primary" : "bg-border"}`} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop: thumbnail rail + main image (click to zoom) */}
      <div className="hidden lg:flex gap-4">
        {good.length > 1 && (
          <div className="flex flex-col gap-3 w-20 shrink-0">
            {good.map((src, i) => (
              <button
                key={src}
                aria-label={`Photo ${i + 1}`}
                onClick={() => setActive(i)}
                className={`aspect-[3/4] rounded-sm overflow-hidden border bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${i === active ? "border-foreground" : "border-border hover:border-muted-foreground"}`}
              >
                <img src={src} alt="" loading="lazy" className="w-full h-full object-contain" />
              </button>
            ))}
          </div>
        )}
        <div className="relative flex-1">
          {wishBtn}
          <button
            type="button"
            data-testid="pdp-zoom"
            aria-label="View full-size photo"
            onClick={() => setZoom(good[Math.min(active, good.length - 1)])}
            className="block w-full cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <img
              src={good[Math.min(active, good.length - 1)]}
              alt={name}
              onError={() => markFailed(images.indexOf(good[Math.min(active, good.length - 1)]))}
              className="w-full aspect-[3/4] object-contain rounded bg-secondary"
            />
          </button>
        </div>
      </div>

      {zoom && <Lightbox src={zoom} alt={name} onClose={() => setZoom(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Size guide modal                                                    */
/* ------------------------------------------------------------------ */

const SIZE_CHART = [
  ["XS", 82, 64, 90], ["S", 86, 68, 94], ["M", 92, 74, 100], ["L", 98, 80, 106],
  ["1X", 106, 88, 114], ["2X", 114, 96, 122], ["3X", 122, 104, 130], ["4X", 130, 112, 138],
];

function SizeGuide({ onClose }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);

  // Dialog focus management: focus in on open, trap Tab inside the panel,
  // ESC closes, and focus returns to the opener on unmount.
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
      data-testid="size-guide-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Size guide"
      onClick={onClose}
      className="fixed inset-0 z-[80] bg-foreground/40 backdrop-blur-sm flex items-end sm:items-center justify-center animate-in fade-in duration-200"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-background w-full sm:max-w-lg rounded-t sm:rounded p-6 sm:p-8 max-h-[85dvh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
      >
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="font-serif text-2xl text-foreground mb-1">Size Guide</h3>
            <p className="text-muted-foreground text-[13px]">Body measurements in centimetres</p>
          </div>
          <button
            ref={closeRef}
            data-testid="size-guide-close"
            aria-label="Close size guide"
            onClick={onClose}
            className="w-11 h-11 -mr-2 -mt-2 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={18} />
          </button>
        </div>
        <table className="w-full text-[14px] border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="py-2.5 pr-3 font-semibold">Size</th>
              <th className="py-2.5 pr-3 font-semibold">Bust</th>
              <th className="py-2.5 pr-3 font-semibold">Waist</th>
              <th className="py-2.5 font-semibold">Hip</th>
            </tr>
          </thead>
          <tbody>
            {SIZE_CHART.map(([sz, b, w, h]) => (
              <tr key={sz} className="border-b border-border/60">
                <td className="py-2.5 pr-3 font-medium text-foreground">{sz}</td>
                <td className="py-2.5 pr-3 text-foreground/80">{b}</td>
                <td className="py-2.5 pr-3 text-foreground/80">{w}</td>
                <td className="py-2.5 text-foreground/80">{h}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground text-[13px] leading-relaxed mt-5">
          Between sizes? Our stylists suggest sizing up for a relaxed drape, or
          check the community fit notes on each piece.
        </p>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Collapsible detail section                                          */
/* ------------------------------------------------------------------ */

function Section({ id, title, badge, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border">
      <button
        data-testid={`pdp-section-${id}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full min-h-[56px] py-3 flex items-center justify-between gap-4 text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="font-serif text-lg text-foreground flex items-baseline gap-3 min-w-0">
          <span className="truncate">{title}</span>
          {badge && (
            <span className="text-[11px] font-bold font-sans uppercase tracking-wider text-primary-ink shrink-0">{badge}</span>
          )}
        </span>
        <ChevronDown
          size={16}
          className={`text-muted-foreground shrink-0 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="pb-6 animate-in fade-in slide-in-from-top-1 duration-200">{children}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fit notes (community layer)                                         */
/* ------------------------------------------------------------------ */

function FitNotesBody({ fit, onSizeGuide }) {
  const seg = (pct, hot) => (
    <div className={`h-1.5 rounded-full transition-all ${hot ? "bg-primary" : "bg-border"}`} style={{ width: `${Math.max(pct, 4)}%` }} />
  );
  const major = Math.max(fit.small, fit.true, fit.large);
  return (
    <div data-testid="fit-notes">
      <p className="text-muted-foreground text-[13px] mb-5">Community fit notes from members who wear this style.</p>

      <div className="flex items-center gap-1.5 mb-2">
        {seg(fit.small, fit.small === major)}
        {seg(fit.true, fit.true === major)}
        {seg(fit.large, fit.large === major)}
      </div>
      <div className="flex justify-between text-[11px] uppercase tracking-wider text-muted-foreground mb-6">
        <span className={fit.small === major ? "text-foreground font-semibold" : ""}>Runs small {fit.small}%</span>
        <span className={fit.true === major ? "text-foreground font-semibold" : ""}>True to size {fit.true}%</span>
        <span className={fit.large === major ? "text-foreground font-semibold" : ""}>Runs large {fit.large}%</span>
      </div>

      <div className="space-y-4">
        {fit.comments.map((c) => (
          <div key={c.username} className="flex gap-3">
            {/* Privacy: username only; tier badge is opt-in */}
            <Avatar initials={c.initials} tier={c.showTier ? c.tier : undefined} size="sm" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <span className="text-[13px] font-semibold text-foreground">@{c.username}</span>
                {c.showTier && <TierBadge tier={c.tier} />}
                <span className="text-[11px] text-muted-foreground">wears {c.size}</span>
              </div>
              <p className="text-[13px] text-foreground/80 leading-relaxed">{c.text}</p>
            </div>
          </div>
        ))}
      </div>

      <button
        data-testid="fit-size-guide-link"
        onClick={onSizeGuide}
        className="flex items-center gap-1.5 min-h-[44px] mt-4 text-[13px] font-medium text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Ruler size={13} /> See the size guide
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PDP                                                                 */
/* ------------------------------------------------------------------ */

export default function ProductDetail({ sku, onBack, onOpenProduct, onTryOn, onOpenPage }) {
  const { add } = useCart();
  const { has, toggle } = useWishlist();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selSize, setSelSize] = useState(null);
  const [qty, setQty] = useState(1);
  const [hintOn, setHintOn] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [alsoLike, setAlsoLike] = useState([]);
  const sizeRef = useRef(null);
  const hintTimer = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setDetail(null);
    setSelSize(null);
    setQty(1);
    setHintOn(false);
    setAlsoLike([]);
    window.scrollTo({ top: 0 });
    api.product(sku)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sku]);

  useEffect(() => {
    if (!detail?.category) return;
    let alive = true;
    api.products({ category: detail.category, limit: 12 })
      .then((d) => {
        if (!alive) return;
        setAlsoLike((d.items || []).filter((i) => i.sku !== detail.sku).slice(0, 3));
      })
      .catch(() => { /* optional section */ });
    return () => { alive = false; };
  }, [detail?.category, detail?.sku]);

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const pickSize = (s) => {
    if (!s.in_stock) return;
    setSelSize(s);
    setQty((q) => Math.max(1, Math.min(q, MAX_PER_ORDER)));
    setHintOn(false);
  };

  const onAdd = () => {
    if (!detail || !detail.in_stock) return;
    if (!selSize) {
      setHintOn(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHintOn(false), 2400);
      sizeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    add({
      key: selSize.sku,
      sku: detail.sku,
      name: detail.name,
      color: detail.color,
      style_number: detail.style_number || "",
      size: displaySize(selSize.size),
      qty,
      price: detail.price,
      image: detail.images?.[0] || "",
      maxStock: MAX_PER_ORDER,
    });
  };

  const wish = detail ? has(detail.sku) : false;
  const toggleWish = () => {
    if (!detail) return;
    toggle({
      sku: detail.sku,
      name: detail.name,
      price: detail.price,
      image: detail.images?.[0] || "",
      color: detail.color || "",
      category: detail.category || "",
    });
  };

  if (loading) {
    return (
      <div data-testid="pdp-view" className="animate-in fade-in duration-300 max-w-5xl mx-auto">
        <div className="h-11 w-24 bg-secondary rounded animate-pulse mb-6" />
        <div className="grid lg:grid-cols-2 gap-10">
          <div className="aspect-[3/4] bg-secondary rounded animate-pulse" />
          <div className="space-y-4 pt-2">
            <div className="h-3 w-1/4 bg-secondary rounded animate-pulse" />
            <div className="h-8 w-3/4 bg-secondary rounded animate-pulse" />
            <div className="h-5 w-1/3 bg-secondary rounded animate-pulse" />
            <div className="h-24 w-full bg-secondary rounded animate-pulse mt-8" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div data-testid="pdp-view" className="max-w-md mx-auto text-center py-20">
        <p className="text-muted-foreground mb-6">Couldn't load this piece right now{error ? ` — ${error}` : ""}.</p>
        <button onClick={onBack} className={btnSecondary}>Back to the collection</button>
      </div>
    );
  }

  const out = !detail.in_stock;
  const lowSel = !!(selSize && selSize.low);
  const colorways = detail.colorways || [];
  const curCw = colorways.find((c) => c.color === detail.color);
  const colorLabel = curCw?.label || detail.color;
  const fit = fitFor(detail.sku);
  const descBits = [];
  const kind = (detail.subcategory || detail.category || "piece").toLowerCase();
  descBits.push(`A ${kind}${detail.color ? ` in ${detail.color.toLowerCase()}` : ""}`);
  if (detail.collection) descBits.push(`from the ${detail.collection} collection`);
  else if (detail.season) descBits.push(`from our ${detail.season} drop`);
  const description = `${descBits.join(", ")}. Designed in Nairobi to celebrate real curves — true to the photographs, and quality-checked before it ships.`;
  const fabricRows = [
    detail.fabric?.fiber_content && ["Fibre", detail.fabric.fiber_content],
    detail.fabric?.fabric_structure && ["Weave", detail.fabric.fabric_structure],
    detail.fabric?.gsm && ["Weight", `${detail.fabric.gsm} gsm`],
    detail.style_number && ["Style", detail.style_number],
    detail.color && ["Colour", detail.color],
    detail.collection && ["Collection", detail.collection],
    detail.season && ["Season", detail.season],
  ].filter(Boolean);

  return (
    <div data-testid="pdp-view" className="animate-in fade-in duration-500 max-w-5xl mx-auto">
      <button
        data-testid="pdp-back"
        onClick={onBack}
        className="flex items-center gap-2 min-h-[44px] mb-4 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <div className="grid lg:grid-cols-2 gap-8 lg:gap-14 mb-14">
        <Gallery images={detail.images || []} name={detail.name} wish={wish} onWish={toggleWish} />

        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">
            {detail.brand}{detail.category ? ` · ${detail.category}` : ""}
          </div>
          {detail.badge && (
            <div className="mb-3">
              <MerchBadge badge={detail.badge} testId="pdp-badge" />
            </div>
          )}
          <h1 data-testid="pdp-name" className="font-serif text-3xl sm:text-4xl text-foreground leading-tight mb-1.5">
            {detail.name}
          </h1>
          {detail.style_number && (
            <div data-testid="pdp-style-number" className="text-[12px] tracking-wide text-muted-foreground mb-2">
              Style {detail.style_number}
            </div>
          )}
          {colorLabel && (
            <div data-testid="pdp-color" className="text-[15px] text-foreground mb-4">{colorLabel}</div>
          )}
          <div data-testid="pdp-price" className="text-xl font-medium text-foreground mb-8">{kes(detail.price)}</div>

          {/* Colourways — swatches navigate to that colour's page */}
          {colorways.length > 1 && (
            <div className="mb-7" data-testid="pdp-colorways">
              <div className="flex items-baseline gap-2 mb-3">
                <span className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Colour</span>
                {colorLabel && (
                  <span data-testid="pdp-colorway-label" className="text-[15px] text-foreground font-medium">
                    {colorLabel}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {colorways.map((c) => {
                  const cur = c.color === detail.color;
                  return (
                    <button
                      key={c.sku}
                      data-testid={`colorway-${c.sku}`}
                      aria-label={`Colour ${c.label}${c.in_stock ? "" : " — sold out"}`}
                      aria-pressed={cur}
                      onClick={() => { if (!cur) onOpenProduct(c.sku); }}
                      className={`relative w-16 rounded-sm overflow-hidden border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                        cur ? "border-foreground" : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <img src={c.image} alt="" loading="lazy" className="w-full aspect-[3/4] object-contain bg-secondary" />
                      {!c.in_stock && (
                        <span className="absolute inset-x-0 bottom-0 bg-foreground/80 text-background text-[9px] uppercase tracking-wider text-center py-0.5">
                          Sold out
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Size selection */}
          <div
            ref={sizeRef}
            className={`rounded transition-shadow duration-300 ${hintOn ? "ring-2 ring-primary/70 ring-offset-4 ring-offset-background" : ""}`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[12px] font-bold uppercase tracking-wider text-foreground">
                Size{selSize ? ` — ${displaySize(selSize.size)}` : ""}
              </span>
              <button
                data-testid="size-guide-link"
                onClick={() => setGuideOpen(true)}
                className="flex items-center gap-1.5 min-h-[44px] text-[12px] font-medium text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Ruler size={13} /> Size guide
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.sizes.map((s) => {
                const sel = selSize?.sku === s.sku;
                const dead = !s.in_stock;
                return (
                  <button
                    key={s.sku}
                    data-testid={`size-option-${s.size}`}
                    disabled={dead}
                    aria-pressed={sel}
                    onClick={() => pickSize(s)}
                    className={`min-w-[52px] h-11 px-3 rounded border text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                      dead
                        ? "border-border/60 bg-secondary/40 text-muted-foreground/50 line-through cursor-not-allowed"
                        : sel
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-background text-foreground hover:border-foreground"
                    }`}
                  >
                    {displaySize(s.size)}
                  </button>
                );
              })}
            </div>
            {hintOn && (
              <p data-testid="size-hint" aria-live="polite" className="text-primary-ink text-[13px] font-medium mt-3">
                Please select your size first
              </p>
            )}
            {lowSel && (
              <p data-testid="pdp-selling-fast" className="text-primary-ink text-[12px] font-medium mt-3">
                Selling fast in {displaySize(selSize.size)}
              </p>
            )}
          </div>

          {/* Quantity */}
          <div className="flex items-center gap-5 mt-7 mb-7">
            <span className="text-[12px] font-bold uppercase tracking-wider text-foreground">Quantity</span>
            <QtyStepper value={qty} min={1} max={MAX_PER_ORDER} onChange={setQty} />
          </div>

          <button data-testid="add-to-cart-btn" onClick={onAdd} disabled={out} className={btnPrimary}>
            {out ? "Out of Stock" : <><ShoppingBag size={16} /> Add to Bag</>}
          </button>
          {/* Secondary store nudge — ONLY when the piece (or picked size)
              can't be bought online right now; online stays the hero. */}
          {(out || (selSize && !selSize.in_stock)) && typeof onOpenPage === "function" && (
            <button
              data-testid="pdp-check-stores"
              onClick={() => onOpenPage("stores")}
              className="w-full mt-2 text-[12px] text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-border transition-colors rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Not available online? Check nearby stores.
            </button>
          )}
          {/* Try It On sits right under Add to Bag with its own accent
              treatment — prototype-evaluation prominence, unmissable. */}
          {typeof onTryOn === "function" && (
            <button
              data-testid="pdp-tryon-btn"
              onClick={() => onTryOn(sku)}
              className="relative h-11 w-full px-6 mt-3 rounded border border-primary/50 bg-primary/5 text-primary-ink font-medium text-[15px] flex items-center justify-center gap-2 transition-all hover:bg-primary/10 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Sparkles size={16} /> Try It On — see it on you
              <span className="absolute -top-2 right-3 bg-primary-ink text-primary-foreground text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm">New</span>
            </button>
          )}

          <button
            data-testid="pdp-add-wishlist"
            onClick={toggleWish}
            aria-pressed={wish}
            className={`${btnSecondary} mt-3`}
          >
            <Heart size={16} className={wish ? "fill-primary text-primary-ink" : ""} />
            {wish ? "Saved to Wishlist" : "Add to Wishlist"}
          </button>

          {/* Details — collapsible, PDP-style */}
          <div className="mt-10 border-t border-border">
            <Section id="description" title="The Piece" defaultOpen>
              <p className="text-[15px] text-foreground/80 leading-relaxed">{description}</p>
            </Section>

            <Section id="fabric" title="Fabric & Care">
              {fabricRows.length > 0 && (
                <dl className="mb-4">
                  {fabricRows.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-6 py-2 border-b border-border/60 text-[14px]">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="text-foreground text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className="text-[14px] text-foreground/70 leading-relaxed">
                Machine wash cold on a gentle cycle, line-dry in shade, and iron cool if needed.
              </p>
            </Section>

            <Section id="fit" title="Fit & Sizing" badge={fit.verdict}>
              <FitNotesBody fit={fit} onSizeGuide={() => setGuideOpen(true)} />
            </Section>

            <Section id="delivery" title="Delivery & Returns">
              <div className="space-y-3 text-[14px] text-foreground/80 leading-relaxed">
                <p>Delivery across Kenya, with fees and timing shown at checkout.</p>
                <p>Free returns within 14 days — unworn, with tags on. You can also return or exchange in any Vivo store.</p>
                <p className="text-muted-foreground text-[13px]">Every order earns points on your Vivo Johari account.</p>
              </div>
            </Section>
          </div>
        </div>
      </div>

      {/* You may also like */}
      {alsoLike.length > 0 && (
        <section data-testid="also-like" className="border-t border-border mt-12 pt-10">
          <h3 className="font-serif text-xl text-foreground mb-6">You may also like</h3>
          <div className="grid grid-cols-3 gap-4 sm:gap-6">
            {alsoLike.map((p) => (
              <button
                key={p.sku}
                data-testid="also-like-card"
                onClick={() => onOpenProduct(p.sku)}
                className="text-left group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <div className="aspect-[3/4] rounded overflow-hidden bg-secondary mb-3">
                  <img
                    src={p.image_url}
                    alt={p.style_name}
                    loading="lazy"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div className="text-[13px] font-medium text-foreground leading-snug line-clamp-2 mb-1">{p.style_name}</div>
                <div className="text-[13px] text-muted-foreground">{kes(p.price)}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {guideOpen && <SizeGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
