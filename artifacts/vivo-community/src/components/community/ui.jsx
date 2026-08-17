import React, { useState } from 'react';
import { Minus, Plus, ChevronRight } from 'lucide-react';

export const kes = (n) => "KES " + Math.round(Number(n) || 0).toLocaleString("en-KE");

/* Brand image assets (campaign photography + the official logo PNG) live in
   public/assets/brand — always resolve through BASE_URL so the /app/ mount
   keeps working. */
export const brandAsset = (name) => `${import.meta.env.BASE_URL}assets/brand/${name}`;

/* Official Vivo logo — the uploaded brand PNG (white wordmark on the
   Pantone 021C field), never re-typed text. Same component API as before
   so every call site keeps working. */
export function VivoLogo({ size = "md", className = "" }) {
  const h = { sm: "h-8", md: "h-10", lg: "h-14" }[size] || "h-10";
  return (
    <img
      src={brandAsset("vivo-logo.png")}
      alt="Vivo"
      draggable={false}
      className={`${h} w-auto rounded select-none ${className}`}
    />
  );
}

/* Vivo Johari programme wordmark — same Century Gothic treatment as the
   Vivo logotype (regular weight, never bold), letterspaced caps. "Johari"
   is Swahili for jewel; pass withVivo when the orange Vivo field isn't
   already sitting right beside it. */
export function JohariWordmark({ withVivo = false, className = "" }) {
  return (
    <span className={`font-logo font-normal uppercase tracking-[0.3em] leading-none ${className}`}>
      {withVivo ? "Vivo Johari" : "Johari"}
    </span>
  );
}

export function QtyStepper({ value, min = 1, max = 99, onChange, compact = false, idPrefix = "qty" }) {
  const btn = `${compact ? "w-10 h-10" : "w-11 h-11"} flex items-center justify-center text-foreground disabled:opacity-30 disabled:pointer-events-none hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset`;
  return (
    <div className="inline-flex items-center border border-border rounded bg-background">
      <button type="button" data-testid={`${idPrefix}-minus`} aria-label="Decrease quantity"
        disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className={btn}>
        <Minus size={14} />
      </button>
      <span data-testid={`${idPrefix}-value`} aria-live="polite"
        className="min-w-[2.5rem] text-center text-[15px] font-medium tabular-nums">{value}</span>
      <button type="button" data-testid={`${idPrefix}-plus`} aria-label="Increase quantity"
        disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className={btn}>
        <Plus size={14} />
      </button>
    </div>
  );
}

export function TierBadge({ tier, className = "" }) {
  const gradients = {
    // Gemstone treatments — jewellery, never cartoon gems, every stone from
    // East African soil: Tsavorite's vivid green, Ruby's warm depth,
    // Tanzanite's luminous violet-blue.
    Tsavorite: "from-[#D7EEDD] via-[#EDF8EF] to-[#AEDDBE] text-[#1E5B3C]",
    Ruby:      "from-[#E8B9C0] via-[#F3D3D4] to-[#DFA3B0] text-[#701C31]",
    Tanzanite: "from-[#D5DAF6] via-[#F1F0FE] to-[#B4BDF0] text-[#383C82]",
  };
  return (
    <span className={`px-2.5 py-1 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-gradient-to-tr ${gradients[tier] || gradients.Tsavorite} border border-white/60 shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${className}`}>
      {tier}
    </span>
  );
}

/* One order can carry at most this many units of a single size — bag
   quantity caps must never mirror exact stock (counts are hidden shop-wide,
   including in API payloads). */
export const MAX_PER_ORDER = 5;

/* Soft merchandising badge — replaces numeric scarcity ("Only N left" is
   banned customer-side). Charcoal-on-cream chip in the house style;
   "Selling fast" carries the accessible orange accent via text-primary-ink.
   A piece never shows more than one badge (the API sends a single value). */
export function MerchBadge({ badge, testId, className = "" }) {
  if (badge !== "selling_fast" && badge !== "best_seller") return null;
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center bg-background/95 backdrop-blur border border-border rounded-sm px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${
        badge === "selling_fast" ? "text-primary-ink" : "text-foreground"
      } ${className}`}
    >
      {badge === "selling_fast" ? "Selling fast" : "Best seller"}
    </span>
  );
}

export function PointsAction({ onClick, children, points = 10, className = "" }) {
  const [floats, setFloats] = useState([]);
  
  const handleClick = (e) => {
    const id = Date.now();
    setFloats(prev => [...prev, id]);
    setTimeout(() => {
      setFloats(prev => prev.filter(f => f !== id));
    }, 1000);
    if(onClick) onClick(e);
  };
  
  return (
    <div className={`relative inline-block ${className}`}>
      <div onClick={handleClick} className="cursor-pointer h-full w-full">{children}</div>
      {floats.map(id => (
        <div key={id} className="absolute -top-6 left-1/2 -translate-x-1/2 text-primary-ink font-bold text-sm pointer-events-none animate-in slide-in-from-bottom-3 fade-in duration-300 ease-out whitespace-nowrap z-50">
          +{points}
        </div>
      ))}
    </div>
  );
}

export function Avatar({ initials, tier, size = "md" }) {
  const sizes = {
    sm: "w-8 h-8 text-xs",
    md: "w-11 h-11 text-sm",
    lg: "w-16 h-16 text-lg",
  };
  const borders = {
    Tsavorite: "border-[#AEDDBE]",
    Ruby: "border-[#DFA3B0]",
    Tanzanite: "border-[#BFC7F1]",
  };
  return (
    <div className={`${sizes[size]} shrink-0 rounded-sm flex items-center justify-center bg-secondary text-secondary-foreground font-serif tracking-widest border border-border ${tier ? borders[tier] : ""}`}>
      {initials}
    </div>
  );
}

export function ImagePlaceholder({ aspectRatio = "aspect-[4/5]", text, className = "" }) {
  return (
    <div className={`w-full bg-secondary/50 rounded flex flex-col items-center justify-center text-muted-foreground/60 p-4 text-center border border-border/50 ${aspectRatio} ${className}`}>
      <span className="font-serif italic text-lg">{text || "Image"}</span>
    </div>
  );
}

/* Labeled feed-section header (Reels, News, Just Landed…). The kicker is the
   one place orange text is allowed — always via text-primary-ink. */
export function SectionHeader({ kicker, title, sub, action, onAction, actionTestId }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">{kicker}</div>
        <h3 className="font-serif text-xl sm:text-2xl text-foreground leading-tight">{title}</h3>
        {sub && <p className="text-[13px] text-muted-foreground mt-1">{sub}</p>}
      </div>
      {action && (
        <button
          data-testid={actionTestId}
          onClick={onAction}
          className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5 min-h-[44px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {action} <ChevronRight size={12} />
        </button>
      )}
    </div>
  );
}

export const btnPrimary = "h-11 w-full px-6 rounded bg-primary text-primary-foreground font-medium text-[15px] flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";
export const btnSecondary = "h-11 w-full px-6 rounded bg-background border border-border text-foreground font-medium text-[15px] flex items-center justify-center gap-2 transition-all hover:bg-muted active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";
export const inputCls = "h-12 rounded bg-background border border-border px-4 text-[15px] text-foreground placeholder-muted-foreground outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary";
export const cardCls = "bg-card text-card-foreground rounded border border-border shadow-[0_4px_24px_rgba(0,0,0,0.02)]";
