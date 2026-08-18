import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { btnPrimary } from "./ui";

/* ------------------------------------------------------------------ */
/* Shop filter model                                                   */
/* ------------------------------------------------------------------ */

// Default to Women's so men's pieces don't appear in the initial grid.
// The toggle always lets shoppers switch to All or Men's explicitly.
export const emptyFilters = () => ({
  cats: [], sizes: [], colors: [], bands: [], brands: [], prints: [],
  gender: "women",   // "women" | "" (all) | "men"
});

export const countActive = (f) =>
  f.cats.length + f.sizes.length + f.colors.length +
  f.bands.length + f.brands.length + f.prints.length;
  // gender is a top-level toggle (always visible), not counted in the drawer badge

// Filter state -> api.products params. When the selection is JUST one
// category (the pills' fast path) send the legacy single-category param so
// the server's shared response cache still applies to pill browsing.
export const filtersToParams = (f, extra = {}) => {
  // Legacy single-category fast path: only when exactly one category and NO
  // other drawer filters AND no gender — so the server's shared cache applies.
  const onlyCat = f.cats.length === 1 && countActive(f) === 1 && !f.gender;
  return {
    ...(onlyCat ? { category: f.cats[0] } : { categories: f.cats }),
    sizes: f.sizes,
    colors: f.colors,
    priceBands: f.bands,
    brands: f.brands,
    prints: f.prints,
    gender: f.gender || "",
    ...extra,
  };
};

// Style-Quiz size_range ids -> human labels for the "My size" chip. The
// concrete size list behind each range comes from the facets payload
// (size_ranges) so the server owns that canon.
export const MY_SIZE_LABELS = {
  xs_s: "XS – S",
  m_l: "M – L",
  xl_2x: "XL – 2X",
  "3x_up": "3X +",
};

const displaySize = (s) => (s === "F" ? "One Size" : s);
const printLabel = (p) => (p === "Print" ? "Prints" : "Plains");

// Decorative dots for the colour-family chips (families are keyword buckets
// server-side; these hexes are just a visual hint, not product colours).
const SWATCHES = {
  Black: "#141414",
  "White & Cream": "#f4efe4",
  Blue: "#274690",
  Green: "#2f6b3a",
  Red: "#a3282e",
  Pink: "#e585a5",
  Orange: "#e06a2b",
  Yellow: "#e0b23a",
  Purple: "#6d4a8f",
  Brown: "#7a4f2d",
  Neutrals: "#cdbca2",
  Grey: "#8a8f98",
};

const chipCls = (active) =>
  `inline-flex items-center gap-1.5 px-3.5 h-9 rounded-sm text-[12px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
    active
      ? "border-primary bg-primary/10 text-primary-ink"
      : "border-border bg-background text-foreground hover:bg-secondary"
  }`;

function Group({ title, children }) {
  return (
    <div className="py-4 border-b border-border last:border-b-0">
      <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">{title}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Filter drawer — bottom sheet on mobile, centered panel on desktop.  */
/* Edits a DRAFT owned by the parent (so the live count effect can     */
/* watch it); nothing applies to the grid until "Show N styles".       */
/* ------------------------------------------------------------------ */

export function FilterSheet({ open, onClose, facets, draft, setDraft, count, counting, onApply }) {
  const sheetRef = useRef(null);

  // Modal manners: lock (and later RESTORE) body scroll, move focus into the
  // sheet, trap Tab inside it, and hand focus back to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      const first = sheetRef.current?.querySelector("[data-autofocus]") || sheetRef.current;
      first?.focus?.();
    }, 0);
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !sheetRef.current) return;
      const list = Array.from(
        sheetRef.current.querySelectorAll('button, select, [href], [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!sheetRef.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !draft) return null;

  const tog = (key, val) =>
    setDraft((d) => ({
      ...d,
      [key]: d[key].includes(val) ? d[key].filter((x) => x !== val) : [...d[key], val],
    }));
  const n = countActive(draft);

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Filter styles" data-testid="shop-filter-sheet">
      <div className="absolute inset-0 bg-foreground/50" onClick={onClose} />
      <div ref={sheetRef} tabIndex={-1} className="absolute inset-x-0 bottom-0 sm:inset-0 sm:m-auto sm:max-w-xl sm:h-fit max-h-[85vh] sm:max-h-[80vh] bg-background rounded-t-lg sm:rounded-lg shadow-xl flex flex-col outline-none animate-in slide-in-from-bottom sm:zoom-in-95 duration-300">
        <div className="flex items-center justify-between px-5 h-14 border-b border-border shrink-0">
          <div className="font-serif text-lg text-foreground">Filter</div>
          <button
            data-testid="filter-close"
            data-autofocus
            onClick={onClose}
            aria-label="Close filters"
            className="w-10 h-10 -mr-2 rounded-full flex items-center justify-center hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 flex-grow">
          {!facets ? (
            <div className="py-10 text-center text-muted-foreground text-sm">Loading options…</div>
          ) : (
            <>
              <Group title="Category">
                {facets.categories.map((c) => (
                  <button key={c.name} type="button" data-testid={`filter-chip-cats-${c.name}`} aria-pressed={draft.cats.includes(c.name)} onClick={() => tog("cats", c.name)} className={chipCls(draft.cats.includes(c.name))}>
                    {c.name}
                  </button>
                ))}
              </Group>
              <Group title="Size">
                {facets.sizes.map((s) => (
                  <button key={s.name} type="button" data-testid={`filter-chip-sizes-${s.name}`} aria-pressed={draft.sizes.includes(s.name)} onClick={() => tog("sizes", s.name)} className={chipCls(draft.sizes.includes(s.name))}>
                    {displaySize(s.name)}
                  </button>
                ))}
              </Group>
              <Group title="Colour">
                {facets.colors.map((c) => (
                  <button key={c.name} type="button" data-testid={`filter-chip-colors-${c.name}`} aria-pressed={draft.colors.includes(c.name)} onClick={() => tog("colors", c.name)} className={chipCls(draft.colors.includes(c.name))}>
                    <span className="w-3 h-3 rounded-full border border-border/60 shrink-0" style={{ backgroundColor: SWATCHES[c.name] || "#ccc" }} />
                    {c.name}
                  </button>
                ))}
              </Group>
              <Group title="Price">
                {facets.price_bands.map((b) => (
                  <button key={b.id} type="button" data-testid={`filter-chip-bands-${b.id}`} aria-pressed={draft.bands.includes(b.id)} onClick={() => tog("bands", b.id)} className={chipCls(draft.bands.includes(b.id))}>
                    {b.label}
                  </button>
                ))}
              </Group>
              <Group title="Brand">
                {facets.brands.map((b) => (
                  <button key={b.name} type="button" data-testid={`filter-chip-brands-${b.name}`} aria-pressed={draft.brands.includes(b.name)} onClick={() => tog("brands", b.name)} className={chipCls(draft.brands.includes(b.name))}>
                    {b.name}
                  </button>
                ))}
              </Group>
              <Group title="Print">
                {facets.prints.map((p) => (
                  <button key={p.name} type="button" data-testid={`filter-chip-prints-${p.name}`} aria-pressed={draft.prints.includes(p.name)} onClick={() => tog("prints", p.name)} className={chipCls(draft.prints.includes(p.name))}>
                    {printLabel(p.name)}
                  </button>
                ))}
              </Group>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 px-5 py-4 border-t border-border shrink-0 bg-background rounded-b-lg">
          <button
            data-testid="filter-clear-all"
            onClick={() => setDraft(emptyFilters())}
            disabled={n === 0}
            className="shrink-0 px-3 h-11 text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Clear all
          </button>
          <button data-testid="filter-apply" onClick={() => onApply(draft)} className={btnPrimary + " flex-1"}>
            {counting
              ? "Show styles…"
              : typeof count === "number"
                ? `Show ${count} ${count === 1 ? "style" : "styles"}`
                : "Show styles"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Applied filters — removable chips above the grid                    */
/* ------------------------------------------------------------------ */

export function AppliedChips({ filters, facets, onChange, className = "" }) {
  const bandLabel = (id) => facets?.price_bands?.find((b) => b.id === id)?.label || id;
  const groups = [
    ["cats", (v) => v],
    ["sizes", displaySize],
    ["colors", (v) => v],
    ["bands", bandLabel],
    ["brands", (v) => v],
    ["prints", printLabel],
  ];
  const chips = groups.flatMap(([g, lab]) => filters[g].map((v) => ({ g, v, label: lab(v) })));
  if (!chips.length) return null;
  return (
    <div data-testid="applied-filter-chips" className={`flex flex-wrap items-center gap-2 ${className}`}>
      {chips.map(({ g, v, label }) => (
        <span key={g + v} className="inline-flex items-center gap-1 pl-3 pr-1.5 h-8 rounded-sm bg-secondary text-[12px] font-medium text-foreground">
          {label}
          <button
            data-testid={`chip-remove-${g}-${v}`}
            aria-label={`Remove ${label} filter`}
            onClick={() => onChange({ ...filters, [g]: filters[g].filter((x) => x !== v) })}
            className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <button
        data-testid="chips-clear-all"
        onClick={() => onChange(emptyFilters())}
        className="text-[12px] font-medium text-primary-ink hover:underline px-1 h-8 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Clear all
      </button>
    </div>
  );
}
