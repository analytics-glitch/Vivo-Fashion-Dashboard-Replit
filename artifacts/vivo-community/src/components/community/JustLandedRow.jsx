import React from "react";
import { SectionHeader, MerchBadge, kes } from "./ui";

/* Horizontal shelf of the newest live pieces (the catalogue API already
   returns newest-first). Full-image treatment: object-contain, never cropped. */
export default function JustLandedRow({ products, onOpenProduct, onSeeAll, kicker = "Just landed", title = "New in the collection", sub = "The freshest pieces, straight off the production floor.", testId = "just-landed", idPrefix = "jl", actionTestId = "jl-see-all" }) {
  const items = (products || []).slice(0, 10);
  if (!items.length) return null;
  return (
    <section data-testid={testId}>
      <SectionHeader
        kicker={kicker}
        title={title}
        sub={sub}
        action="Shop all"
        onAction={onSeeAll}
        actionTestId={actionTestId}
      />
      <div className="flex gap-3 overflow-x-auto hide-scrollbar snap-x -mx-4 px-4 sm:mx-0 sm:px-0 pb-1">
        {items.map((p) => (
          <button
            key={p.sku}
            data-testid={`${idPrefix}-card-${p.sku}`}
            onClick={() => onOpenProduct?.(p.sku)}
            className="w-[160px] sm:w-[180px] shrink-0 snap-start text-left group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="relative aspect-[3/4] rounded overflow-hidden bg-secondary mb-2.5">
              <img
                src={p.image_url}
                alt={p.style_name}
                loading="lazy"
                className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-[1.02]"
              />
              <MerchBadge badge={p.badge} testId={`jl-badge-${p.sku}`} className="absolute bottom-2 left-2" />
            </div>
            <div className="font-serif text-[13px] leading-snug text-foreground line-clamp-2 mb-0.5">{p.style_name}</div>
            <div className="text-[13px] font-medium text-foreground">{kes(p.price)}</div>
          </button>
        ))}
      </div>
    </section>
  );
}
