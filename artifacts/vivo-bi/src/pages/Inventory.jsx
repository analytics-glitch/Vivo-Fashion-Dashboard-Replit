import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtDec, fmtPct, fmtAxisKES } from "@/lib/api";
import CountryDot from "@/components/CountryDot";
import { varianceStyle, VarianceCell } from "@/lib/variance";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import StyleStatusToggle from "@/components/StyleStatusToggle";
import DateWindowSelector from "@/components/DateWindowSelector";
import SortableTable from "@/components/SortableTable";
import RecommendationActionPill from "@/components/RecommendationActionPill";
import { useRecommendationState } from "@/lib/useRecommendationState";
import { ChartTooltip, makePctDeltaLabel } from "@/components/ChartHelpers";
import { categoryFor, isMerchandise, MERCH_CATEGORIES, subcategoriesFor } from "@/lib/productCategory";
import MultiSelect from "@/components/MultiSelect";
import SORHeader from "@/components/SORHeader";
import StockToSalesByVariant from "@/components/StockToSalesByVariant";
import CategoryAccordionTable from "@/components/CategoryAccordionTable";
import AgedStockReport from "@/components/AgedStockReport";
import {
  Package,
  Warning,
  Storefront,
  MagnifyingGlass,
  TrendDown,
  Cube,
  Gauge,
} from "@phosphor-icons/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  LabelList,
} from "recharts";

// Single source of truth for the store-vs-warehouse split. A location counts as
// "warehouse" (i.e. non-store stock) when its name matches this pattern. Used
// both for the client-side aggregate (filtered rows) and for splitting the
// backend inventory-summary `by_location` list. "online - shop zetu" is
// online-fulfilment holding stock, not a retail store, so it is warehouse here.
const isWarehouseLocation = (loc) =>
  /warehouse|wholesale|holding|staging|sale stock|online - shop zetu/.test(
    (loc || "").toLowerCase()
  );

// Production pipeline (WIP) locations — Waiting Sewing (Fabric Trimming),
// Sewing (Sew/Stock A–E), Finishing (Finished Goods Production). Mirrors the
// backend PIPELINE_LOCATIONS list. Not sellable — excluded from Total SOH
// (Total = Stores + Warehouse only). Checked BEFORE the warehouse classifier.
const isPipelineLocation = (loc) =>
  /fabric trimming|finished goods production|sew\/stock/.test(
    (loc || "").toLowerCase()
  );

const Inventory = ({ onSeeAgedStock }) => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;

  const { stateByKey: dqByKey, setState: setDqState } = useRecommendationState("dq");

  const [summary, setSummary] = useState(null);
  const [inv, setInv] = useState([]);
  const [sts, setSts] = useState([]);
  const [subcatSS, setSubcatSS] = useState([]);
  const [stsByCat, setStsByCat] = useState([]);
  const [weeksOfCover, setWeeksOfCover] = useState([]);
  // Chain-wide WoC summary returned alongside the per-style rows.
  // Use this (not a roll-up over `rows`) for the KPI card so the
  // denominator covers EVERY style, not just /sor's top-200 slice.
  const [weeksOfCoverSummary, setWeeksOfCoverSummary] = useState(null);
  const [sellThrough, setSellThrough] = useState([]);
  // Style-level sales (units + KES) for the configured date range —
  // sourced from /top-skus. Used when the products search filter is
  // active so the Stock-to-Sales tables re-aggregate sales numbers
  // from ONLY the visible styles instead of the upstream's
  // subcategory-wide rollup.
  const [topSkus, setTopSkus] = useState([]);
  const [loading, setLoading] = useState(true);
  // Separate flag for the heavy row-level payloads (/inventory + /top-skus),
  // which load in the background after the lightweight summary/aggregate
  // endpoints so the page is interactive without waiting on ~50K rows.
  const [rowsLoading, setRowsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Live search — debounced via useEffect below to avoid re-render storms.
  const [searchInput, setSearchInput] = useState("");
  const [stsView, setStsView] = useState("grouped"); // "flat" | "grouped"
  // Local merch-taxonomy filters (multi-select). Drive `visibleSubcats`
  // intersection downstream so every section reacts in lock-step.
  const [merchCats, setMerchCats] = useState([]); // [] = all merch categories
  const [merchSubs, setMerchSubs] = useState([]); // [] = all merch subcats
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  // Include warehouse / wholesale / holding stock in the POS-scoped STS
  // tables. Off by default — most users want pure shop-floor stock.
  const [includeWarehouse, setIncludeWarehouse] = useState(false);
  // Iter 89w-h — per-table window override for the STS / stock-to-sales
  // tables.  Defaults to 30 days so first-load shows recent velocity
  // regardless of what the global filter bar is set to.  Overrides
  // `dateFrom` / `dateTo` only for the 3 STS endpoints below.
  const [stsWindowDays, setStsWindowDays] = useState(30);
  // Iter 91i — custom date range for the STS-by-Subcategory table.
  // When both from + to are populated they OVERRIDE the preset window
  // and feed the /stock-to-sales-by-subcat endpoint directly. Clearing
  // either input reverts to the preset.
  const [stsCustomRange, setStsCustomRange] = useState({ from: "", to: "" });
  // Effective window length (in days, inclusive) computed by the fetch
  // effect — read by the table to derive weeks_of_cover. Keeps the UI
  // perfectly synced with the data that was actually requested.
  const [stsEffectiveDays, setStsEffectiveDays] = useState(30);
  // The exact date range the STS endpoints were called with — stamped on the
  // table captions so readers know Units Sold covers THIS window, not the
  // page-level filter bar range.
  const [stsAppliedRange, setStsAppliedRange] = useState(null);
  // Stock-to-Sales stock scope: which inventory rolls up into the
  // current_stock column. "stores" (POS only), "warehouse", or "combined".
  // Iter 89w-c — STS / "Stock to Sales" scope.  Default "combined"
  // so the page shows the full chain-wide picture on first load.
  // Iter 91j — STS Stock scope.
  //   • When the user picks a POS, the natural expectation is that
  //     Inventory column reflects ONLY that POS — so we auto-scope
  //     to "stores" (POS-only stock).
  //   • When no POS is selected, we keep the historical default of
  //     "combined" (store + warehouse).
  //   • If the user explicitly clicks a scope toggle, their choice
  //     wins (tracked via `stockScopeOverride`). The "Auto" hint pill
  //     resets to derived behaviour.
  const [stockScopeOverride, setStockScopeOverride] = useState(null);
  const posSelected = channels.length > 0;
  const stockScope = stockScopeOverride ?? (posSelected ? "stores" : "combined");
  const stockScopeIsAuto = stockScopeOverride === null;
  const setStockScope = (v) => setStockScopeOverride(v);
  // Iter 89w — Active/Retired/All toggle. Default "all" so the live
  // catalog shows both active and retired styles on first load —
  // matches user expectation that the page reflects ALL inventory by
  // default; users can flip to Active to drop retired styles when
  // analysing the active range.
  const [styleStatus, setStyleStatus] = useState("all");
  // Iter 89w-b — small counts pill alongside the toggle so users know
  // how many styles (and units) are in each bucket at a glance.
  const [statusCounts, setStatusCounts] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 120);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Server-side search scope — a slower debounce than the client-side `search`
  // (which filters in-memory rows on every keystroke settle) so the four
  // stock-to-sales endpoints aren't refetched mid-typing.
  const [serverSearch, setServerSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setServerSearch(searchInput.trim()), 450);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Params sent to the STS endpoints so the server scopes BOTH the stock and
  // sales sides to the local product filters. Category-tree filters
  // (merchCats/merchSubs) stay client-side (they map 1:1 to whole subcat rows).
  const serverScopeParams = useMemo(() => ({
    search: serverSearch || undefined,
    brand: brandFilter || undefined,
    product_type: typeFilter || undefined,
  }), [serverSearch, brandFilter, typeFilter]);
  // True when the server responses are already scoped to search/brand/type —
  // the client-side sales-merge fallback must then be skipped or it would
  // overwrite correctly-scoped server values with a different basis.
  const serverScoped = Boolean(serverSearch || brandFilter || typeFilter);

  // Iter 89w-b — counts pill, refetched only when country/POS filters
  // change (NOT on styleStatus changes — these counts are always both
  // sides of the bucket so the user can see "1234 active · 200
  // retired" regardless of which one they're currently viewing).
  useEffect(() => {
    let cancelled = false;
    const countryCsv = countries.length ? countries.map((c) => c.toLowerCase()).join(",") : undefined;
    const locationsCsv = channels.length ? channels.join(",") : undefined;
    api
      .get("/inventory-style-counts", { params: { country: countryCsv, locations: locationsCsv } })
      .then((r) => { if (!cancelled) setStatusCounts(r.data || null); })
      .catch(() => { if (!cancelled) setStatusCounts(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRowsLoading(true);
    setError(null);
    const countryCsv = countries.length ? countries.map((c) => c.toLowerCase()).join(",") : undefined;
    const locationsCsv = channels.length ? channels.join(",") : undefined;
    const invParams = { country: countryCsv, locations: locationsCsv, style_status: styleStatus };
    const refreshParams = dataVersion > 0 ? { ...invParams, refresh: true } : invParams;
    // Iter 89w-h — STS-specific date window (default 30d) overrides the
    // global filter bar dates ONLY for the stock-to-sales endpoints.
    // Iter 91i — if a custom range is set, use it instead of the preset.
    let stsDateFrom;
    let stsDateTo;
    let stsEffectiveWindowDays = stsWindowDays;
    if (stsCustomRange.from && stsCustomRange.to) {
      // Normalise: swap if user typed them reversed; clamp to today.
      let f = stsCustomRange.from;
      let t = stsCustomRange.to;
      if (f > t) { const tmp = f; f = t; t = tmp; }
      stsDateFrom = f;
      stsDateTo = t;
      // Days inclusive of both endpoints — used for cover/weeks math.
      const fDate = new Date(f + "T00:00:00Z");
      const tDate = new Date(t + "T00:00:00Z");
      stsEffectiveWindowDays = Math.max(1, Math.round((tDate - fDate) / (24 * 3600 * 1000)) + 1);
    } else {
      const stsTo = new Date();
      stsTo.setUTCDate(stsTo.getUTCDate() - 1);
      const stsFromDate = new Date(stsTo);
      stsFromDate.setUTCDate(stsFromDate.getUTCDate() - stsWindowDays + 1);
      stsDateFrom = stsFromDate.toISOString().slice(0, 10);
      stsDateTo = stsTo.toISOString().slice(0, 10);
    }
    // Surface the effective window in state so the table can derive
    // weeks_of_cover off the same number the API was called with.
    setStsEffectiveDays(stsEffectiveWindowDays);
    setStsAppliedRange({ from: stsDateFrom, to: stsDateTo });
    const dateParams = {
      date_from: stsDateFrom, date_to: stsDateTo,
      country: countryCsv, locations: locationsCsv,
      include_warehouse: includeWarehouse ? 1 : undefined,
      stock_scope: stockScope,
    };
    // Phase 1 — lightweight aggregate endpoints. The backend now rolls up the
    // inventory headline (total/store/warehouse units, by-location, by-subcat)
    // server-side, so these compact responses are all the page needs to render
    // its KPIs, summary charts, and stock-to-sales / weeks-of-cover tables. The
    // page becomes interactive as soon as these resolve — it no longer blocks
    // on the ~50K-row /inventory payload.
    Promise.all([
      api.get("/analytics/inventory-summary", { params: refreshParams }),
      api.get("/stock-to-sales", { params: { date_from: stsDateFrom, date_to: stsDateTo, country: countryCsv, locations: locationsCsv, ...serverScopeParams } }),
      api.get("/analytics/stock-to-sales-by-subcat", { params: { ...dateParams, ...serverScopeParams } }),
      api.get("/analytics/stock-to-sales-by-category", { params: { ...dateParams, ...serverScopeParams } }),
      api.get("/analytics/weeks-of-cover", { params: { country: countryCsv, locations: locationsCsv, stock_scope: stockScope } }),
      api.get("/analytics/sell-through-by-location", { params: { date_from: stsDateFrom, date_to: stsDateTo, country: countryCsv, ...serverScopeParams } })
        .catch(() => ({ data: [] })),
    ])
      .then(([s, st, sc, cat, woc, str]) => {
        if (cancelled) return;
        setSummary(s.data);
        setSts(st.data || []);
        setSubcatSS(sc.data || []);
        setStsByCat(cat.data || []);
        // /analytics/weeks-of-cover now returns { rows, _summary }; fall
        // back to the legacy array shape so a stale Redis hit doesn't
        // crash during rollout.
        const wocPayload = woc.data;
        if (Array.isArray(wocPayload)) {
          setWeeksOfCover(wocPayload);
          setWeeksOfCoverSummary(null);
        } else {
          setWeeksOfCover(wocPayload?.rows || []);
          setWeeksOfCoverSummary(wocPayload?._summary || null);
        }
        setSellThrough(str.data || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));

    // Phase 2 — heavy row-level payloads, loaded in the background. These power
    // the row-derived features that still need per-SKU data: the low-stock-style
    // KPI, brand filter pills, SKU search, and the filter-aware client-side
    // aggregates. The page already renders from the Phase-1 summary while these
    // stream in; row-dependent sections show a loading state until they arrive.
    Promise.all([
      api.get("/inventory", { params: refreshParams }),
      api.get("/top-skus", { params: { date_from: dateFrom, date_to: dateTo, country: countryCsv, channel: locationsCsv, limit: 5000, style_status: styleStatus } })
        .catch(() => ({ data: [] })),
    ])
      .then(([i, tsk]) => {
        if (cancelled) return;
        setInv(i.data || []);
        setTopSkus(tsk.data || []);
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setRowsLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion, includeWarehouse, stockScope, styleStatus, stsWindowDays, stsCustomRange.from, stsCustomRange.to, serverSearch, brandFilter, typeFilter]);

  // --- Merchandise-only raw inventory ---
  // Hard rule: exclude Accessories, Sale, Belts/Scarves/Fragrances/Sample &
  // Sale Items, and any row with a null/empty product_type across the app.
  const merchInv = useMemo(
    () => inv.filter((r) => isMerchandise(r.product_type)),
    [inv]
  );

  const brands = useMemo(
    () => [...new Set(merchInv.map((r) => r.brand).filter(Boolean))].sort(),
    [merchInv]
  );
  const types = useMemo(
    () => [...new Set(merchInv.map((r) => r.product_type).filter(Boolean))].sort(),
    [merchInv]
  );

  // Dedupe style → canonical subcategory (style with multiple product_types
  // gets the one with the most units).
  const styleCanonicalType = useMemo(() => {
    const counts = new Map();
    for (const r of merchInv) {
      const style = r.style_name || r.product_name;
      const pt = r.product_type;
      if (!style || !pt) continue;
      if (!counts.has(style)) counts.set(style, {});
      const m = counts.get(style);
      m[pt] = (m[pt] || 0) + (r.available || 1);
    }
    const out = new Map();
    for (const [style, m] of counts) {
      const best = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
      if (best) out.set(style, best[0]);
    }
    return out;
  }, [merchInv]);

  // Pre-enriched rows with a pre-computed lowercase `_search` blob so every
  // keystroke costs ONE String.includes call per row instead of four.
  const enrichedInv = useMemo(() => {
    return merchInv.map((r) => {
      const style = r.style_name || r.product_name;
      const canonicalType = styleCanonicalType.get(style);
      const _search = (
        (r.product_name || "") + "\t" +
        (r.style_name || "") + "\t" +
        (r.sku || "") + "\t" +
        (r.barcode || "")
      ).toLowerCase();
      return canonicalType ? { ...r, product_type: canonicalType, _search } : { ...r, _search };
    });
  }, [merchInv, styleCanonicalType]);

  // Apply country, location, brand, product-type, merch-taxonomy AND
  // search filters. This drives every downstream aggregate.
  const filteredInv = useMemo(() => {
    const q = search.toLowerCase();
    const hasCountryFilter = countries.length > 1;
    const countriesLC = hasCountryFilter ? countries.map((c) => c.toLowerCase()) : null;
    const channelsSet = channels.length ? new Set(channels) : null;
    const catSet = merchCats.length ? new Set(merchCats) : null;
    const subSet = merchSubs.length ? new Set(merchSubs) : null;
    return enrichedInv.filter((r) => {
      if (countriesLC && !countriesLC.includes((r.country || "").toLowerCase())) return false;
      if (channelsSet && !channelsSet.has(r.location_name)) return false;
      if (brandFilter && r.brand !== brandFilter) return false;
      if (typeFilter && r.product_type !== typeFilter) return false;
      if (catSet && !catSet.has(categoryFor(r.product_type))) return false;
      if (subSet && !subSet.has(r.product_type)) return false;
      if (!q) return true;
      return r._search.includes(q);
    });
  }, [enrichedInv, countries, channels, brandFilter, typeFilter, merchCats, merchSubs, search]);

  // When any filter (search/brand/type/category/subcat) is active, derive
  // the visible location & subcategory set and restrict the aggregated
  // charts/tables to match. When no filters are active we show the raw
  // merchandise aggregates.
  // Iter 89w — styleStatus narrows the source-of-truth array, so once it
  // is anything other than "all" we MUST recompute every KPI/table from
  // the filtered `inv` (instead of the chain-wide `summary` aggregate
  // which is computed upstream over every style, retired included).
  const filtersActive = Boolean(
    search || brandFilter || typeFilter || merchCats.length || merchSubs.length || (styleStatus && styleStatus !== "all")
  );
  const visibleLocations = useMemo(
    () => new Set(filteredInv.map((r) => r.location_name).filter(Boolean)),
    [filteredInv]
  );
  const visibleSubcats = useMemo(
    () => new Set(filteredInv.map((r) => r.product_type).filter(Boolean)),
    [filteredInv]
  );
  const visibleStyles = useMemo(
    () => new Set(filteredInv.map((r) => r.style_name || r.product_name).filter(Boolean)),
    [filteredInv]
  );

  // Stock by location — from filteredInv when filters active, else from
  // summary (backend merchandise-filtered aggregate if available).
  const stockByLocation = useMemo(() => {
    if (filtersActive) {
      const m = new Map();
      for (const r of filteredInv) {
        const loc = r.location_name || "—";
        m.set(loc, (m.get(loc) || 0) + (r.available || 0));
      }
      return [...m.entries()]
        .map(([location, units]) => ({ location, units }))
        .sort((a, b) => b.units - a.units);
    }
    // No local filters: use the backend merch-filtered by_location aggregate so
    // we don't aggregate ~50K rows client-side. Fall back to merchInv until the
    // summary arrives (or if it is missing).
    if (summary && summary.by_location) {
      return summary.by_location
        .map((r) => ({ location: r.location || "—", units: r.units || 0 }))
        .sort((a, b) => b.units - a.units);
    }
    const m = new Map();
    for (const r of merchInv) {
      const loc = r.location_name || "—";
      m.set(loc, (m.get(loc) || 0) + (r.available || 0));
    }
    return [...m.entries()]
      .map(([location, units]) => ({ location, units }))
      .sort((a, b) => b.units - a.units);
  }, [filtersActive, filteredInv, merchInv, summary]);

  const totalFilteredUnits = useMemo(
    () => filteredInv.reduce((s, r) => s + (r.available || 0), 0),
    [filteredInv]
  );

  // Store vs Warehouse split derived from filtered rows.
  const storeVsWarehouse = useMemo(() => {
    let store = 0;
    let warehouse = 0;
    let pipeline = 0;
    for (const r of filteredInv) {
      if (isPipelineLocation(r.location_name)) pipeline += r.available || 0;
      else if (isWarehouseLocation(r.location_name)) warehouse += r.available || 0;
      else store += r.available || 0;
    }
    return { store, warehouse, pipeline };
  }, [filteredInv]);

  // Store vs Warehouse split from the backend by_location aggregate, used for
  // the headline KPIs when no local filters are active (avoids the 50K-row
  // client-side path). Same location classifier as storeVsWarehouse.
  const summaryStoreWarehouse = useMemo(() => {
    let store = 0;
    let warehouse = 0;
    let pipeline = 0;
    for (const r of summary?.by_location || []) {
      if (isPipelineLocation(r.location)) pipeline += r.units || 0;
      else if (isWarehouseLocation(r.location)) warehouse += r.units || 0;
      else store += r.units || 0;
    }
    return { store, warehouse, pipeline };
  }, [summary]);

  const lowStockByStyle = useMemo(() => {
    const m = new Map();
    for (const r of filteredInv) {
      const style = r.style_name || r.product_name;
      if (!style) continue;
      // Extra guard: filter out any non-merchandise that slipped through.
      if (!isMerchandise(r.product_type)) continue;
      if (!m.has(style)) {
        m.set(style, {
          style_name: style,
          brand: r.brand,
          product_type: r.product_type,
          category: categoryFor(r.product_type),
          collection: r.collection,
          available: 0,
          sku_count: 0,
          locations: new Set(),
        });
      }
      const e = m.get(style);
      e.available += r.available || 0;
      e.sku_count += 1;
      if (r.location_name) e.locations.add(r.location_name);
    }
    return [...m.values()]
      .filter((e) => e.available <= 10)
      .map((e) => ({ ...e, locations: e.locations.size }))
      .sort((a, b) => a.available - b.available);
  }, [filteredInv]);

  // Set of visible categories (derived from visible subcats) — used to
  const visibleCategories = useMemo(() => {
    if (!filtersActive) return null;
    const s = new Set();
    for (const sc of visibleSubcats) {
      const c = categoryFor(sc);
      if (c) s.add(c);
    }
    return s;
  }, [filtersActive, visibleSubcats]);

  const invByCategory = useMemo(() => {
    let src = stsByCat.filter((r) => !["Accessories", "Sale", "Other"].includes(r.category) && r.category);
    if (visibleCategories) src = src.filter((r) => visibleCategories.has(r.category));
    const total = src.reduce((s, r) => s + (r.current_stock || 0), 0) || 1;
    return [...src]
      .sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))
      .map((r) => {
        const pct = ((r.current_stock || 0) / total) * 100;
        return { ...r, pct, cat_label: `${fmtNum(r.current_stock)} · ${pct.toFixed(1)}%` };
      });
  }, [stsByCat, visibleCategories]);

  const invBySubcat = useMemo(() => {
    // Merch stock-on-hand per subcategory. When no local filters are active the
    // backend inventory-summary `by_subcat` aggregate is used so we don't roll up
    // ~50K rows client-side; otherwise it is filter-aware off filteredInv.
    let sorted;
    if (!filtersActive && summary && summary.by_subcat) {
      sorted = summary.by_subcat
        .map((r) => ({ product_type: r.product_type, units: r.units || 0 }))
        .sort((a, b) => (b.units || 0) - (a.units || 0));
    } else {
      const m = new Map();
      for (const r of filteredInv) {
        const pt = r.product_type;
        if (!pt) continue;
        m.set(pt, (m.get(pt) || 0) + (r.available || 0));
      }
      sorted = [...m.entries()]
        .map(([product_type, units]) => ({ product_type, units }))
        .sort((a, b) => (b.units || 0) - (a.units || 0));
    }
    const total = sorted.reduce((s, r) => s + (r.units || 0), 0) || 1;
    return sorted.slice(0, 15).map((r) => {
      const pct = ((r.units || 0) / total) * 100;
      return { ...r, pct, subcat_label: `${pct.toFixed(1)}%` };
    });
  }, [filteredInv, filtersActive, summary]);

  const filteredWeeksOfCover = useMemo(
    () => weeksOfCover
      .filter((r) => isMerchandise(r.subcategory))
      .filter((r) => !filtersActive || visibleStyles.has(r.style_name)),
    [weeksOfCover, filtersActive, visibleStyles]
  );

  // ─── Stock aging classification ──────────────────────────────────
  // Buckets derived from weeks_of_cover + last-28-day units:
  //   Fresh     < 4w   (stock is flowing)
  //   Healthy   4–8w   (normal replenishment cadence)
  //   Aging     8–16w  (slow, keep eye)
  //   Stale     > 16w  (markdown candidate)
  //   Phantom   stock ≥ 30 AND zero sales in the last 4 weeks
  //             (dead money — IBT or clearance immediately)
  const bucketFor = (r) => {
    const stock = r.current_stock || 0;
    // Phantom = lots of stock but ZERO sales in the last-28-day window
    // (`units_sold_28d` from /analytics/weeks-of-cover) — matches the
    // ">=30 units, zero sales in 4w" card definition exactly.
    const sold28 = r.units_sold_28d ?? 0;
    if (stock >= 30 && sold28 === 0) return "phantom";
    const w = r.weeks_of_cover;
    // WS4 T405 — no sales but under the 30-unit phantom threshold: that's
    // stale (markdown candidate), NOT phantom. Previously these small
    // 2–16-unit styles leaked into the Phantom card and contradicted the
    // stated ">=30 units" definition.
    if (w == null) return "stale";
    if (w < 4)  return "fresh";
    if (w < 8)  return "healthy";
    if (w < 16) return "aging";
    return "stale";
  };
  const agingRows = useMemo(
    () => filteredWeeksOfCover.map((r) => ({ ...r, _bucket: bucketFor(r) })),
    [filteredWeeksOfCover]
  );
  const agingSummary = useMemo(() => {
    const init = { fresh: 0, healthy: 0, aging: 0, stale: 0, phantom: 0 };
    const byBucket = agingRows.reduce((acc, r) => {
      acc[r._bucket] = (acc[r._bucket] || 0) + 1;
      return acc;
    }, init);
    const phantomStockUnits = agingRows
      .filter((r) => r._bucket === "phantom")
      .reduce((s, r) => s + (r.current_stock || 0), 0);
    return { byBucket, phantomStockUnits };
  }, [agingRows]);
  const phantomRows = useMemo(
    () => agingRows
      .filter((r) => r._bucket === "phantom")
      .sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0)),
    [agingRows]
  );

  // Style-level sales rollups computed from /top-skus. Used to override
  // the upstream subcategory-aggregated numbers when a search/brand
  // filter is active, so the Stock-to-Sales tables show "Sienna sales"
  // (not "all Waterfalls sales") when the user searches "Sienna".
  // Map: subcategory → { units_sold, total_sales }
  const salesByVisibleSubcat = useMemo(() => {
    if (!filtersActive) return null;
    const m = new Map();
    for (const r of topSkus || []) {
      const style = r.style_name;
      if (!style || !visibleStyles.has(style)) continue;
      const sub = r.product_type || r.subcategory;
      if (!sub) continue;
      const e = m.get(sub) || { units_sold: 0, total_sales: 0 };
      e.units_sold += r.units_sold || 0;
      e.total_sales += r.total_sales || 0;
      m.set(sub, e);
    }
    return m;
  }, [filtersActive, topSkus, visibleStyles]);

  // Same but rolled up to merch category.
  const salesByVisibleCategory = useMemo(() => {
    if (!filtersActive || !salesByVisibleSubcat) return null;
    const m = new Map();
    for (const [sub, v] of salesByVisibleSubcat.entries()) {
      const cat = categoryFor(sub) || "Other";
      const e = m.get(cat) || { units_sold: 0, total_sales: 0 };
      e.units_sold += v.units_sold;
      e.total_sales += v.total_sales;
      m.set(cat, e);
    }
    return m;
  }, [filtersActive, salesByVisibleSubcat]);

  const filteredSts = useMemo(
    () => (filtersActive ? sts.filter((r) => visibleLocations.has(r.location)) : sts),
    [sts, filtersActive, visibleLocations]
  );

  // Sell-through table follows the same local-filter contract as the STS
  // tables: when a search/brand/category filter is active, show only the
  // locations that actually hold the matching inventory.
  const filteredSellThrough = useMemo(
    () => (filtersActive
      ? (sellThrough || []).filter((r) => visibleLocations.has(r.location))
      : (sellThrough || [])),
    [sellThrough, filtersActive, visibleLocations]
  );

  const filteredStsByCat = useMemo(() => {
    let src = stsByCat.filter((r) => !["Accessories", "Sale", "Other"].includes(r.category) && r.category);
    if (visibleCategories) src = src.filter((r) => visibleCategories.has(r.category));
    // When search/brand/type filters are active the SERVER already scoped
    // both the sales and stock sides of these rows — skip the client-side
    // sales merge (it uses the page-filter window, a different basis).
    if (serverScoped) return src;
    if (!filtersActive || !salesByVisibleCategory) return src;
    // Override units_sold + recompute %-shares from the visible-styles
    // numbers so the tile reflects only the searched styles.
    const totUnits = src.reduce((s, r) => s + (salesByVisibleCategory.get(r.category)?.units_sold || 0), 0);
    const totStock = src.reduce((s, r) => s + (r.current_stock || 0), 0);
    return src.map((r) => {
      const v = salesByVisibleCategory.get(r.category) || { units_sold: 0, total_sales: 0 };
      const pctSold = totUnits ? (v.units_sold / totUnits) * 100 : 0;
      const pctStock = totStock ? ((r.current_stock || 0) / totStock) * 100 : 0;
      return {
        ...r,
        units_sold: v.units_sold,
        total_sales: v.total_sales,
        pct_of_total_sold: pctSold,
        pct_of_total_stock: pctStock,
        variance: pctSold - pctStock,
      };
    });
  }, [stsByCat, visibleCategories, filtersActive, salesByVisibleCategory, serverScoped]);

  const filteredSubcatSS = useMemo(() => {
    const base = subcatSS
      .filter((r) => isMerchandise(r.subcategory))
      .filter((r) => !filtersActive || visibleSubcats.has(r.subcategory));
    // Server already scoped these rows when search/brand/type are active —
    // don't overwrite with the client merge (different date-window basis).
    if (serverScoped) return base;
    if (!filtersActive || !salesByVisibleSubcat) return base;
    const totUnits = base.reduce((s, r) => s + (salesByVisibleSubcat.get(r.subcategory)?.units_sold || 0), 0);
    const totStock = base.reduce((s, r) => s + (r.current_stock || 0), 0);
    return base.map((r) => {
      const v = salesByVisibleSubcat.get(r.subcategory) || { units_sold: 0, total_sales: 0 };
      const pctSold = totUnits ? (v.units_sold / totUnits) * 100 : 0;
      const pctStock = totStock ? ((r.current_stock || 0) / totStock) * 100 : 0;
      return {
        ...r,
        units_sold: v.units_sold,
        total_sales: v.total_sales,
        pct_of_total_sold: pctSold,
        pct_of_total_stock: pctStock,
        variance: pctSold - pctStock,
      };
    });
  }, [subcatSS, filtersActive, visibleSubcats, salesByVisibleSubcat, serverScoped]);

  const understockedSubcats = useMemo(() => {
    return filteredSubcatSS
      .map((r) => ({
        ...r,
        understock_pct: (r.pct_of_total_sold || 0) - (r.pct_of_total_stock || 0),
      }))
      .filter((r) => r.understock_pct > 0.5)
      .sort((a, b) => b.understock_pct - a.understock_pct);
  }, [filteredSubcatSS]);

  // Headline KPIs. When no local filters are active, source them from the
  // compact backend inventory-summary aggregate (total_units + by_location) so
  // the page does not roll up ~50K rows client-side just to show three numbers.
  // When a local filter is active, fall back to the filter-aware client-side
  // aggregates over filteredInv. (Country/channel scoping is applied server-side
  // on the summary, so it stays correct without local filters.)
  const useSummaryKpis = Boolean(summary && summary.by_location && !filtersActive);
  const kpiStore = useSummaryKpis ? summaryStoreWarehouse.store : storeVsWarehouse.store;
  const kpiWarehouse = useSummaryKpis
    ? summaryStoreWarehouse.warehouse
    : storeVsWarehouse.warehouse;
  const kpiPipeline = useSummaryKpis
    ? summaryStoreWarehouse.pipeline
    : storeVsWarehouse.pipeline;
  // Total SOH = Stores + Warehouse only — the production pipeline (WIP) is
  // NOT sellable stock and is always excluded from the headline total.
  const kpiTotal = kpiStore + kpiWarehouse;

  // Export filename slug reflecting the active filters — makes traceability
  // obvious when sharing CSVs via email/chat.
  const exportSlug = useMemo(() => {
    const parts = [];
    if (channels.length) parts.push(channels.map((c) => c.replace(/\s+/g, "-").toLowerCase()).join("+"));
    else if (countries.length) parts.push(countries.map((c) => c.toLowerCase()).join("+"));
    else parts.push("all");
    parts.push(new Date().toISOString().slice(0, 10));
    return parts.join("_");
  }, [channels, countries]);

  // Variance classifier & cell live in `/app/frontend/src/lib/variance.jsx`
  // so Products page and any future views (Re-Order, IBT, CEO Report) use
  // identical thresholds and flags. Do not re-implement locally.
  // VarianceCell renders icon + "±X.XX pts" with hover tip; varianceStyle
  // returns { cls, icon, flag, tip } for custom layouts.
  // Keep the "pts" suffix here (instead of "%") since Inventory displays
  // variance in points while the page text talks "pp". Products page uses
  // default "%" suffix.
  const VarianceCellPts = ({ value }) => <VarianceCell value={value} suffix=" pts" />;

  return (
    <div className="space-y-6" data-testid="inventory-page">
      <div>
        <p className="text-muted text-[13px] mt-0.5">
          Merchandise only — Accessories, Sample &amp; Sale Items and
          uncategorised products are excluded from every section below.
        </p>
        <div
          className="mt-2 flex flex-wrap items-center gap-2"
          data-testid="inv-filter-row"
        >
          <StyleStatusToggle
            value={styleStatus}
            onChange={setStyleStatus}
            testIdPrefix="inv-style-status"
          />
          {statusCounts && (
            <div
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1 text-[11.5px]"
              data-testid="inv-style-status-counts"
              title="Live distinct-style and unit counts from the inventory snapshot. Updates with country/POS filters."
            >
              <span className="font-bold text-emerald-700">{fmtNum(statusCounts.active_styles)}</span>
              <span className="text-muted">active</span>
              <span className="text-muted">·</span>
              <span className="font-bold text-amber-700">{fmtNum(statusCounts.retired_styles)}</span>
              <span className="text-muted">retired</span>
              <span className="text-muted">styles ({fmtNum(statusCounts.total_styles)} total)</span>
            </div>
          )}
          {(countries.length > 0 || channels.length > 0) && (
            <div
              className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-brand/30 bg-brand/5 px-2.5 py-1 text-[11.5px] font-semibold text-brand-deep"
              data-testid="inv-active-filter-banner"
            >
              <span className="text-muted font-normal">Showing inventory for:</span>
              {countries.map((c) => (
                <span key={`c-${c}`} className="pill-neutral">{c}</span>
              ))}
              {channels.map((p) => (
                <span key={`p-${p}`} className="pill-green">POS · {p}</span>
              ))}
            </div>
          )}
          {channels.length > 0 && (
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer rounded-lg border border-border bg-white px-2.5 py-1 text-[11.5px] font-semibold hover:border-brand/40 select-none"
              data-testid="inv-include-warehouse-toggle"
              title="When ON, the POS-scoped Stock-to-Sales tables ADD warehouse / wholesale / holding inventory on top of shop-floor stock. Useful when you need to see total allocable units, not just what's on the floor. OFF (default) = shop-floor stock only."
            >
              <input
                type="checkbox"
                checked={includeWarehouse}
                onChange={(e) => setIncludeWarehouse(e.target.checked)}
                className="accent-brand"
                data-testid="inv-include-warehouse-checkbox"
              />
              <span>Include warehouse stock</span>
              {includeWarehouse && <span className="pill-amber">+ warehouse</span>}
            </label>
          )}
          {/* Stock-to-Sales scope picker — drives which inventory rolls
              up into the `current_stock` column of the STS tables.
              Always visible (independent of filtersActive) so users can
              switch contexts without first having to apply a filter. */}
          <div
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1"
            data-testid="inv-stock-scope"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">STS Stock</span>
            <div className="inline-flex rounded-md overflow-hidden border border-border">
              {[
                { v: "stores", l: "Stores" },
                { v: "warehouse", l: "Warehouse" },
                { v: "combined", l: "Combined" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setStockScope(opt.v)}
                  data-testid={`inv-stock-scope-${opt.v}`}
                  title={
                    opt.v === "stores"  ? "Only POS / shop-floor inventory counts toward % of total stock." :
                    opt.v === "warehouse" ? "Only warehouse / wholesale / holding inventory counts." :
                                            "Stores + warehouse combined — total allocable inventory."
                  }
                  className={`text-[10.5px] font-bold px-2 py-1 transition-colors ${stockScope === opt.v ? "bg-[#1a5c38] text-white" : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"}`}
                >
                  {opt.l}
                </button>
              ))}
            </div>
            {/* Iter 91j — auto-scope hint. Visible whenever the scope
                is being driven by the POS selection rather than an
                explicit user click. Click resets nothing — the user
                must click a different scope to override. */}
            {stockScopeIsAuto && posSelected && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap"
                data-testid="inv-stock-scope-auto-hint"
                title="Inventory column is scoped to your selected POS. Pick Warehouse or Combined above to override."
              >
                Auto · POS-only
              </span>
            )}
            {!stockScopeIsAuto && (
              <button
                type="button"
                onClick={() => setStockScopeOverride(null)}
                data-testid="inv-stock-scope-auto-reset"
                className="text-[10px] font-semibold text-brand hover:underline whitespace-nowrap"
                title="Revert to auto: Stores when a POS is selected, Combined otherwise"
              >
                Reset auto
              </button>
            )}
          </div>
        </div>
      </div>

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <KPICard
              testId="inv-kpi-units"
              accent
              label="Total Available Units"
              sub={filtersActive ? "Filtered · stores + warehouse (pipeline excl.)" : "Stores + warehouse (pipeline excl.)"}
              value={fmtNum(kpiTotal)}
              icon={Package}
              showDelta={false}
              action={{ label: "Export inventory CSV", to: "/exports" }}
            />
            <KPICard
              testId="inv-kpi-store-stock"
              label="Stock in Stores"
              sub="Customer-facing units (excl. warehouse / holding)"
              value={fmtNum(kpiStore)}
              icon={Storefront}
              showDelta={false}
              action={{ label: "IBT candidates", to: "/ibt" }}
            />
            <KPICard
              testId="inv-kpi-warehouse-stock"
              label="Stock in Warehouse"
              sub="Warehouse, wholesale, holding, staging"
              value={fmtNum(kpiWarehouse)}
              icon={Cube}
              showDelta={false}
              action={{ label: "Plan distribution", to: "/ibt" }}
            />
            <KPICard
              testId="inv-kpi-pipeline-stock"
              label="Stock in Pipeline"
              sub="Production WIP — not sellable, excluded from total"
              value={fmtNum(kpiPipeline)}
              icon={Cube}
              showDelta={false}
            />
            {(() => {
              // Overall Weeks of Cover. Use the chain-wide summary from
              // the API (covers every style, not just /sor's top-200
              // slice) so the denominator matches the visible
              // Stock-in-Stores / Stock-in-Warehouse tiles. Falls back
              // to a rows-rollup if the summary is missing (older cache
              // hits during rollout).
              //
              // Iter 89w-c — when ANY local filter is active
              // (styleStatus, search, brand, subcat, category) the
              // chain-wide summary is wrong: it covers retired styles
              // and styles outside the filter scope.  Force the
              // row-rollup path so WoC reacts in lockstep with the
              // other KPIs.
              let woc;
              if (!filtersActive && weeksOfCoverSummary && weeksOfCoverSummary.weeks_of_cover != null) {
                woc = weeksOfCoverSummary.weeks_of_cover;
              } else {
                const totalStock = filteredWeeksOfCover.reduce((s, r) => s + (r.current_stock || 0), 0);
                const totalWeekly = filteredWeeksOfCover.reduce(
                  (s, r) => s + (r.units_sold_28d ?? r.units_sold_3m ?? 0),
                  0,
                ) / 4;
                woc = totalWeekly > 0 ? totalStock / totalWeekly : null;
              }
              const sub = woc == null
                ? "Not enough recent sales"
                : woc < 2 ? "Undercover — stockout risk, restock"
                : woc <= 4 ? "Low cover — monitor, plan re-order"
                : "Healthy cover (ideal ~12 weeks)";
              return (
                <KPICard
                  testId="inv-kpi-weeks-of-cover"
                  label="Overall Weeks of Cover"
                  sub={sub}
                  formula={
                    "Overall WoC = total chain stock ÷ chain weekly units sold.\n" +
                    "Weekly units = (last 3 full calendar months avg) ÷ 4  ≡  total_units_3m ÷ 12.\n" +
                    "Numerator covers EVERY style (matches the Stock-in-Stores tile), not just the top-200 SOR slice.\n" +
                    "Lower is better — high WoC means stock is sitting too long."
                  }
                  value={woc == null ? "—" : `${woc.toFixed(1)} wks`}
                  icon={Gauge}
                  higherIsBetter={false}
                  showDelta={false}
                  action={{ label: "See aged stock", onClick: () => (onSeeAgedStock ? onSeeAgedStock() : null) }}
                />
              );
            })()}
            <KPICard
              testId="inv-kpi-lowstock"
              label="Low-Stock Styles (≤10)"
              sub={rowsLoading ? "Loading SKU detail…" : "Risk of stockout — act fast"}
              value={rowsLoading ? "…" : fmtNum(lowStockByStyle.length)}
              icon={Warning}
              showDelta={false}
              higherIsBetter={false}
              action={{ label: "Review re-order", to: "/reorder" }}
            />
            {(() => {
              // % Understocked Subcategories — share of merchandise subcats
              // where sales-share outpaces stock-share by more than 3 pp
              // (variance > 3). Lower is better; 0% means everything is
              // healthy. Denominator = visible merchandise subcats.
              const merch = (filteredSubcatSS || []);
              const visible = merch;
              const understocked = visible.filter(
                (r) => ((r.pct_of_total_sold || 0) - (r.pct_of_total_stock || 0)) > 3
              );
              const total = visible.length;
              const pct = total > 0 ? (understocked.length / total) * 100 : 0;
              const sub = total === 0
                ? "No subcategory data"
                : `${understocked.length} of ${total} subcats · variance > 3 pp`;
              return (
                <KPICard
                  testId="inv-kpi-understocked-pct"
                  label="% Understocked Subcats"
                  sub={sub}
                  formula={
                    "Understocked = subcats where (sales% − stock%) > 3 pp.\n" +
                    "Result = understocked count ÷ total subcats."
                  }
                  value={total > 0 ? `${pct.toFixed(1)}%` : "—"}
                  icon={TrendDown}
                  higherIsBetter={false}
                  showDelta={false}
                  action={{ label: "See breakdown", onClick: () => document.querySelector('[data-testid="sts-by-subcategory-table"]')?.scrollIntoView({ behavior: "smooth" }) }}
                />
              );
            })()}
          </div>

          <div className="card-white p-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 input-pill flex-1 min-w-[260px]">
              <MagnifyingGlass size={14} className="text-muted" />
              <input
                placeholder="Search product name, style or SKU — filters every chart & table"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                data-testid="inv-search"
                className="bg-transparent outline-none text-[13px] w-full"
              />
            </div>
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                data-testid="inv-search-clear"
                className="px-2.5 py-1.5 rounded-lg text-[12px] text-muted hover:bg-panel"
              >
                Clear
              </button>
            )}
            <MultiSelect
              testId="inv-cat-multi"
              icon={null}
              options={MERCH_CATEGORIES.map((c) => ({ value: c, label: c }))}
              value={merchCats}
              onChange={(v) => {
                setMerchCats(v);
                // Drop any selected subcat that's no longer under the
                // chosen categories so the two stay coherent.
                if (v.length) {
                  const allowed = new Set(subcategoriesFor(v));
                  setMerchSubs((subs) => subs.filter((s) => allowed.has(s)));
                }
              }}
              placeholder="All categories"
              width={170}
            />
            <MultiSelect
              testId="inv-subcat-multi"
              icon={null}
              options={subcategoriesFor(merchCats).map((s) => ({ value: s, label: s }))}
              value={merchSubs}
              onChange={setMerchSubs}
              placeholder="All subcategories"
              width={210}
            />
            <select
              className="input-pill"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              data-testid="inv-brand"
            >
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            {filtersActive && (
              <span className="pill-neutral text-[11px]">
                Filtered — {fmtNum(filteredInv.length)} SKUs · {fmtNum(totalFilteredUnits)} units
              </span>
            )}
          </div>

          <div className="card-white p-5" data-testid="chart-inv-location">
            <SectionTitle
              title={`Stock by location · ${stockByLocation.length} locations`}
              subtitle="All locations sorted by stock-on-hand descending — spot which warehouses and stores are holding the bulk of your inventory and whether the distribution matches sales demand."
            />
            {stockByLocation.length === 0 ? <Empty /> : (
              <div style={{ width: "100%", height: 24 + stockByLocation.length * 22 }}>
                <ResponsiveContainer>
                  <BarChart data={stockByLocation} layout="vertical" margin={{ left: 10, right: 60, top: 4 }}>
                    <CartesianGrid horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => fmtAxisKES(v)} tick={{ fontSize: 10 }} />
                    <YAxis type="category" dataKey="location" width={170} tick={{ fontSize: 10 }} />
                    <Tooltip content={<ChartTooltip formatters={{ units: (v) => `${fmtNum(v)} units` }} />} />
                    <Bar dataKey="units" fill="#1a5c38" radius={[0, 5, 5, 0]}>
                      <LabelList dataKey="units" position="right" formatter={(v) => fmtNum(v)} style={{ fontSize: 10, fill: "#4b5563" }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card-white p-5" data-testid="chart-inv-category">
              <SectionTitle title="Inventory by Category" subtitle="How much stock you have in each category right now." />
              {invByCategory.length === 0 ? <Empty /> : (
                <div style={{ width: "100%", height: 340 }}>
                  <ResponsiveContainer>
                    <BarChart data={invByCategory} margin={{ top: 24, bottom: 60 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="category" interval={0} angle={-20} textAnchor="end" height={70} tick={{ fontSize: 10 }} />
                      <YAxis tickFormatter={(v) => fmtAxisKES(v)} tick={{ fontSize: 10 }} />
                      <Tooltip content={<ChartTooltip formatters={{
                        Inventory: (v, p) => `${fmtNum(v)} units · ${(p?.pct || 0).toFixed(1)}% of total`,
                        current_stock: (v, p) => `${fmtNum(v)} units · ${(p?.pct || 0).toFixed(1)}% of total`,
                      }} />} />
                      <Bar dataKey="current_stock" fill="#1a5c38" radius={[5, 5, 0, 0]} name="Inventory">
                        <LabelList
                          dataKey="current_stock"
                          content={makePctDeltaLabel({
                            data: invByCategory,
                            valueKey: "current_stock",
                            formatValue: (v) => fmtNum(v),
                            position: "top",
                            offset: 8,
                            fontSize: 10,
                            hideDelta: true, // Inventory is a snapshot — no period delta.
                            labelTestId: "inv-cat-bar-label",
                          })}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card-white p-5" data-testid="chart-inv-subcat">
              <SectionTitle title="Inventory by Subcategory" subtitle="Stock-on-hand for the top 15 subcategories. Compare with Sales by Subcategory to spot overstock or thin cover on best-sellers." />
              {invBySubcat.length === 0 ? <Empty /> : (
                <div style={{ width: "100%", height: 340 }}>
                  <ResponsiveContainer>
                    <BarChart data={invBySubcat} margin={{ top: 24, bottom: 80 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="product_type" interval={0} angle={-30} textAnchor="end" height={90} tick={{ fontSize: 9 }} />
                      <YAxis tickFormatter={(v) => fmtAxisKES(v)} tick={{ fontSize: 10 }} />
                      <Tooltip content={<ChartTooltip formatters={{
                        Inventory: (v, p) => `${fmtNum(v)} units · ${(p?.pct || 0).toFixed(1)}% of total`,
                        units: (v, p) => `${fmtNum(v)} units · ${(p?.pct || 0).toFixed(1)}% of total`,
                      }} />} />
                      <Bar dataKey="units" fill="#00c853" radius={[5, 5, 0, 0]} name="Inventory">
                        <LabelList
                          dataKey="units"
                          content={makePctDeltaLabel({
                            data: invBySubcat,
                            valueKey: "units",
                            formatValue: (v) => fmtNum(v),
                            position: "top",
                            offset: 8,
                            fontSize: 9,
                            hideDelta: true, // Inventory is a snapshot — no period delta.
                            labelTestId: "inv-subcat-bar-label",
                          })}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div className="card-white p-5" data-testid="sts-by-subcategory-table">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
              <SectionTitle
                title="Stock-to-Sales · by Subcategory"
                subtitle={
                  <span>
                    Granular view — one row per merchandise subcategory. Switch to Grouped to fold rows under collapsible category headers. Red = action needed (stockout or overstock risk). Green = healthy balance.
                    {stsAppliedRange && (
                      <span className="text-muted"> Units Sold covers <span className="font-semibold text-foreground">{stsAppliedRange.from} → {stsAppliedRange.to}</span> ({stsEffectiveDays}d, this card's own window — not the page filter), so it may not match page-level Units Sold.</span>
                    )}
                    {posSelected && stockScopeIsAuto && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap align-middle"
                        data-testid="sts-subcat-pos-scope-pill"
                      >
                        POS scope: inventory limited to {channels.length === 1 ? channels[0] : `${channels.length} POS`}
                      </span>
                    )}
                  </span>
                }
              />
              <div className="flex items-center gap-2 flex-wrap">
                <DateWindowSelector
                  value={(stsCustomRange.from && stsCustomRange.to) ? -1 : stsWindowDays}
                  onChange={(v) => {
                    if (stsCustomRange.from || stsCustomRange.to) {
                      setStsCustomRange({ from: "", to: "" });
                    }
                    setStsWindowDays(v);
                  }}
                  testId="inv-sts-window"
                />
                {/* Iter 91i — custom date range. Both fields required to
                    activate; the preset highlight clears while custom is
                    in effect; the × clears the override. */}
                <div
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-2 py-1"
                  data-testid="inv-sts-custom-range"
                  title="Override the preset window with an explicit date range."
                >
                  <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Custom</span>
                  <input
                    type="date"
                    value={stsCustomRange.from || ""}
                    onChange={(e) => setStsCustomRange((p) => ({ ...p, from: e.target.value }))}
                    data-testid="inv-sts-custom-from"
                    className="text-[10.5px] font-semibold bg-transparent focus:outline-none border-0 px-1 py-0.5"
                  />
                  <span className="text-[10.5px] text-muted">→</span>
                  <input
                    type="date"
                    value={stsCustomRange.to || ""}
                    onChange={(e) => setStsCustomRange((p) => ({ ...p, to: e.target.value }))}
                    data-testid="inv-sts-custom-to"
                    className="text-[10.5px] font-semibold bg-transparent focus:outline-none border-0 px-1 py-0.5"
                  />
                  {(stsCustomRange.from || stsCustomRange.to) && (
                    <button
                      type="button"
                      onClick={() => setStsCustomRange({ from: "", to: "" })}
                      data-testid="inv-sts-custom-clear"
                      className="text-[10.5px] text-rose-600 hover:text-rose-700 font-bold px-1"
                      title="Clear custom range, revert to preset window"
                    >×</button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end mb-2 -mt-1">
              <div className="inline-flex rounded-md overflow-hidden border border-[#fcd9b6]" data-testid="sts-view-toggle">
                <button
                  onClick={() => setStsView("flat")}
                  data-testid="sts-view-flat"
                  className={`text-[11px] font-bold px-2.5 py-1 transition-colors ${stsView === "flat" ? "bg-[#1a5c38] text-white" : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"}`}
                >
                  Flat table
                </button>
                <button
                  onClick={() => setStsView("grouped")}
                  data-testid="sts-view-grouped"
                  className={`text-[11px] font-bold px-2.5 py-1 transition-colors ${stsView === "grouped" ? "bg-[#1a5c38] text-white" : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"}`}
                >
                  Grouped by category
                </button>
              </div>
            </div>
            {stsView === "grouped" ? (
              <CategoryAccordionTable
                rows={filteredSubcatSS}
                categoryFor={categoryFor}
                testId="inv-sts-subcat-grouped"
                exportName={`inventory-sts-by-subcategory-grouped_${exportSlug}.csv`}
                windowDays={stsEffectiveDays}
              />
            ) : (
            (() => {
              // Iter 91i — compute totals + per-row cover/SOR before the
              // table renders so the footer + Cover/SOR cells all use
              // identical math. Cover = stock ÷ weekly_rate where
              // weekly_rate = units_sold ÷ (window_days/7). SOR =
              // units_sold ÷ (units_sold + stock) × 100.
              const wiw = Math.max(stsEffectiveDays / 7, 1 / 7);
              const tot = (filteredSubcatSS || []).reduce(
                (a, r) => {
                  a.units += r.units_sold || 0;
                  a.stock += r.current_stock || 0;
                  a.pct_sold += r.pct_of_total_sold || 0;
                  a.pct_stock += r.pct_of_total_stock || 0;
                  return a;
                },
                { units: 0, stock: 0, pct_sold: 0, pct_stock: 0 }
              );
              const totCover = tot.units > 0 ? tot.stock / (tot.units / wiw) : null;
              const totSor = (tot.units + tot.stock) > 0 ? (tot.units / (tot.units + tot.stock)) * 100 : 0;
              const totVariance = tot.pct_sold - tot.pct_stock;
              const coverFormula = `Weeks of Cover = Stock Units ÷ (Units Sold ÷ ${wiw.toFixed(1)} weeks)`;
              const sorFormula = "Sell-Out Rate (SOR) = Units Sold ÷ (Units Sold + Stock) × 100";
              return (
            <SortableTable
              testId="inv-sts-subcat"
              exportName={`inventory-sts-by-subcategory_${exportSlug}.csv`}
              pageSize={15}
              initialSort={{ key: "variance_abs", dir: "desc" }}
              secondarySort={{ key: "units_sold", dir: "desc" }}
              columns={[
                {
                  key: "category", label: "Category", align: "left",
                  sortValue: (r) => categoryFor(r.subcategory) || "",
                  render: (r) => <span className="pill-neutral">{categoryFor(r.subcategory) || "—"}</span>,
                  csv: (r) => categoryFor(r.subcategory),
                },
                { key: "subcategory", label: "Subcategory", align: "left" },
                { key: "units_sold", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units_sold) },
                { key: "current_stock", label: "Inventory Units", numeric: true, render: (r) => fmtNum(r.current_stock) },
                { key: "pct_of_total_sold", label: "% Units Sales", numeric: true, render: (r) => fmtPct(r.pct_of_total_sold, 2) },
                { key: "pct_of_total_stock", label: "% Units Inventory", numeric: true, render: (r) => fmtPct(r.pct_of_total_stock, 2) },
                {
                  key: "weeks_of_cover", label: "Cover (wks)", numeric: true,
                  headerTitle: `${coverFormula}. <4w = restock · 4–17w = healthy · >17w = markdown candidate.`,
                  sortValue: (r) => {
                    if (!(r.units_sold > 0)) return -1;
                    return (r.current_stock || 0) / ((r.units_sold || 0) / wiw);
                  },
                  render: (r) => {
                    if (!(r.units_sold > 0)) return <span className="text-muted text-[10px] italic">Idle</span>;
                    const w = (r.current_stock || 0) / ((r.units_sold || 0) / wiw);
                    const tone = w < 4 ? "text-rose-700 bg-rose-50 border-rose-200"
                      : w > 17 ? "text-amber-700 bg-amber-50 border-amber-200"
                      : "text-emerald-700 bg-emerald-50 border-emerald-200";
                    const weekly = (r.units_sold || 0) / wiw;
                    const title = `${coverFormula}\n= ${fmtNum(r.current_stock)} ÷ (${fmtNum(r.units_sold)} ÷ ${wiw.toFixed(1)})\n= ${fmtNum(r.current_stock)} ÷ ${weekly.toFixed(1)} units/week\n= ${w.toFixed(1)} weeks`;
                    return (
                      <span
                        className={`inline-flex items-center gap-0.5 rounded-md border font-semibold text-[10.5px] px-1.5 py-0.5 tabular-nums ${tone} cursor-help`}
                        title={title}
                      >
                        {w.toFixed(1)}w
                      </span>
                    );
                  },
                  csv: (r) => r.units_sold > 0 ? ((r.current_stock || 0) / ((r.units_sold || 0) / wiw)).toFixed(2) : "",
                },
                {
                  key: "sor_pct", label: "SOR %", numeric: true,
                  headerTitle: `${sorFormula}. Higher = stock turns faster; 100% means everything sold; 0% means nothing has sold yet.`,
                  sortValue: (r) => {
                    const denom = (r.units_sold || 0) + (r.current_stock || 0);
                    return denom > 0 ? ((r.units_sold || 0) / denom) * 100 : 0;
                  },
                  render: (r) => {
                    const denom = (r.units_sold || 0) + (r.current_stock || 0);
                    if (denom <= 0) return <span className="text-muted text-[10px]">—</span>;
                    const sor = ((r.units_sold || 0) / denom) * 100;
                    const tone = sor >= 50 ? "text-emerald-700"
                      : sor >= 20 ? "text-foreground"
                      : "text-rose-700";
                    const title = `${sorFormula}\n= ${fmtNum(r.units_sold)} ÷ (${fmtNum(r.units_sold)} + ${fmtNum(r.current_stock)})\n= ${fmtNum(r.units_sold)} ÷ ${fmtNum(denom)}\n= ${sor.toFixed(2)}%`;
                    return (
                      <span
                        className={`tabular-nums font-semibold ${tone} cursor-help`}
                        title={title}
                      >
                        {sor.toFixed(1)}%
                      </span>
                    );
                  },
                  csv: (r) => {
                    const denom = (r.units_sold || 0) + (r.current_stock || 0);
                    return denom > 0 ? (((r.units_sold || 0) / denom) * 100).toFixed(2) : "";
                  },
                },
                {
                  key: "variance", label: "Variance", numeric: true,
                  sortValue: (r) => Math.abs(r.variance || 0),
                  render: (r) => <VarianceCellPts value={r.variance} />,
                  csv: (r) => r.variance?.toFixed(2),
                },
                {
                  key: "risk_flag", label: "Risk Flag", align: "left",
                  render: (r) => <span className="text-[11px] text-muted">{varianceStyle(r.variance).flag}</span>,
                  csv: (r) => varianceStyle(r.variance).flag,
                },
              ]}
              rows={filteredSubcatSS}
              footerRow={
                <>
                  <td className="px-3 py-2 font-extrabold" data-testid="inv-sts-subcat-total-label">Total</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold">{fmtNum(tot.units)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold">{fmtNum(tot.stock)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold">{fmtPct(tot.pct_sold, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold">{fmtPct(tot.pct_stock, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold" title={coverFormula}>
                    {totCover != null ? `${totCover.toFixed(1)}w` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold" title={sorFormula}>
                    {totSor.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-extrabold">
                    {totVariance >= 0 ? "+" : ""}{totVariance.toFixed(2)} pts
                  </td>
                  <td className="px-3 py-2" />
                </>
              }
            />
              );
            })()
            )}
          </div>

          <StockToSalesByVariant
            exportSlug={exportSlug}
            search={serverSearch}
            brand={brandFilter}
            productType={typeFilter}
          />

          <div className="card-white p-5" data-testid="stock-to-sales-section">
            <SectionTitle
              title="Stock cover (units-sold multiplier) by location"
              subtitle={`Stock-to-units-sold multiplier — a HIGH value means low velocity (potential overstock). Weeks of Cover (next table) uses last-4-week velocity and is more actionable for replenishment decisions.${
                stsAppliedRange ? ` Units Sold covers ${stsAppliedRange.from} → ${stsAppliedRange.to} (${stsEffectiveDays}d, this card's own window — not the page filter).` : ""}`}
            />
            <SortableTable
              testId="sts-location"
              exportName={`stock-cover-by-location_${exportSlug}.csv`}
              initialSort={{ key: "stock_to_sales_ratio", dir: "desc" }}
              columns={[
                { key: "location", label: "Location", align: "left", render: (r) => <span className="font-medium">{r.location}</span> },
                { key: "country", label: "Country", align: "left", render: (r) => <CountryDot country={r.country} />, csv: (r) => r.country },
                { key: "units_sold", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units_sold) },
                { key: "current_stock", label: "Current Stock", numeric: true, render: (r) => (r.has_stock_data === false ? <span className="pill-neutral text-[10px]">no stock data</span> : fmtNum(r.current_stock)), csv: (r) => (r.has_stock_data === false ? "" : r.current_stock) },
                { key: "total_sales", label: "Total Sales", numeric: true, render: (r) => <span className="font-semibold">{fmtKES(r.total_sales)}</span>, csv: (r) => r.total_sales },
                {
                  key: "stock_to_sales_ratio",
                  label: (
                    <span title="Stock cover (units-sold multiplier) = current_stock ÷ units_sold_in_period.  High multiplier = low velocity, not necessarily overstocking.">
                      Cover multiplier ⓘ
                    </span>
                  ),
                  numeric: true,
                  sortValue: (r) => (r.has_stock_data === false ? -1 : r.stock_to_sales_ratio || 0),
                  render: (r) => {
                    if (r.has_stock_data === false) return <span className="pill-neutral text-[10px]">no stock data</span>;
                    const v = r.stock_to_sales_ratio || 0;
                    const pill = v > 10 ? "pill-red" : v >= 3 ? "pill-amber" : v >= 1 ? "pill-green" : "pill-neutral";
                    return <span className={pill}>{fmtDec(v, 2)}×</span>;
                  },
                  csv: (r) => (r.has_stock_data === false ? "" : r.stock_to_sales_ratio?.toFixed(2)),
                },
                {
                  key: "weeks_of_cover",
                  label: (
                    <span title="Weeks of Cover = current_stock ÷ (units sold in last 28 days ÷ 4). Ideal ≈ 12 weeks. Red = undercover (< 2w → stockout risk, restock); Amber = low cover (2-4w → monitor); Green = healthy cover (> 4w).">
                      Weeks of Cover ⓘ
                    </span>
                  ),
                  numeric: true,
                  sortValue: (r) => {
                    const v = r.weeks_of_cover;
                    return v == null ? 9999 : v;
                  },
                  render: (r) => {
                    if (r.weeks_of_cover == null) return <span className="pill-neutral">—</span>;
                    const w = r.weeks_of_cover;
                    // Spec bands: < 2w red (stockout risk), 2-4w amber (monitor),
                    // > 4w green (healthy cover; ideal ~12 weeks).
                    const cls = w < 2 ? "pill-red" : w <= 4 ? "pill-amber" : "pill-green";
                    return <span className={cls}>{w.toFixed(1)}w</span>;
                  },
                  csv: (r) => (r.weeks_of_cover == null ? "" : r.weeks_of_cover.toFixed(2)),
                },
              ]}
              rows={filteredSts}
            />
          </div>

          <div className="card-white p-5" data-testid="sell-through-by-location">
            <SectionTitle
              title={`Sell-Through Rate · by Location · ${(filteredSellThrough || []).filter((r) => r.sell_through_pct != null).length} POS`}
              subtitle={`Sell-through % = units sold ${stsAppliedRange ? `(${stsAppliedRange.from} → ${stsAppliedRange.to})` : "in window"} ÷ (units sold + current stock). Uses its own ${stsEffectiveDays || 30}-day window, independent of the page date filter. Higher = stock is actually moving. 25%+ = strong · 12–25% = healthy · 5–12% = slow · <5% = stuck. Use this alongside Weeks-of-Cover to spot overstocked stores.`}
            />
            {(!filteredSellThrough || filteredSellThrough.length === 0) ? (
              <Empty label="No sell-through data for the selected window." />
            ) : (
              <SortableTable
                testId="sell-through-table"
                exportName={`sell-through_${exportSlug}.csv`}
                pageSize={25}
                mobileCards
                initialSort={{ key: "sell_through_pct", dir: "desc" }}
                columns={[
                  { key: "location", label: "Location", align: "left", mobilePrimary: true, render: (r) => <span className="font-medium">{r.location}</span> },
                  { key: "country", label: "Country", align: "left", render: (r) => r.country ? <CountryDot country={r.country} /> : <span>—</span>, csv: (r) => r.country },
                  { key: "units_sold", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units_sold) },
                  { key: "current_stock", label: "Current Stock", numeric: true, render: (r) => (r.has_stock_data === false ? <span className="pill-neutral text-[10px]">no stock data</span> : fmtNum(Math.round(r.current_stock || 0))), csv: (r) => (r.has_stock_data === false ? "" : Math.round(r.current_stock || 0)) },
                  { key: "total_sales", label: "Total Sales", numeric: true, render: (r) => <span className="font-semibold">{fmtKES(r.total_sales)}</span>, csv: (r) => r.total_sales },
                  {
                    key: "sell_through_pct", label: "Sell-Through %", numeric: true,
                    sortValue: (r) => r.sell_through_pct ?? -1,
                    render: (r) => {
                      if (r.sell_through_pct == null) return <span className="pill-neutral text-[10px]">no stock data</span>;
                      const p = r.sell_through_pct;
                      const cls = p >= 25 ? "pill-green" : p >= 12 ? "pill-amber" : p >= 5 ? "pill-amber" : "pill-red";
                      return <span className={cls}>{p.toFixed(1)}%</span>;
                    },
                    csv: (r) => r.sell_through_pct,
                  },
                  {
                    key: "health", label: "Health", align: "left",
                    render: (r) => {
                      const map = {
                        strong:        { label: "Strong",  cls: "pill-green" },
                        healthy:       { label: "Healthy", cls: "pill-green" },
                        slow:          { label: "Slow",    cls: "pill-amber" },
                        stuck:         { label: "Stuck",   cls: "pill-red" },
                        no_stock_data: { label: "No stock", cls: "pill-neutral" },
                      };
                      const m = map[r.health] || map.stuck;
                      return <span className={m.cls}>{m.label}</span>;
                    },
                    csv: (r) => r.health,
                  },
                ]}
                rows={filteredSellThrough}
              />
            )}
            <p className="text-[11px] text-muted italic mt-2">
              ℹ Stock-at-start-of-period is approximated as (current_stock + units_sold) — upstream doesn't keep historical on-hand; mid-period receipts aren't modelled yet.
            </p>
          </div>

          <div className="card-white p-5" data-testid="stock-aging-summary">
            <SectionTitle
              title="Stock Aging · buckets by weeks-on-hand"
              subtitle="Classifies every merchandise style by how long current stock will last at the last-4-week velocity. Phantom = stock ≥ 30 with zero sales in 4 weeks — dead money, transfer or clear immediately."
            />
            {(() => {
              const b = agingSummary.byBucket;
              const total = b.fresh + b.healthy + b.aging + b.stale + b.phantom || 1;
              const tile = (label, count, cls, sub, testId) => {
                const pct = ((count / total) * 100).toFixed(1);
                return (
                  <div className={`rounded-lg p-3 ${cls}`} data-testid={testId}>
                    <div className="text-[10.5px] uppercase tracking-wider opacity-80">{label}</div>
                    <div className="font-extrabold text-[22px] leading-tight mt-0.5">{fmtNum(count)}</div>
                    <div className="text-[10.5px] opacity-80 mt-0.5">{pct}% · {sub}</div>
                  </div>
                );
              };
              return (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
                  {tile("Fresh",   b.fresh,   "bg-emerald-50 text-emerald-900 border border-emerald-200", "< 4w cover",      "aging-bucket-fresh")}
                  {tile("Healthy", b.healthy, "bg-green-50 text-green-900 border border-green-200",       "4–8w cover",      "aging-bucket-healthy")}
                  {tile("Aging",   b.aging,   "bg-amber-50 text-amber-900 border border-amber-200",       "8–16w cover",     "aging-bucket-aging")}
                  {tile("Stale",   b.stale,   "bg-orange-50 text-orange-900 border border-orange-200",    "> 16w cover",     "aging-bucket-stale")}
                  {tile("Phantom", b.phantom, "bg-red-50 text-red-900 border border-red-200",             "≥30 stock · 0 sales/4w", "aging-bucket-phantom")}
                </div>
              );
            })()}
          </div>

          {phantomRows.length > 0 && (
            <div className="card-white p-5" data-testid="phantom-stock-card">
              <SectionTitle
                title={`👻 Phantom Stock · ${phantomRows.length} styles · ${fmtNum(agingSummary.phantomStockUnits)} units locked up`}
                subtitle="Styles carrying ≥ 30 units with zero sales in the last 4 weeks. These are dead money — move them out or clear them. Acting on this list pays for itself within a quarter."
                action={
                  <button
                    type="button"
                    className="text-[11px] text-brand hover:text-brand-deep underline decoration-dotted"
                    onClick={() => window.open('/ibt', '_self')}
                    data-testid="phantom-open-ibt"
                  >
                    IBT candidates →
                  </button>
                }
              />
              <SortableTable
                testId="phantom-stock-table"
                exportName={`phantom-stock_${exportSlug}.csv`}
                pageSize={25}
                mobileCards
                initialSort={{ key: "current_stock", dir: "desc" }}
                columns={[
                  { key: "style_name", label: "Style", align: "left", mobilePrimary: true, render: (r) => <span className="font-medium break-words" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{r.style_name}</span> },
                  { key: "brand", label: "Brand", align: "left", render: (r) => <span className="pill-neutral">{r.brand || "—"}</span>, csv: (r) => r.brand },
                  { key: "subcategory", label: "Subcategory", align: "left", render: (r) => <span className="text-muted">{r.subcategory || "—"}</span> },
                  { key: "current_stock", label: "Stock", numeric: true, render: (r) => <span className="pill-red">{fmtNum(r.current_stock)}</span> },
                  { key: "units_sold_3m", label: "Sold (3 mo)", numeric: true, render: (r) => <span className="text-muted num">{fmtNum(r.units_sold_3m ?? r.units_sold_28d ?? 0)}</span> },
                  {
                    key: "_action", label: "Action", align: "left", sortable: false,
                    render: (r) => {
                      const key = `phantom::${r.style_name}`;
                      return (
                        <RecommendationActionPill
                          itemKey={key}
                          state={dqByKey.get(key)}
                          onChange={(status, opts) => setDqState(key, status, opts)}
                          label="phantom"
                        />
                      );
                    },
                    csv: (r) => dqByKey.get(`phantom::${r.style_name}`)?.status || "pending",
                  },
                ]}
                rows={phantomRows}
              />
            </div>
          )}

          {/* Aged Stock lives in the "Stuck & Declining" tab now (the
              consolidated stuck-stock triage); the Overall-WoC KPI's
              "See aged stock" action switches to that tab. */}
        </>
      )}
    </div>
  );
};

// ── Stuck & Declining tab ─────────────────────────────────────────────────────
// "What's stuck and what's dying?" — THE consolidated slow-stock triage:
//   * Declining styles — last 28d units < 60% of the prior 28d, still holding
//     store stock (candidates for Markdown & Clearance).
//   * Phantom / stuck styles — stock ≥ 30 with zero last-28d sales, from the
//     same /analytics/weeks-of-cover dataset as the aging buckets.
//   * Excess-allowance flags — per-store summary of the same dataset as the
//     Excess Inventory page (reconciles 1:1).
//   * Store overstock ranking — per-store weeks of cover on the canonical
//     recency-weighted (EWMA 56d) weekly rate, worst first.
//   * Aged-in-store — the AgedStockReport (SKU-store rows unsold ≥ N days),
//     the same report Warehouse Returns acts on.
// Deep links hand off to the operational pages that ACT on the findings
// (Warehouse Returns, Excess Inventory, Markdown & Clearance).
const StuckDeclining = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { countries, channels, dataVersion } = applied;
  const params = {
    ...(countries?.length ? { country: countries.join(",") } : {}),
    ...(channels?.length ? { channel: channels.join(",") } : {}),
  };

  const [declining, setDeclining] = useState(null);
  const [decliningError, setDecliningError] = useState(null);
  const [overstock, setOverstock] = useState(null);
  const [overstockError, setOverstockError] = useState(null);
  // Phantom/stuck styles come from the same canonical /analytics/weeks-of-cover
  // dataset the Stock-on-Hand aging buckets use (stock ≥ 30, zero last-28d
  // sales) so the two surfaces always agree on what "phantom" means.
  const [phantom, setPhantom] = useState(null);
  const [phantomError, setPhantomError] = useState(null);
  // Excess-allowance flags: the per-POS summary from the same dataset that
  // powers the Excess Inventory operational page, so figures reconcile 1:1.
  const [excess, setExcess] = useState(null);
  const [excessError, setExcessError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setDeclining(null); setDecliningError(null);
    setOverstock(null); setOverstockError(null);
    setPhantom(null); setPhantomError(null);
    setExcess(null); setExcessError(null);
    api.get("/analytics/declining-styles", { params })
      .then((r) => { if (!cancelled) { setDeclining(r.data || []); touchLastUpdated(); } })
      .catch((e) => !cancelled && setDecliningError(e?.response?.data?.detail || e.message));
    api.get("/analytics/store-overstock", { params })
      .then((r) => { if (!cancelled) setOverstock(r.data || []); })
      .catch((e) => !cancelled && setOverstockError(e?.response?.data?.detail || e.message));
    api.get("/analytics/weeks-of-cover", { params })
      .then((r) => {
        if (cancelled) return;
        const rows = Array.isArray(r.data) ? r.data : (r.data?.rows || []);
        // Same rule as the Stock-on-Hand aging buckets: heavy stock, zero
        // last-28-day sales — stock that exists on paper but is not moving.
        setPhantom(rows.filter(
          (x) => Number(x.available || 0) >= 30 && Number(x.units_sold_28d || 0) === 0));
      })
      .catch((e) => !cancelled && setPhantomError(e?.response?.data?.detail || e.message));
    api.get("/analytics/excess-inventory")
      .then((r) => { if (!cancelled) setExcess(r.data || null); })
      .catch((e) => !cancelled && setExcessError(e?.response?.data?.detail || e.message));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const decliningCols = [
    { key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.style_name || "—"}</span> },
    { key: "brand", label: "Brand", render: (r) => r.brand || "—" },
    { key: "product_type", label: "Subcategory", render: (r) => r.product_type || "—" },
    { key: "units_prior_28d", label: "Prior 28d", numeric: true, render: (r) => fmtNum(r.units_prior_28d) },
    { key: "units_28d", label: "Last 28d", numeric: true, render: (r) => fmtNum(r.units_28d) },
    { key: "change_pct", label: "Change", numeric: true,
      render: (r) => (r.change_pct == null ? "—"
        : <span className="text-danger font-semibold">{fmtDec(r.change_pct, 1)}%</span>) },
    { key: "store_stock", label: "Store Stock", numeric: true, render: (r) => fmtNum(r.store_stock) },
    { key: "weeks_of_cover", label: "Weeks Cover", numeric: true,
      sortValue: (r) => (r.weeks_of_cover == null ? Infinity : Number(r.weeks_of_cover)),
      render: (r) => (r.weeks_of_cover == null ? "—" : fmtDec(r.weeks_of_cover, 1)) },
  ];

  const phantomCols = [
    { key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.style_name || "—"}</span> },
    { key: "subcategory", label: "Subcategory", render: (r) => r.subcategory || "—" },
    { key: "available", label: "Store Stock", numeric: true, render: (r) => fmtNum(r.available) },
    { key: "units_sold_28d", label: "Last 28d Units", numeric: true, render: (r) => fmtNum(r.units_sold_28d) },
    { key: "weekly_units", label: "Rate / wk", numeric: true,
      headerTitle: "Canonical recency-weighted weekly units (EWMA over trailing 56 days)",
      render: (r) => fmtDec(r.weekly_units, 1) },
  ];

  const excessCols = [
    { key: "pos_location", label: "Store", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.pos_location || "—"}</span> },
    { key: "skus", label: "SKUs", numeric: true, render: (r) => fmtNum(r.skus) },
    { key: "total_inventory", label: "Total Units", numeric: true, render: (r) => fmtNum(r.total_inventory) },
    { key: "return_skus", label: "SKUs Flagged Return", numeric: true, render: (r) => fmtNum(r.return_skus) },
    { key: "excess_inventory", label: "Excess Units", numeric: true,
      render: (r) => <span className={Number(r.excess_inventory) > 0 ? "text-danger font-semibold" : ""}>{fmtNum(r.excess_inventory)}</span> },
  ];

  const overstockCols = [
    { key: "store", label: "Store", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.store || "—"}</span> },
    { key: "country", label: "Country", render: (r) => r.country || "—" },
    { key: "soh_units", label: "Stock on Hand", numeric: true, render: (r) => fmtNum(r.soh_units) },
    { key: "skus", label: "SKUs", numeric: true, render: (r) => fmtNum(r.skus) },
    { key: "weekly_units", label: "Rate / wk", numeric: true,
      headerTitle: "Recency-weighted weekly units (EWMA over trailing 56 days)",
      render: (r) => fmtDec(r.weekly_units, 1) },
    { key: "weeks_of_cover", label: "Weeks Cover", numeric: true,
      headerTitle: "Stock on hand ÷ weekly rate — high cover = overstocked",
      sortValue: (r) => (r.weeks_of_cover == null ? Infinity : Number(r.weeks_of_cover)),
      render: (r) => (r.weeks_of_cover == null
        ? <span className="text-danger font-semibold">No sales</span>
        : fmtDec(r.weeks_of_cover, 1)) },
  ];

  return (
    <div className="space-y-6" data-testid="stuck-declining-tab">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="text-muted">Act on findings:</span>
        <Link to="/warehouse-returns" className="text-brand underline underline-offset-2" data-testid="link-warehouse-returns">Warehouse Returns</Link>
        <span className="text-muted">·</span>
        <Link to="/excess-inventory" className="text-brand underline underline-offset-2" data-testid="link-excess-inventory">Excess Inventory</Link>
        <span className="text-muted">·</span>
        <Link to="/markdown-clearance" className="text-brand underline underline-offset-2" data-testid="link-markdown-clearance">Markdown &amp; Clearance</Link>
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Declining styles"
          subtitle="Still holding store stock but decelerating: last-28-day units under 60% of the prior 28 days (prior base ≥ 10 units). Candidates for markdown or return."
          testId="declining-styles-section"
        />
        {decliningError ? <ErrorBox message={decliningError} /> :
         declining === null ? <Loading label="Finding declining styles…" /> :
          <SortableTable
            columns={decliningCols}
            rows={declining}
            initialSort={{ key: "change_pct", dir: "asc" }}
            exportName="declining-styles.csv"
            testId="declining-styles-table"
            pageSize={25}
            mobileCards
            emptyLabel="No declining styles for the selected filters — nothing is decelerating with stock left."
          />}
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Phantom / stuck styles"
          subtitle="Heavy store stock (≥ 30 units) with ZERO sales in the last 28 days — stock that exists on paper but is not moving. Same rule as the Stock-on-Hand aging buckets. Pull back via Warehouse Returns."
          testId="phantom-styles-section"
        />
        {phantomError ? <ErrorBox message={phantomError} /> :
         phantom === null ? <Loading label="Finding phantom stock…" /> :
          <SortableTable
            columns={phantomCols}
            rows={phantom}
            initialSort={{ key: "available", dir: "desc" }}
            exportName="phantom-styles.csv"
            testId="phantom-styles-table"
            pageSize={25}
            mobileCards
            emptyLabel="No phantom stock — every heavily stocked style sold in the last 28 days."
          />}
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Excess-allowance flags by store"
          subtitle="Per-store excess against the per-brand per-size allowance table — the same dataset as the Excess Inventory page, so figures reconcile 1:1. Act on the flagged SKUs on the Excess Inventory page."
          testId="excess-flags-section"
        />
        {excessError ? <ErrorBox message={excessError} /> :
         excess === null ? <Loading label="Checking excess allowances…" /> :
          <>
            <div className="text-[12.5px] text-muted mb-2" data-testid="excess-flags-totals">
              {fmtNum(excess?.totals?.return_skus || 0)} SKU-store rows flagged Return ·{" "}
              {fmtNum(excess?.totals?.excess_inventory || 0)} excess units across{" "}
              {fmtNum((excess?.summary || []).length)} stores —{" "}
              <Link to="/excess-inventory" className="text-brand underline underline-offset-2">open Excess Inventory to act</Link>
            </div>
            <SortableTable
              columns={excessCols}
              rows={excess?.summary || []}
              initialSort={{ key: "excess_inventory", dir: "desc" }}
              exportName="excess-flags-by-store.csv"
              testId="excess-flags-table"
              pageSize={25}
              mobileCards
              emptyLabel="No stock above the excess allowances."
            />
          </>}
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Store overstock ranking"
          subtitle="Weeks of cover per store: store-floor stock ÷ recency-weighted weekly rate of sale (warehouses & production pipeline excluded). Worst first."
          testId="store-overstock-section"
        />
        {overstockError ? <ErrorBox message={overstockError} /> :
         overstock === null ? <Loading label="Ranking store cover…" /> :
          <SortableTable
            columns={overstockCols}
            rows={overstock}
            initialSort={{ key: "weeks_of_cover", dir: "desc" }}
            exportName="store-overstock.csv"
            testId="store-overstock-table"
            pageSize={25}
            mobileCards
            emptyLabel="No store stock for the selected filters."
          />}
      </div>

      {/* Aged-in-store: SKU-store rows that haven't sold at that store in N
          days — the same report Warehouse Returns acts on, surfaced here so
          "what's stuck" is answerable in one place. */}
      <AgedStockReport />
    </div>
  );
};

// ── Page wrapper: question-driven tabs ─────────────────────────────────────
// "How much stock and where?" — the Stock on Hand view above.
// "How fast is it selling?" — the former standalone Velocity page (canonical
// EWMA weeks-of-cover), merged here as a tab; the old /velocity URL redirects
// to /inventory and the "velocity" page id is aliased server-side.
// "What's stuck and what's dying?" — the consolidated StuckDeclining tab.
const VelocityTab = React.lazy(() => import("./Velocity"));

const INV_TABS = [
  { id: "stock", label: "Stock on Hand" },
  { id: "velocity", label: "Velocity & Cover" },
  { id: "stuck", label: "Stuck & Declining" },
];

const InventoryPage = () => {
  const [tab, setTab] = useState("stock");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 border-b border-border" data-testid="inventory-tabs">
        {INV_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`inventory-tab-${t.id}`}
            className={
              "px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors " +
              (tab === t.id
                ? "border-[#1a5c38] text-[#1a5c38]"
                : "border-transparent text-muted hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "stock" ? <Inventory onSeeAgedStock={() => setTab("stuck")} /> : null}
      {tab === "velocity" ? (
        <React.Suspense fallback={<Loading label="Loading velocity…" />}>
          <VelocityTab />
        </React.Suspense>
      ) : null}
      {tab === "stuck" ? <StuckDeclining /> : null}
    </div>
  );
};

export default InventoryPage;
