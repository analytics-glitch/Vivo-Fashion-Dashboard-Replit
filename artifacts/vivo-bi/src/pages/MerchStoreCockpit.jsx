/**
 * MerchStoreCockpit — Store Detail tab in the Merchandising Hub.
 *
 * Uses /api/analytics/product-analysis as the sole KPI source, so every
 * number here is byte-identical to the Style Cockpit for the same scope
 * (same Vivo-brand filter, same formula, same date window).
 *
 * /api/merch/by-store is kept only for:
 *   • the store picker list
 *   • the Optimal Stock context strip (pos_locations metadata)
 *   • Rev/sq ft (store-level, period-averaged)
 */
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, fmtKES, fmtKESLong, fmtNum, fmtPct, fmtDate, fmtDec } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import SortableTable from "@/components/SortableTable";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { useMerchFilters } from "./MerchandisingHub";
import { sorGapColor, useMerchPeriodLabel } from "./merch/MerchHelpers";
import {
  Storefront, Package, ChartBar, Percent, Tag, TrendUp, CurrencyCircleDollar,
  Warning,
} from "@phosphor-icons/react";
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer, LabelList,
  Cell, Legend, ScatterChart, Scatter, ZAxis,
} from "recharts";

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmtSor = (v) => v == null ? "—" : `${v}%`;
const fmtWoc = (v) => v == null ? "—" : `${v}w`;
const wocCls = (w) =>
  w == null ? "" : w < 2 ? "text-red-500 font-semibold" : w < 4 ? "text-amber-500" : "";

// ── Tier badge (store tier A / B / C) ────────────────────────────────────────
const TierBadge = ({ tier }) => {
  const map = {
    A: { label: "Flagship",          cls: "bg-brand/10 text-brand border-brand/30" },
    B: { label: "Standard",          cls: "bg-blue-50 text-blue-700 border-blue-200" },
    C: { label: "Boutique/Regional", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  };
  const t = map[tier] || { label: tier || "—", cls: "bg-slate-100 text-slate-600 border-slate-200" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${t.cls}`}>
      {t.label}
    </span>
  );
};

// ── Action pill (maps PA recommendation field) ────────────────────────────────
const PILL = {
  "Restock":     "bg-rose-100 text-rose-700 border-rose-300",
  "Reorder Soon":"bg-amber-100 text-amber-700 border-amber-300",
  "Transfer Out":"bg-teal-100 text-teal-700 border-teal-300",
  "Mark Down":   "bg-purple-100 text-purple-700 border-purple-300",
  "Retire":      "bg-red-100 text-red-700 border-red-300",
  "Monitor":     "bg-blue-100 text-blue-700 border-blue-300",
};
const ActionPill = ({ action }) => {
  if (!action) return "—";
  const cls = PILL[action] || "bg-emerald-100 text-emerald-700 border-emerald-300";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold ${cls}`}>
      {action}
    </span>
  );
};

// ── All-stores chart helpers (restored from the original Store Detail pages) ──
const WOC_COLOR = (woc) => {
  if (woc == null) return "#94a3b8";
  if (woc < 4)  return "#ef4444";
  if (woc <= 8) return "#d97706";
  return "#1a5c38";
};
const TIER_COLOR = { A: "#1a5c38", B: "#4b7bec", C: "#94a3b8" };
const SCATTER_COLORS = ["#1a5c38", "#4b7bec", "#d97706", "#0891b2", "#7c3aed",
  "#be185d", "#065f46", "#ef4444", "#9f1239", "#1e40af"];
const truncate = (s, n = 24) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg p-3 text-[12px] min-w-[180px]">
      <p className="font-bold text-foreground mb-1">{d.store}</p>
      <p className="text-muted">Avg WOC: <span className="font-medium text-foreground">{d.avg_woc != null ? fmtDec(d.avg_woc, 1) + " wks" : "—"}</span></p>
      <p className="text-muted">Avg SOR: <span className="font-medium text-foreground">{d.avg_sor != null ? fmtDec(d.avg_sor, 1) + "%" : "—"}</span></p>
      <p className="text-muted">Revenue: <span className="font-medium text-foreground">{fmtKES(d.revenue || 0)}</span></p>
      <p className="text-muted">Style count: <span className="font-medium text-foreground">{fmtNum(d.style_count || 0)}</span></p>
    </div>
  );
};

const StoreSizeAnalysis = ({ rows, selectedStore, periodLabel }) => {
  const sorRows = useMemo(() => [...rows]
    .map(r => ({
      ...r,
      name: r.size || "—",
      sorValue: r.sor == null ? -1 : Number(r.sor),
      networkSorValue: r.network_sor == null ? null : Number(r.network_sor),
      sorLabel: r.sor == null ? "—" : `${Number(r.sor).toFixed(1)}%`,
    }))
    .sort((a, b) => (b.sorValue - a.sorValue) || (b.units_sold - a.units_sold)), [rows]);
  const sohRows = useMemo(() => [...rows]
    .map(r => ({
      ...r,
      name: r.size || "—",
      sohValue: Number(r.soh || 0),
      sohLabel: `${fmtNum(r.soh)} · ${r.soh_share == null ? "—" : `${Number(r.soh_share).toFixed(1)}%`}`,
    }))
    .sort((a, b) => (b.sohValue - a.sohValue) || a.name.localeCompare(b.name)), [rows]);

  if (!rows.length) return <Empty label="No size-level stock or sales are available for this scope." />;
  return (
    <div className="card-white p-5" data-testid="msc-size-analysis">
      <div className="mb-3">
        <div className="eyebrow">Size Analysis</div>
        <div className="text-[11.5px] text-muted mt-1">
          {selectedStore || "All Stores"} · {periodLabel || "selected period"} · active styles only
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-5">
        <div>
          <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
            Sell-Through by Size (SOR)
          </div>
          <div className="text-[10px] text-foreground/50 mb-1">
            Store SOR with weighted All Stores benchmark by size
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={sorRows} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                angle={-45} textAnchor="end" height={64} />
              <YAxis tick={{ fontSize: 9 }} domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]} tickFormatter={v => `${v}%`} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                    <div className="font-bold mb-0.5">{d.name}</div>
                    <div>Store SOR: <span className="font-semibold">{d.sor == null ? "—" : `${Number(d.sor).toFixed(1)}%`}</span></div>
                    <div>All Stores: {d.network_sor == null ? "—" : `${Number(d.network_sor).toFixed(1)}%`}</div>
                    <div>Units sold: {fmtNum(d.units_sold)}</div>
                    <div>SOH: {fmtNum(d.soh)}</div>
                  </div>
                );
              }} />
              <Bar dataKey="sor" fill="#4b7bec" radius={[3, 3, 0, 0]} minPointSize={2}>
                <LabelList dataKey="sorLabel" position="top"
                  style={{ fontSize: 8, fill: "#64748b", fontWeight: 700 }} />
              </Bar>
              <Line type="monotone" dataKey="network_sor" name="All Stores benchmark"
                stroke="#1f2937" strokeWidth={2} dot={{ r: 3, fill: "#1f2937" }}
                activeDot={{ r: 4 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-1 text-[10px] text-foreground/60">
            <span className="inline-block w-7 border-t-2 border-[#1f2937] align-middle mr-1.5" />
            All Stores benchmark per size
          </div>
        </div>
        <div>
          <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
            Stock on Hand by Size
          </div>
          <div className="text-[10px] text-foreground/50 mb-1">
            Current store stock · labels show units and share of store SOH
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={sohRows} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                angle={-45} textAnchor="end" height={64} />
              <YAxis tick={{ fontSize: 9 }} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                    <div className="font-bold mb-0.5">{d.name}</div>
                    <div>SOH: <span className="font-semibold">{fmtNum(d.soh)}</span></div>
                    <div>Store SOH share: {d.soh_share == null ? "—" : `${Number(d.soh_share).toFixed(1)}%`}</div>
                    <div>SOR: {d.sor == null ? "—" : `${Number(d.sor).toFixed(1)}%`}</div>
                  </div>
                );
              }} />
              <Bar dataKey="soh" fill="#4b7bec" radius={[3, 3, 0, 0]} minPointSize={2}>
                <LabelList dataKey="sohLabel" position="top"
                  style={{ fontSize: 8, fill: "#64748b", fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

// ── Store picker ──────────────────────────────────────────────────────────────
const StorePicker = ({ stores, value, onChange }) => (
  <select
    className="w-full border border-line rounded-lg px-3 py-2 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
    value={value}
    onChange={e => onChange(e.target.value)}
  >
    <option value="">All Stores</option>
    {stores.map(s => <option key={s.store} value={s.store}>{s.store}</option>)}
  </select>
);

// ── Main component ────────────────────────────────────────────────────────────
const MerchStoreCockpit = () => {
  const filters = useMerchFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedStore = searchParams.get("store") || "";

  const pageFrom    = filters.storeFrom        || "";
  const pageTo      = filters.storeTo          || "";
  const compareFrom = filters.storeCompareFrom || null;
  const compareTo   = filters.storeCompareTo   || null;
  const compareMode = filters.storeCompareMode || "none";
  const periodLabel = useMerchPeriodLabel();

  // ── Store list (for picker + optimal context) ─────────────────────────────
  const [stores, setStores] = useState([]);
  useEffect(() => {
    apiFetch("/merch/by-store", {
      params: {
        from_date:   pageFrom   || undefined,
        to_date:     pageTo     || undefined,
        country:     filters.country     || undefined,
        brand:       filters.brand       || undefined,
        subcategory: filters.subcategory || undefined,
      },
    })
      .then(d => setStores(d.rows || []))
      .catch(() => setStores([]));
  }, [pageFrom, pageTo, filters.country, filters.brand, filters.subcategory, filters.dataVersion]);

  // WOC velocity basis: when the selected range ends before today, WOC should
  // reflect that window's run-rate (in-period units ÷ weeks in range). A range
  // ending today keeps the legacy trailing-30-day velocity so default numbers
  // don't shift.
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  const periodVelocity = Boolean(pageFrom && pageTo && pageTo < todayStr);

  // ── PA params — shared by both primary + compare fetches ─────────────────
  const paBase = useMemo(() => ({
    store:        selectedStore || undefined,
    brand:        filters.brand        || undefined,
    subcategory:  filters.subcategory  || undefined,
    country:      filters.country      || undefined,
    status:       "active",
  }), [selectedStore, filters.brand, filters.subcategory, filters.country]);

  // ── Primary period ────────────────────────────────────────────────────────
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [sizeAnalysis, setSizeAnalysis] = useState([]);
  const [sizeLoading, setSizeLoading] = useState(false);
  const [sizeError, setSizeError] = useState(null);

  useEffect(() => {
    if (!pageFrom || !pageTo) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch("/analytics/product-analysis", {
      params: {
        ...paBase, date_from: pageFrom, date_to: pageTo,
        velocity_basis: periodVelocity ? "period" : undefined,
      },
    })
      .then(d  => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(()=> { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [paBase, pageFrom, pageTo, periodVelocity, filters.dataVersion]);

  // Size analysis is independently aggregated for the selected store and the
  // network benchmark, so it stays useful even when the style table is capped.
  useEffect(() => {
    if (!pageFrom || !pageTo) return;
    let cancelled = false;
    setSizeLoading(true);
    setSizeError(null);
    apiFetch("/merch/store-sizes", {
      params: {
        store: selectedStore || undefined,
        from_date: pageFrom,
        to_date: pageTo,
        country: filters.country || undefined,
        brand: filters.brand || undefined,
        subcategory: filters.subcategory || undefined,
      },
    })
      .then(d => { if (!cancelled) setSizeAnalysis(d.sizes || []); })
      .catch(e => {
        if (!cancelled) setSizeError(e?.response?.data?.detail || e.message);
      })
      .finally(() => { if (!cancelled) setSizeLoading(false); });
    return () => { cancelled = true; };
  }, [
    selectedStore, pageFrom, pageTo, filters.country, filters.brand,
    filters.subcategory, filters.dataVersion,
  ]);

  // ── Compare period ────────────────────────────────────────────────────────
  const [cmpData, setCmpData] = useState(null);
  useEffect(() => {
    if (!compareFrom || !compareTo) { setCmpData(null); return; }
    let cancelled = false;
    apiFetch("/analytics/product-analysis", {
      params: { ...paBase, date_from: compareFrom, date_to: compareTo },
    })
      .then(d  => { if (!cancelled) setCmpData(d); })
      .catch(() => { if (!cancelled) setCmpData(null); });
    return () => { cancelled = true; };
  }, [paBase, compareFrom, compareTo, filters.dataVersion]);

  // ── Derived values ────────────────────────────────────────────────────────
  const summary    = data?.summary    || null;
  const cmpSummary = cmpData?.summary || null;
  const rows       = data?.rows       || [];
  const byBrand    = data?.by_brand   || [];
  const otherBrands = data?.other_brands_summary || null;

  const storeRow = useMemo(
    () => stores.find(s => s.store === selectedStore) || null,
    [stores, selectedStore],
  );

  const hasCompare = Boolean(compareFrom && compareTo && cmpSummary);

  const pctDelta = (curr, prev) =>
    prev && prev > 0 ? Math.round(((curr ?? 0) - prev) / prev * 100) : null;

  const revDelta   = hasCompare ? pctDelta(summary?.revenue,     cmpSummary.revenue)     : null;
  const unitsDelta = hasCompare ? pctDelta(summary?.units,       cmpSummary.units)       : null;
  const stockDelta = hasCompare ? pctDelta(summary?.stock_units, cmpSummary.stock_units) : null;
  const discountedSorGap = summary?.discounted_sor_gap_pp;

  // ASP — computed from the same PA data as all other metrics (consistent formula)
  const asp    = summary    && summary.units    > 0 ? Math.round(summary.revenue    / summary.units)    : null;
  const cmpAsp = cmpSummary && cmpSummary.units > 0 ? Math.round(cmpSummary.revenue / cmpSummary.units) : null;
  const aspDelta = hasCompare && asp != null && cmpAsp != null && cmpAsp > 0
    ? Math.round((asp - cmpAsp) / cmpAsp * 100) : null;

  // All-store average ASP — derived from by-store revenue_3m / units_3m (fast, already fetched)
  // Only meaningful when a specific store is selected so there's an "overall" to compare against.
  const allStoresAsp = useMemo(() => {
    if (!selectedStore || !stores.length) return null;
    const totalRev   = stores.reduce((s, r) => s + (r.revenue_3m || 0), 0);
    const totalUnits = stores.reduce((s, r) => s + (r.units_3m   || 0), 0);
    return totalUnits > 0 ? Math.round(totalRev / totalUnits) : null;
  }, [stores, selectedStore]);

  // ── Restored chart data (originally on the Store Detail / Stores tabs) ────
  // Revenue by store — top 15, coloured by tier
  const revBars = useMemo(() =>
    [...stores]
      .sort((a, b) => (b.revenue_3m || 0) - (a.revenue_3m || 0))
      .slice(0, 15)
      .map(r => ({
        name: truncate(r.store, 22),
        rev:  Math.round((r.revenue_3m || 0) / 1000),
        fill: TIER_COLOR[r.store_tier] || "#94a3b8",
      })), [stores]);

  // Stock by store — top 15, coloured by WOC health
  const stockBars = useMemo(() =>
    [...stores]
      .sort((a, b) => (b.total_stock || 0) - (a.total_stock || 0))
      .slice(0, 15)
      .map(r => ({
        name:  truncate(r.store, 22),
        stock: r.total_stock || 0,
        fill:  WOC_COLOR(r.avg_woc),
      })), [stores]);

  // Store efficiency scatter — WOC vs SOR, bubble = revenue
  const scatterData = useMemo(() =>
    stores
      .filter(r => r.avg_woc != null && r.avg_sor != null)
      .map((r, i) => ({
        store:       r.store,
        avg_woc:     Math.round(r.avg_woc * 10) / 10,
        avg_sor:     Math.round(r.avg_sor * 10) / 10,
        revenue:     r.revenue_3m || 0,
        style_count: r.style_count || 0,
        z:           Math.max(50, Math.min(800, (r.revenue_3m || 0) / 5000)),
        fill:        SCATTER_COLORS[i % SCATTER_COLORS.length],
      })), [stores]);

  // Actual vs optimal stock — stores with a configured optimal only
  const allStoresOptChart = useMemo(() =>
    stores
      .filter(s => s.optimal_stock != null)
      .sort((a, b) => (b.revenue_3m || 0) - (a.revenue_3m || 0))
      .map(s => ({
        name:    s.store,
        actual:  s.total_stock || 0,
        optimal: s.optimal_stock,
      })), [stores]);

  // Rev / sq ft per store (monthly average over the selected range)
  const numMonths = useMemo(() => {
    if (!pageFrom || !pageTo) return 3;
    const days = Math.max(1, Math.round((new Date(pageTo) - new Date(pageFrom)) / 86400000) + 1);
    return Math.max(1, days / 30.44);
  }, [pageFrom, pageTo]);
  const revSqftChart = useMemo(() =>
    stores
      .filter(s => s.sqft > 0 && (s.revenue_3m || 0) > 0)
      .map(s => ({
        name:    s.store,
        revSqft: Math.round((s.revenue_3m / numMonths) / s.sqft),
      }))
      .sort((a, b) => b.revSqft - a.revSqft), [stores, numMonths]);

  // Revenue by category — from the same PA payload as the KPI band
  const subcatChart = useMemo(() =>
    (data?.by_subcategory || [])
      .slice(0, 10)
      .map(r => ({ name: r.subcategory || "Other", revenue: Math.round((r.revenue || 0) / 1000) })),
    [data]);

  // At-risk styles — any style whose recommendation calls for action
  const atRiskCount = useMemo(() =>
    rows.filter(r => {
      const rec = (r.recommendation || "").toLowerCase();
      return rec && rec !== "on track" && rec !== "healthy" && rec !== "monitor";
    }).length, [rows]);

  // Colour styles + sales/sqft (store or all-store aggregate)
  const colourStyleCount = useMemo(() => {
    if (selectedStore) return storeRow?.colour_style_count ?? null;
    if (!stores.length) return null;
    return stores.reduce((s, r) => s + (r.colour_style_count || 0), 0);
  }, [selectedStore, storeRow, stores]);

  const avgRevPerSqftAllStores = useMemo(() => {
    const withSqft = stores.filter(r => r.sqft > 0);
    const rev  = withSqft.reduce((s, r) => s + (r.revenue_3m || 0), 0);
    const area = withSqft.reduce((s, r) => s + r.sqft, 0);
    return rev > 0 && area > 0 ? Math.round(rev / area) : null;
  }, [stores]);
  const revPerSqft = useMemo(() => {
    if (!selectedStore) return avgRevPerSqftAllStores;
    if (!storeRow?.revenue_3m || !storeRow?.sqft) return null;
    return Math.round(storeRow.revenue_3m / storeRow.sqft);
  }, [selectedStore, storeRow, avgRevPerSqftAllStores]);

  const compareLabel = useMemo(() => {
    if (!compareFrom || !compareTo) return null;
    if (compareMode === "prior_period") return "vs prior period";
    if (compareMode === "prior_year")   return "vs prior year";
    const fmt = s => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return `vs ${fmt(compareFrom)} – ${fmt(compareTo)}`;
  }, [compareMode, compareFrom, compareTo]);

  const handleStoreChange = (name) => {
    setSearchParams(prev => {
      const n = new URLSearchParams(prev);
      if (name) n.set("store", name); else n.delete("store");
      return n;
    }, { replace: true });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 pb-8" data-testid="merch-store-cockpit">

      {/* Header + store picker */}
      <div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-[22px] font-bold text-foreground leading-tight">
            {selectedStore || "All Stores"}
          </h2>
          {storeRow?.store_tier && storeRow.store_tier !== "—" && (
            <TierBadge tier={storeRow.store_tier} />
          )}
          <span className="text-[14px] text-muted font-medium shrink-0">
            — Store Detail
          </span>
        </div>
        {summary && (
          <p className="text-[12px] text-muted mt-0.5">
            {fmtNum(summary.styles)} {selectedStore ? "active styles in this location's range" : "active styles with current stock"} · {fmtNum(summary.stock_units)} units in stock
            {summary.actively_selling != null && ` · ${fmtNum(summary.actively_selling)} selling this period`}
          </p>
        )}
        <div className="mt-2 max-w-xs">
          <StorePicker stores={stores} value={selectedStore} onChange={handleStoreChange} />
        </div>
      </div>

      {loading && <Loading label="Loading store data…" />}
      {error   && <ErrorBox message={error} />}

      {!loading && !error && summary && (
        <>
          {/* KPI band — same metrics as Style Cockpit for the same scope */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KPICard
              small label="Revenue" value={fmtKES(summary.revenue)} icon={TrendUp}
              sub={hasCompare && cmpSummary
                ? `Prior: ${fmtKES(cmpSummary.revenue)}`
                : "Gross sales net of returns"}
              delta={revDelta} showDelta={hasCompare}
              formula="Revenue = gross sales (total_sales_kes) minus returns, Vivo-brand styles only — byte-identical to the Style Cockpit Revenue card for the same date range and store."
              testId="msc-revenue"
            />
            <KPICard
              small label="Units Sold" value={fmtNum(summary.units)} icon={Package}
              sub={hasCompare && cmpSummary
                ? `Prior: ${fmtNum(cmpSummary.units)}`
                : "Net units (after returns)"}
              delta={unitsDelta} showDelta={hasCompare}
              testId="msc-units"
            />
            <KPICard
              small label="Stock on Hand" value={fmtNum(summary.stock_units)} icon={Storefront}
              sub={storeRow?.optimal_stock != null
                ? `Optimal: ${fmtNum(storeRow.optimal_stock)}`
                : selectedStore ? "Units in store" : "Across all stores"}
              delta={stockDelta} showDelta={hasCompare}
              testId="msc-stock"
            />
            <KPICard
              small showDelta={false}
              label={selectedStore ? "Active Styles at Location" : "Active Styles"}
              value={fmtNum(summary.styles)}
              icon={Tag}
              sub={selectedStore
                ? "With stock or sales at this location"
                : "With current stock in stores or warehouse"}
              formula={selectedStore
                ? "Active styles in the selected location's range: the style currently has stock at that location or recorded sales there during the selected period. This is intentionally narrower than the company-wide active-style universe."
                : "Active styles with current stock in stores or warehouse. This is a stock-backed merchandising range, not the company-wide lifecycle count."}
              testId="msc-styles"
            />
            <KPICard
              small showDelta={false} label="Rate of Sale" value={fmtSor(summary.avg_sor)} icon={Percent}
              sub={
                <>
                  <div>{periodLabel}</div>
                  <div>Full price SOR: {fmtSor(summary.full_price_sor)}</div>
                </>
              }
              footer={
                <span style={{ color: sorGapColor(discountedSorGap) }}>
                  Discounted: {discountedSorGap == null ? "—" : `${Number(discountedSorGap).toFixed(1)}pp`}
                </span>
              }
              formula="Rate of sale = units sold in the selected period ÷ (units sold + current stock)"
              testId="msc-sor"
            />
            <KPICard
              small showDelta={false} label="Avg WOC" value={fmtWoc(summary.avg_woc)} icon={ChartBar}
              sub={periodVelocity ? `Velocity: ${periodLabel}` : "Velocity: last 30 days"}
              formula={periodVelocity
                ? "Weeks of cover = current stock ÷ weekly velocity. Velocity = units sold in the selected date range ÷ weeks in the range, so cover reflects the chosen period's run-rate. The WOC columns in the tables below use the same basis."
                : "Weeks of cover = current stock ÷ weekly velocity. When the range ends today, velocity is units sold over the trailing 30 days (÷ 4.3 weeks) — cover is a 'today' metric. Pick a range ending in the past to base velocity on that period instead."}
              testId="msc-woc"
            />
            <KPICard
              small showDelta={false} label="Sales / Sq Ft"
              value={revPerSqft != null ? fmtKESLong(revPerSqft) : "—"}
              icon={CurrencyCircleDollar}
              sub={selectedStore && avgRevPerSqftAllStores != null
                ? `All-store avg: ${fmtKESLong(avgRevPerSqftAllStores)}`
                : "Stores with sq footage only"}
              formula="Sales per sq ft = period revenue ÷ configured store square footage. The all-store average uses only stores with a configured sq footage in both numerator and denominator."
              testId="msc-rev-sqft"
            />
            <KPICard
              small showDelta={false} label="Colour Styles"
              value={colourStyleCount != null ? fmtNum(colourStyleCount) : "—"}
              icon={Tag}
              sub={colourStyleCount && summary.stock_units
                ? `Avg ${fmtNum(Math.round(summary.stock_units / colourStyleCount))} units/colour`
                : "Style + colour combinations"}
              testId="msc-colour-count"
            />
            <KPICard
              small showDelta={false} label="At-Risk Styles"
              value={
                <span style={{ color: atRiskCount > 0 ? "#d97706" : "#1a5c38" }}>
                  {fmtNum(atRiskCount)}
                </span>
              }
              icon={Warning}
              sub="Restock, transfer, markdown or retire flagged below"
              testId="msc-at-risk"
            />
          </div>

          {/* All-stores comparison charts — shown when no specific store is selected */}
          {!selectedStore && stores.length > 0 && (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="card-white p-5" data-testid="msc-rev-by-store">
                  <SectionTitle title="Revenue by Store — Top 15"
                    subtitle={`KES '000 · ${periodLabel || "selected period"} net · colour = store tier (A/B/C)`} />
                  <div className="mt-3" style={{ height: 360 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={revBars} layout="vertical" margin={{ left: 8, right: 60, top: 4, bottom: 4 }}>
                        <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${fmtNum(v)}k`} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={155} />
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                        <Tooltip formatter={(v) => [`KES ${fmtNum(v)}k`, "Revenue"]} />
                        <Bar dataKey="rev" radius={[0, 3, 3, 0]}>
                          {revBars.map((d, i) => <Cell key={i} fill={d.fill} />)}
                          <LabelList dataKey="rev" position="right" formatter={v => `${fmtNum(v)}k`} style={{ fontSize: 9, fill: "#64748b" }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#1a5c38]" /> Tier A</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#4b7bec]" /> Tier B</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#94a3b8]" /> Tier C</span>
                  </div>
                </div>

                <div className="card-white p-5" data-testid="msc-stock-by-store">
                  <SectionTitle title="Stock by Store — Top 15" subtitle="Current units · colour = avg WOC health" />
                  <div className="mt-3" style={{ height: 360 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stockBars} layout="vertical" margin={{ left: 8, right: 60, top: 4, bottom: 4 }}>
                        <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => fmtNum(v)} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={155} />
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                        <Tooltip formatter={(v) => [fmtNum(v) + " units", "Stock"]} />
                        <Bar dataKey="stock" radius={[0, 3, 3, 0]}>
                          {stockBars.map((d, i) => <Cell key={i} fill={d.fill} />)}
                          <LabelList dataKey="stock" position="right" formatter={v => fmtNum(v)} style={{ fontSize: 9, fill: "#64748b" }} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#ef4444]" /> WOC &lt;4 (restock)</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#d97706]" /> WOC 4–8</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#1a5c38]" /> WOC &gt;8</span>
                  </div>
                </div>
              </div>

              {scatterData.length > 0 && (
                <div className="card-white p-5" data-testid="msc-store-efficiency">
                  <SectionTitle title="Store Efficiency — Avg WOC vs Avg SOR" subtitle="Bubble size = revenue · ideal = high SOR, moderate WOC" />
                  <div className="mt-3" style={{ height: 320 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 10, right: 20, left: -10, bottom: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis type="number" dataKey="avg_woc" name="Avg WOC" tick={{ fontSize: 10 }}
                          label={{ value: "Avg WOC (wks)", position: "insideBottom", offset: -5, fontSize: 10 }} />
                        <YAxis type="number" dataKey="avg_sor" name="Avg SOR %" tick={{ fontSize: 10 }}
                          label={{ value: "Avg SOR %", angle: -90, position: "insideLeft", offset: 14, fontSize: 9 }} />
                        <ZAxis type="number" dataKey="z" range={[40, 600]} />
                        <Tooltip content={<ScatterTooltip />} />
                        <Scatter data={scatterData} fill="#1a5c38">
                          {scatterData.map((d, i) => <Cell key={i} fill={d.fill} fillOpacity={0.75} />)}
                        </Scatter>
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {allStoresOptChart.length > 0 && (
                  <div className="card-white p-5" data-testid="msc-actual-vs-optimal">
                    <SectionTitle title="Actual vs Optimal Stock — All Stores"
                      subtitle="Stores with configured optimal stock level only" />
                    <ResponsiveContainer width="100%" height={Math.max(240, allStoresOptChart.length * 28)}>
                      <BarChart data={allStoresOptChart} layout="vertical" margin={{ top: 4, right: 32, left: 4, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} />
                        <Tooltip formatter={(v, name) => [fmtNum(v), name === "Actual" ? "Actual Stock" : "Optimal Stock"]} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Bar dataKey="actual"  name="Actual"  fill="#1a5c38" radius={[0, 3, 3, 0]} barSize={8} />
                        <Bar dataKey="optimal" name="Optimal" fill="#d1fae5" stroke="#1a5c38" strokeWidth={1} radius={[0, 3, 3, 0]} barSize={8} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {revSqftChart.length > 0 && (
                  <div className="card-white p-5" data-testid="msc-rev-sqft-chart">
                    <SectionTitle title="Revenue per Sq Ft — All Stores"
                      subtitle={`Monthly average over ${periodLabel || "the selected period"} · stores with sq footage configured`} />
                    <ResponsiveContainer width="100%" height={Math.max(240, revSqftChart.length * 28)}>
                      <BarChart data={revSqftChart} layout="vertical" margin={{ top: 4, right: 32, left: 4, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => "K" + Math.round(v / 1000)} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} />
                        <Tooltip formatter={v => [fmtKES(v) + "/sq ft", "Rev/Sq Ft"]} />
                        <Bar dataKey="revSqft" name="Rev/Sq Ft" radius={[0, 3, 3, 0]} fill="#4b7bec">
                          <LabelList dataKey="revSqft" position="right" style={{ fontSize: 8, fill: "#4b7bec" }} formatter={v => fmtKES(v)} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              <div className="card-white p-5" data-testid="msc-store-summary">
                <SectionTitle title="All Stores — Performance Summary"
                  subtitle={`Sorted by ${periodLabel || "selected period"} revenue`} />
                <div className="mt-3">
                  <SortableTable
                    testId="msc-store-summary-table"
                    rows={stores}
                    initialSort={{ key: "revenue_3m", dir: "desc" }}
                    exportName="store_performance_summary.csv"
                    maxHeight={520}
                    columns={[
                      { key: "store", label: "Store",
                        render: r => <span className="font-medium text-foreground">{r.store}</span> },
                      { key: "store_tier", label: "Tier",
                        render: r => {
                          const c = TIER_COLOR[r.store_tier] || "#94a3b8";
                          return <span className="px-1.5 py-0.5 rounded text-[11px] font-bold"
                            style={{ background: c + "20", color: c }}>{r.store_tier || "—"}</span>;
                        } },
                      { key: "style_count", label: "Styles", numeric: true, render: r => fmtNum(r.style_count || 0) },
                      { key: "units_3m",    label: "Units",  numeric: true, render: r => fmtNum(r.units_3m || 0) },
                      { key: "revenue_3m",  label: "Revenue", numeric: true, render: r => fmtKES(r.revenue_3m || 0) },
                      { key: "total_stock", label: "Stock",  numeric: true, render: r => fmtNum(r.total_stock || 0) },
                      { key: "avg_woc", label: "Avg WOC", numeric: true,
                        sortValue: r => r.avg_woc ?? -1,
                        render: r => {
                          if (r.avg_woc == null) return "—";
                          const c = WOC_COLOR(r.avg_woc);
                          return <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold"
                            style={{ background: c + "20", color: c }}>{fmtDec(r.avg_woc, 1)} wks</span>;
                        } },
                      { key: "avg_sor", label: "Avg SOR", numeric: true,
                        sortValue: r => r.avg_sor ?? -1,
                        render: r => r.avg_sor != null ? `${fmtDec(r.avg_sor, 1)}%` : "—" },
                    ]}
                  />
                </div>
              </div>
            </>
          )}

          {/* Size performance — store bars against a per-size network benchmark */}
          {sizeLoading ? (
            <Loading label="Loading size analysis…" />
          ) : sizeError ? (
            <ErrorBox message={sizeError} />
          ) : (
            <StoreSizeAnalysis
              rows={sizeAnalysis}
              selectedStore={selectedStore}
              periodLabel={periodLabel}
            />
          )}

          {/* Row 3 — Unit economics: ASP card */}
          {asp != null && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="col-span-2 sm:col-span-1 lg:col-span-2">
                <KPICard
                  small label="Avg Selling Price" value={fmtKESLong(asp)} icon={CurrencyCircleDollar}
                  delta={aspDelta} showDelta={hasCompare}
                  sub={
                    <span>
                      {periodLabel && <span className="block">{periodLabel}</span>}
                      {allStoresAsp != null && (
                        <span className={periodLabel ? "block mt-0.5" : ""}>
                          All-store avg: <span className="font-semibold">{fmtKESLong(allStoresAsp)}</span>
                          {asp > allStoresAsp
                            ? <span className="text-emerald-600 ml-1">(+{fmtNum(asp - allStoresAsp)} above)</span>
                            : asp < allStoresAsp
                            ? <span className="text-amber-600 ml-1">({fmtNum(allStoresAsp - asp)} below)</span>
                            : null}
                        </span>
                      )}
                      {hasCompare && cmpAsp != null && (
                        <span className={(allStoresAsp != null || periodLabel) ? "block mt-0.5 text-muted" : ""}>
                          Prior: {fmtKESLong(cmpAsp)}
                        </span>
                      )}
                      {!allStoresAsp && !hasCompare && !periodLabel && (
                        <span>Revenue ÷ net units sold</span>
                      )}
                    </span>
                  }
                  formula="ASP = revenue ÷ net units sold over the selected period, using the same revenue formula as the Style Cockpit (gross sales minus returns). All-store avg uses the same period from the by-store feed."
                  testId="msc-asp"
                />
              </div>
            </div>
          )}

          {/* Optimal stock context — only when a store is selected */}
          {selectedStore && storeRow?.optimal_stock != null && (
            <div className="card-white p-4">
              <div className="eyebrow mb-3">Stock Position</div>
              <div className="flex flex-wrap gap-8 items-end">
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wide mb-0.5">In Store (SOH)</div>
                  <div className="text-[26px] font-bold">{fmtNum(storeRow.total_stock)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wide mb-0.5">Optimal</div>
                  <div className="text-[26px] font-bold">{fmtNum(storeRow.optimal_stock)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wide mb-0.5">Variance</div>
                  <div className={`text-[26px] font-bold ${(storeRow.stock_variance ?? 0) < 0 ? "text-amber-600" : "text-emerald-600"}`}>
                    {(storeRow.stock_variance ?? 0) >= 0 ? "+" : ""}{fmtNum(storeRow.stock_variance ?? 0)}
                  </div>
                </div>
                {storeRow.sqft > 0 && storeRow.revenue_3m > 0 && (
                  <div>
                    <div className="text-[11px] text-muted uppercase tracking-wide mb-0.5">Rev / sq ft ({periodLabel})</div>
                    <div className="text-[26px] font-bold">
                      {fmtKES(Math.round(storeRow.revenue_3m / storeRow.sqft))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Revenue by category — same PA payload as the KPI band */}
          {subcatChart.length > 0 && (
            <div className="card-white p-5" data-testid="msc-rev-by-category">
              <SectionTitle title="Revenue by Category"
                subtitle={`Top 10 categories by revenue · ${selectedStore || "All Stores"} · ${periodLabel || "selected period"}`} />
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={subcatChart} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => "K" + fmtNum(v)} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} />
                  <Tooltip formatter={v => [fmtKES(v * 1000), "Revenue"]} />
                  <Bar dataKey="revenue" name="Revenue" radius={[0, 3, 3, 0]} fill="#1a5c38" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* By-brand breakdown */}
          {byBrand.length > 0 && (
            <div className="card-white p-4">
              <div className="eyebrow mb-2">By Brand</div>
              <SortableTable
                testId="msc-by-brand"
                rows={byBrand}
                initialSort={{ key: "revenue", dir: "desc" }}
                exportName={`store_by_brand${selectedStore ? "_" + selectedStore.replace(/\s+/g, "_") : ""}.csv`}
                maxHeight={220}
                columns={[
                  { key: "brand",   label: "Brand",   render: r => r.brand },
                  { key: "styles",  label: "Styles",  numeric: true, render: r => fmtNum(r.styles) },
                  { key: "units",   label: "Units",   numeric: true, render: r => fmtNum(r.units) },
                  { key: "revenue", label: "Revenue", numeric: true, render: r => fmtKES(r.revenue) },
                  { key: "stock",   label: "Stock",   numeric: true, render: r => fmtNum(r.stock) },
                  { key: "sor",     label: "SOR",     numeric: true, render: r => fmtSor(r.sor), pct: true },
                  { key: "woc",     label: "WOC",     numeric: true,
                    render: r => <span className={wocCls(r.woc)}>{fmtWoc(r.woc)}</span>,
                    sortValue: r => r.woc ?? -1 },
                ]}
              />
              {otherBrands && (
                <div className="mt-3 rounded border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] text-muted">
                  <span className="font-semibold text-foreground/70">Other brands (consignment)</span>
                  <span className="mx-1.5 text-border">·</span>
                  {fmtNum(otherBrands.styles)} styles
                  <span className="mx-1.5 text-border">·</span>
                  {fmtNum(otherBrands.units)} units sold
                  <span className="mx-1.5 text-border">·</span>
                  {fmtKES(otherBrands.revenue)} revenue
                  <span className="mx-1.5 text-border">·</span>
                  {fmtNum(otherBrands.stock)} on floor
                  <span className="ml-2 italic opacity-70">— not included in metrics above</span>
                </div>
              )}
            </div>
          )}

          {/* Style table — same rows as Style Cockpit, filtered to this store */}
          <div className="card-white p-4">
            <div className="eyebrow mb-2">
              {selectedStore ? `Styles at ${selectedStore}` : "All Active Styles"}
              {rows.length > 0 && <span className="ml-2 text-muted font-normal">· {fmtNum(rows.length)}</span>}
            </div>
            {rows.length ? (
              <SortableTable
                testId="msc-styles-table"
                rows={rows}
                initialSort={{ key: "revenue", dir: "desc" }}
                exportName={`styles${selectedStore ? "_" + selectedStore.replace(/\s+/g, "_") : ""}.csv`}
                maxHeight={520}
                columns={[
                  { key: "style_name",
                    label: "Style",
                    render: r => <span className="font-medium text-foreground">{r.style_name}</span> },
                  { key: "style_number", label: "Style #",  render: r => r.style_number || "—" },
                  { key: "subcategory",  label: "Category", render: r => r.subcategory  || "—" },
                  { key: "tier",
                    label: "Tier",
                    render: r => <span className="text-[11px]">{r.tier || "—"}</span> },
                  { key: "revenue",
                    label: "Revenue",
                    numeric: true,
                    render: r => fmtKES(r.revenue) },
                  { key: "units",
                    label: "Units",
                    numeric: true,
                    render: r => fmtNum(r.units) },
                  { key: "stock",
                    label: "Stock",
                    numeric: true,
                    render: r => fmtNum(r.stock) },
                  { key: "sor",
                    label: "SOR %",
                    numeric: true,
                    render: r => fmtSor(r.sor),
                    pct: true },
                  { key: "rate_of_sale",
                    label: "ROS /wk",
                    numeric: true,
                    render: r => r.rate_of_sale != null ? Number(r.rate_of_sale).toFixed(1) : "—",
                    sortValue: r => r.rate_of_sale ?? -1 },
                  { key: "woc",
                    label: "WOC",
                    numeric: true,
                    render: r => <span className={wocCls(r.woc)}>{fmtWoc(r.woc)}</span>,
                    sortValue: r => r.woc ?? -1 },
                  { key: "last_sale",
                    label: "Last Sale",
                    render: r => r.last_sale ? fmtDate(r.last_sale) : "—",
                    sortValue: r => r.last_sale || "" },
                  { key: "recommendation",
                    label: "Action",
                    render: r => <ActionPill action={r.recommendation} /> },
                ]}
              />
            ) : (
              <Empty />
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default MerchStoreCockpit;
