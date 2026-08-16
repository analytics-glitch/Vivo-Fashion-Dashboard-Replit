/**
 * MerchStyleSearch — type-ahead style selector shared by Deep Dive + Store Detail tabs.
 *
 * Fetches the full style list once from /api/merch/styles, caches it in
 * module-level state (survives tab switches), and renders a search input
 * with a dropdown that filters by name or style number.
 *
 * Usage:
 *   <MerchStyleSearch value={styleNumber} onChange={n => setStyleNumber(n)} />
 *
 * Props:
 *   value    — currently selected style_number string
 *   onChange — (style_number: string, style_name: string) => void
 */
import React, { useEffect, useState, useRef, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

// Module-level cache so both Deep Dive and Store Detail share one fetch.
let _styleListCache = null;
let _styleListPromise = null;

/**
 * loadStyles — fetches the full style list once, caches it for the session.
 * Exported so MerchDeepDive can find a specific style
 * by style_number without needing a separate (unsupported) style_number filter
 * on the /api/merch/styles endpoint.
 */
export function loadStyles() {
  if (_styleListCache) return Promise.resolve(_styleListCache);
  if (_styleListPromise) return _styleListPromise;
  _styleListPromise = apiFetch("/merch/styles")
    .then(d => {
      _styleListCache = d.styles || [];
      _styleListPromise = null;
      return _styleListCache;
    })
    .catch(() => {
      _styleListPromise = null;
      return [];
    });
  return _styleListPromise;
}

/**
 * findStyleByNumber — looks up a single style from the cached list by
 * style_number. Returns undefined when not found.
 */
export const findStyleByNumber = (styleNumber) => {
  if (!styleNumber) return undefined;
  return (_styleListCache || []).find(s => s.style_number === styleNumber);
};

/** Normalize a string for fuzzy search (lower, strip extra space). */
const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const MerchStyleSearch = ({ value, onChange }) => {
  const [allStyles, setAllStyles] = useState(_styleListCache || []);
  const [query, setQuery]         = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen]           = useState(false);
  const [focused, setFocused]     = useState(false);
  const [loadingStyles, setLoadingStyles] = useState(!_styleListCache);
  const inputRef  = useRef(null);
  const dropRef   = useRef(null);

  // Load style list on mount.
  useEffect(() => {
    if (_styleListCache) {
      setAllStyles(_styleListCache);
      setLoadingStyles(false);
      return;
    }
    let mounted = true;
    loadStyles()
      .then(list => {
        if (mounted) setAllStyles(list);
      })
      .finally(() => {
        if (mounted) setLoadingStyles(false);
      });
    return () => { mounted = false; };
  }, []);

  // Keep typing responsive: filtering is local, but defer it until the user
  // pauses for 300ms so a long style list never recalculates on every keypress.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // When value changes externally, update the displayed name.
  const selectedStyle = useMemo(
    () => allStyles.find(s => s.style_number === value),
    [allStyles, value]
  );

  // Reset query when style changes from outside.
  useEffect(() => {
    if (!focused) setQuery("");
  }, [value, focused]);

  const displayText = focused ? query : (selectedStyle?.style_name || query);

  // Filtered dropdown list.
  const filtered = useMemo(() => {
    const q = norm(debouncedQuery);
    if (!q) return allStyles.slice(0, 60);
    return allStyles
      .filter(s => norm(s.style_name).includes(q) || norm(s.style_number).includes(q))
      .slice(0, 60);
  }, [allStyles, debouncedQuery]);

  // Close dropdown on outside click.
  useEffect(() => {
    const handle = (e) => {
      if (
        dropRef.current && !dropRef.current.contains(e.target) &&
        inputRef.current && !inputRef.current.contains(e.target)
      ) {
        setOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const handleSelect = (style) => {
    setOpen(false);
    setFocused(false);
    setQuery("");
    onChange?.(style.style_number, style.style_name);
  };

  const handleInput = (e) => {
    setQuery(e.target.value);
    setOpen(true);
  };

  const handleFocus = () => {
    setFocused(true);
    setQuery("");
    setOpen(true);
  };

  const handleClear = () => {
    setQuery("");
    setFocused(true);
    if (selectedStyle && !query) onChange?.("", "");
    inputRef.current?.focus();
    setOpen(true);
  };

  return (
    <div className="relative w-full max-w-sm" data-testid="merch-style-search">
      <div className="relative">
        <MagnifyingGlass
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        />
        <input
          ref={inputRef}
          type="text"
          className="w-full pl-8 pr-8 py-2 text-[13px] border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-all"
          placeholder="Search style name or number…"
          value={displayText}
          onChange={handleInput}
          onFocus={handleFocus}
          aria-label="Search styles"
          autoComplete="off"
        />
        {(query || selectedStyle) && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {open && (
        <div
          ref={dropRef}
          className="absolute top-full mt-1 left-0 right-0 z-50 bg-white border border-border rounded-lg shadow-xl max-h-72 overflow-y-auto"
        >
          {(loadingStyles || query !== debouncedQuery) && (
            <div className="px-3 py-2.5 text-[12px] text-muted flex items-center gap-2">
              <span className="w-3 h-3 rounded-full border-2 border-brand/30 border-t-brand animate-spin" aria-hidden="true" />
              Loading styles…
            </div>
          )}
          {!loadingStyles && query === debouncedQuery && filtered.length === 0 && (
            <div className="px-3 py-2.5 text-[12px] text-muted">No matching styles</div>
          )}
          {!loadingStyles && query === debouncedQuery && filtered.map(s => (
            <button
              key={s.style_number}
              type="button"
              onClick={() => handleSelect(s)}
              className={`w-full text-left px-3 py-2 hover:bg-panel/60 border-b border-line/50 last:border-0 transition-colors ${
                s.style_number === value ? "bg-brand/5" : ""
              }`}
            >
              <div className="text-[12.5px] font-semibold text-foreground leading-tight truncate">
                {s.style_name}
              </div>
              <div className="text-[10.5px] text-muted mt-0.5 flex items-center gap-2">
                <span className="font-mono">{s.style_number}</span>
                {s.brand && <span className="text-brand">{s.brand}</span>}
                {s.subcategory && <span>{s.subcategory}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default MerchStyleSearch;
