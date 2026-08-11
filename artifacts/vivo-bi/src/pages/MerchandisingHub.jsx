import React, { createContext, useContext, useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { useFilters } from "@/lib/filters";
import { Loading } from "@/components/common";
import { apiFetch, comparePeriod } from "@/lib/api";

/**
 * Merchandising Hub — tabbed container for all 12 merchandising sub-pages.
 *
 * The hub shell:
 *   • reads the global filter bar (useFilters) and publishes a MerchFiltersContext
 *     that every tab component can consume via useMerchFilters()
 *   • keeps ?tab= in the URL so deep-links and back/forward work correctly
 *   • gates each tab via canAccessPage so roles without a tab's page-id never
 *     see that tab button
 *   • renders a sticky tab bar that sits flush under the top nav (top: var(--app-navbar-h))
 *
 * Sub-page components are lazily imported; each starts as a PlaceholderTab
 * until the feature task for that page ships.
 */

// ── Deep-dive navigation helper ───────────────────────────────────────────────
/**
 * navigateToDeepDive — shared helper that all tab components can import.
 * Navigates to ?tab=merch-deepdive&style=<styleNumber> so clicking any style
 * name anywhere in the hub lands on the Style Deep Dive page for that style.
 *
 * Usage (in a tab component):
 *   import { navigateToDeepDive } from "./MerchandisingHub";
 *   ...
 *   <button onClick={() => navigateToDeepDive(row.style_number, setSearchParams)}>
 *     {row.style_name}
 *   </button>
 *
 * @param {string}   styleNumber  — style_number to navigate to
 * @param {Function} setSearchParams — from useSearchParams()
 */
export const navigateToDeepDive = (styleNumber, setSearchParams) => {
  if (!styleNumber || !setSearchParams) return;
  setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    next.set("tab", "merch-deepdive");
    next.set("style", String(styleNumber));
    return next;
  });
};

// ── Filter context — published by the hub, consumed by tabs ──────────────────
/**
 * Shape: { brand, subcategory, countries, dateFrom, dateTo, dataVersion }
 * All fields are normalized to the string/array formats the /api/merch/* endpoints
 * accept directly so tab components can just spread them into their fetch params.
 */
export const MerchFiltersContext = createContext(null);

/** Convenience hook for tab components to consume the hub's filter context. */
export const useMerchFilters = () => {
  const ctx = useContext(MerchFiltersContext);
  if (!ctx) throw new Error("useMerchFilters must be used inside MerchandisingHub");
  return ctx;
};

// ── Placeholder component — shown for tabs not yet built ─────────────────────
const PlaceholderTab = ({ name }) => (
  <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
    <div className="w-12 h-12 rounded-2xl bg-brand/10 grid place-items-center">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-brand opacity-60">
        <rect x="3" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.4" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.4" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.4" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" fill="currentColor" />
      </svg>
    </div>
    <div>
      <p className="font-semibold text-foreground">{name}</p>
      <p className="text-[13px] text-muted mt-0.5">This page is being built — check back soon.</p>
    </div>
  </div>
);

// ── Tab registry ──────────────────────────────────────────────────────────────
// Each entry: { id, label, pageId, el }
// All start as PlaceholderTab; swap in real implementations as tasks land.

const MerchandisingOverview    = React.lazy(() => import("./merch/MerchOverview"));
const MerchandisingSales       = React.lazy(() => import("./merch/MerchSales"));
const MerchandisingInventory   = React.lazy(() => import("./merch/MerchInventory"));
const MerchandisingSellThrough = React.lazy(() => import("./merch/MerchSellThrough"));
const MerchandisingCategory    = React.lazy(() => import("./MerchCategory"));
const MerchandisingLifecycle   = React.lazy(() => import("./MerchLifecycle"));
const MerchandisingAtRisk      = React.lazy(() => import("./MerchAtRisk"));
const MerchandisingReplen      = React.lazy(() => import("./MerchReplen"));
const MerchandisingFinancial   = React.lazy(() => import("./MerchFinancial"));
const MerchandisingArrivals    = React.lazy(() => import("./MerchArrivals"));
const MerchandisingDeepDive    = React.lazy(() => import("./MerchDeepDive"));
const MerchandisingStore       = React.lazy(() => import("./MerchStoreCockpit"));

const MERCH_TABS = [
  { id: "merch-overview",    label: "Executive Overview",       pageId: "merch-overview",    el: MerchandisingOverview },
  { id: "merch-sales",       label: "Sales Performance",        pageId: "merch-sales",       el: MerchandisingSales },
  { id: "merch-inventory",   label: "Inventory & Stock Health", pageId: "merch-inventory",   el: MerchandisingInventory },
  { id: "merch-sellthrough", label: "Sell-Through & Markdown",  pageId: "merch-sellthrough", el: MerchandisingSellThrough },
  { id: "merch-category",    label: "Category Performance",     pageId: "merch-category",    el: MerchandisingCategory },
  { id: "merch-lifecycle",   label: "Style Lifecycle & Age",    pageId: "merch-lifecycle",   el: MerchandisingLifecycle },
  { id: "merch-atrisk",      label: "At-Risk & Actions",        pageId: "merch-atrisk",      el: MerchandisingAtRisk },
  { id: "merch-replen",      label: "Replenishment Planning",   pageId: "merch-replen",      el: MerchandisingReplen },
  { id: "merch-financial",   label: "Financial Performance",    pageId: "merch-financial",   el: MerchandisingFinancial },
  { id: "merch-arrivals",    label: "New Arrivals & Pipeline",  pageId: "merch-arrivals",    el: MerchandisingArrivals },
  { id: "merch-deepdive",    label: "Style Deep Dive",          pageId: "merch-deepdive",    el: MerchandisingDeepDive },
  { id: "merch-store",       label: "Store Detail",             pageId: "merch-store",       el: MerchandisingStore },
];

// ── Hub shell ─────────────────────────────────────────────────────────────────
const MerchandisingHub = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Global filter bar — published down to tab components ─────────────────
  const { applied } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion,
          compareMode, compareDateFrom, compareDateTo } = applied;

  // ── Hub-level scope filters (Brand + Category) ───────────────────────────
  // These sit in a secondary strip below the tab bar, persist across tab
  // switches, and narrow the data scope for all tabs that accept them.
  const [hubBrand, setHubBrand]           = useState("");
  const [hubSubcategory, setHubSubcategory] = useState("");
  const [filterOptions, setFilterOptions]   = useState({ brands: [], categories: [] });

  // Derive the comparison date range from the GLOBAL filter bar's compare
  // settings (same source as useKpis / Overview) so Store Detail numbers
  // always agree with the Overview headline.
  const storeCompare = useMemo(() => {
    if (!dateFrom || !dateTo) return { from: null, to: null };
    const prev = comparePeriod(dateFrom, dateTo, compareMode,
                               { date_from: compareDateFrom, date_to: compareDateTo });
    return prev ? { from: prev.date_from, to: prev.date_to } : { from: null, to: null };
  }, [dateFrom, dateTo, compareMode, compareDateFrom, compareDateTo]);

  // Fetch distinct brands + categories once on mount (1h server TTL)
  useEffect(() => {
    apiFetch("/merch/filter-options")
      .then((d) => setFilterOptions(d || { brands: [], categories: [] }))
      .catch(() => {});
  }, []);

  // Normalise filter values into the shapes /api/merch/* expects
  const merchFilters = useMemo(() => ({
    from_date:    dateFrom || undefined,
    to_date:      dateTo   || undefined,
    country:      countries && countries.length ? countries.join(",") : undefined,
    pos_location: channels && channels.length  ? channels.join(",")  : undefined,
    brand:        hubBrand       || undefined,
    subcategory:  hubSubcategory || undefined,
    // Store Detail uses the SAME date range as the global filter so that
    // the headline Total Sales always matches the Overview page exactly.
    storeFrom:        dateFrom || undefined,
    storeTo:          dateTo   || undefined,
    storeCompareFrom: storeCompare.from,
    storeCompareTo:   storeCompare.to,
    storeCompareMode: compareMode || "none",
    dataVersion,   // bump triggers re-fetch in tab components
    filterOptions, // expose to tab pages so they can build local subcategory selectors
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dateFrom, dateTo, countries, channels, hubBrand, hubSubcategory,
       storeCompare.from, storeCompare.to, compareMode, dataVersion, filterOptions]);

  // ── Tab selection ─────────────────────────────────────────────────────────
  const visibleTabs = MERCH_TABS.filter((t) => canAccessPage(user, t.pageId));

  const wantedTab = searchParams.get("tab");
  const resolvedTab =
    visibleTabs.some((t) => t.id === wantedTab)
      ? wantedTab
      : visibleTabs[0]?.id || MERCH_TABS[0].id;

  const [activeId, setActiveId] = useState(resolvedTab);

  const handleTabClick = (id) => {
    setActiveId(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", id);
      return next;
    }, { replace: true });
  };

  // Sync state when the URL changes externally (e.g. browser back button)
  useEffect(() => {
    const wanted = searchParams.get("tab");
    if (wanted && visibleTabs.some((t) => t.id === wanted) && wanted !== activeId) {
      setActiveId(wanted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const active   = visibleTabs.find((t) => t.id === activeId) || visibleTabs[0];
  const ActiveEl = active?.el;

  const anyHubFilter = hubBrand || hubSubcategory;

  return (
    <MerchFiltersContext.Provider value={merchFilters}>
      <div className="space-y-4">
        {/* ── Sticky tab bar + hub-scope filter strip ── */}
        <div
          className="sticky z-30 bg-background/95 backdrop-blur-sm"
          style={{ top: "var(--app-navbar-h, 0px)" }}
        >
          {/* Tab row — dropdown on < lg, wrapped pills on lg+ */}
          {/* Phones only (<480px): select dropdown */}
          <div className="xs:hidden border-b border-border px-2 py-1.5 block sm:hidden" data-testid="merch-tabs-select">
            <select
              value={active?.id || ""}
              onChange={e => handleTabClick(e.target.value)}
              className="w-full text-[13px] font-medium border border-line rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            >
              {visibleTabs.map(t => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Tablet + desktop: wrapped tab pills */}
          <div
            className="hidden sm:flex flex-wrap items-center gap-0.5 border-b border-border"
            data-testid="merch-tabs"
          >
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => handleTabClick(t.id)}
                data-testid={`merch-tab-${t.id}`}
                className={
                  "px-2.5 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap " +
                  (t.id === active?.id
                    ? "border-[#1a5c38] text-[#1a5c38]"
                    : "border-transparent text-muted hover:text-foreground")
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Hub-scope filter strip — Brand + Category + Date Range */}
          <div className="flex flex-wrap items-center gap-2 px-1 py-2 border-b border-border/50 bg-slate-50/60">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 select-none pr-1">
              Scope
            </span>

            {/* Brand */}
            <div className="relative">
              <select
                value={hubBrand}
                onChange={(e) => setHubBrand(e.target.value)}
                className={
                  "appearance-none text-[12px] pl-2.5 pr-6 py-1 rounded-full border transition-colors cursor-pointer " +
                  "bg-white focus:outline-none focus:ring-1 focus:ring-[#1a5c38]/40 " +
                  (hubBrand
                    ? "border-[#1a5c38] text-[#1a5c38] font-semibold"
                    : "border-border text-slate-500")
                }
              >
                <option value="">All Brands</option>
                {filterOptions.brands.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
            </div>

            {/* Category */}
            <div className="relative">
              <select
                value={hubSubcategory}
                onChange={(e) => setHubSubcategory(e.target.value)}
                className={
                  "appearance-none text-[12px] pl-2.5 pr-6 py-1 rounded-full border transition-colors cursor-pointer " +
                  "bg-white focus:outline-none focus:ring-1 focus:ring-[#1a5c38]/40 " +
                  (hubSubcategory
                    ? "border-[#1a5c38] text-[#1a5c38] font-semibold"
                    : "border-border text-slate-500")
                }
              >
                <option value="">All Categories</option>
                {filterOptions.categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
            </div>

            {/* Clear button — only shown when a brand/category filter is active */}
            {anyHubFilter && (
              <button
                type="button"
                onClick={() => { setHubBrand(""); setHubSubcategory(""); }}
                className="text-[11px] text-slate-400 hover:text-slate-700 px-1.5 py-0.5 rounded transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* ── Active tab content ── */}
        {ActiveEl ? (
          <React.Suspense fallback={<Loading label="Loading…" />}>
            <ActiveEl />
          </React.Suspense>
        ) : (
          <div className="py-10 text-center text-muted text-[13px]">
            No accessible tabs — contact your administrator.
          </div>
        )}
      </div>
    </MerchFiltersContext.Provider>
  );
};

export default MerchandisingHub;
