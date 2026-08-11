/**
 * MerchStoreDetail — Store Performance Detail tab (tab 12, ?tab=merch-store)
 *
 * Store-first: pick a store from a dropdown → see that store's KPIs + style list.
 * Reads ?store= from the URL. Fetches:
 *   • /api/merch/by-store            → full store list + per-store KPIs
 *   • /api/merch/styles?pos_location → styles active in the selected store
 */
import React, { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, fmtKES, fmtNum, fmtPct } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { SortableTable } from "@/components/SortableTable";
import { useMerchFilters } from "./MerchandisingHub";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine, Cell, LabelList, Legend,
} from "recharts";
import {
  Storefront, Package, ChartBar, Percent, ArrowsLeftRight,
  CurrencyCircleDollar, Ruler, TrendUp, CubeFocus, Warning,
} from "@phosphor-icons/react";

// ── WOC colour coding ─────────────────────────────────────────────────────────
const wocColor = (woc) => {
  if (woc == null) return "#9ca3af";
  if (woc < 1)  return "#ef4444";
  if (woc < 2)  return "#d97706";
  if (woc < 4)  return "#eab308";
  return "#1a5c38";
};

// ── Variance colour coding ─────────────────────────────────────────────────────
const varianceColor = (v) => {
  if (v == null) return "#9ca3af";
  if (v > 0)  return "#1a5c38";   // over capacity — green
  if (v < -20) return "#ef4444";  // significantly under
  return "#d97706";               // slightly under
};

// ── Tier badge ────────────────────────────────────────────────────────────────
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

// ── Action pill ───────────────────────────────────────────────────────────────
const ActionPill = ({ action }) => {
  const a = String(action || "").toUpperCase();
  const cls =
    a === "RESTOCK"      ? "bg-rose-100 text-rose-700 border-rose-300" :
    a === "REORDER SOON" ? "bg-amber-100 text-amber-700 border-amber-300" :
    a === "TRANSFER OUT" ? "bg-teal-100 text-teal-700 border-teal-300" :
    a === "MONITOR"      ? "bg-blue-100 text-blue-700 border-blue-300" :
                           "bg-emerald-100 text-emerald-700 border-emerald-300";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${cls}`}>
      {action || "HEALTHY"}
    </span>
  );
};

// ── Store picker dropdown ─────────────────────────────────────────────────────
const StorePicker = ({ stores, value, onChange }) => (
  <select
    className="w-full border border-line rounded-lg px-3 py-2.5 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
    value={value}
    onChange={e => onChange(e.target.value)}
  >
    <option value="">All Stores</option>
    {stores.map(s => (
      <option key={s.store} value={s.store}>
        {s.store}{s.store_tier && s.store_tier !== "—" ? `  [Tier ${s.store_tier}]` : ""}
      </option>
    ))}
  </select>
);

// ── Main component ─────────────────────────────────────────────────────────────
const MerchStoreDetail = () => {
  const filters = useMerchFilters();
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedStore = searchParams.get("store") || "";

  const [allStores, setAllStores]         = useState([]);
  const [storeListLoading, setStoreListLoading] = useState(true);
  const [styles, setStyles]               = useState([]);
  const [stylesLoading, setStylesLoading] = useState(false);
  const [stylesError, setStylesError]     = useState(null);

  // Load store list
  useEffect(() => {
    let cancelled = false;
    setStoreListLoading(true);
    // Revenue (6m) must always be the trailing 180-day window — do NOT pass
    // from_date/to_date here so the backend uses its own six_mo_ago default.
    // Country, brand and subcategory still narrow the scope correctly.
    apiFetch("/merch/by-store", {
      params: {
        country:     filters.country,
        brand:       filters.brand,
        subcategory: filters.subcategory,
      },
    })
      .then(d => { if (!cancelled) setAllStores(d.rows || []); })
      .catch(() => { if (!cancelled) setAllStores([]); })
      .finally(() => { if (!cancelled) setStoreListLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.brand, filters.subcategory, filters.dataVersion]);

  // Load styles for the selected store
  useEffect(() => {
    if (!selectedStore) { setStyles([]); return; }
    let cancelled = false;
    setStylesLoading(true);
    setStylesError(null);
    apiFetch("/merch/styles", {
      params: {
        pos_location: selectedStore,
        from_date:    filters.from_date,
        to_date:      filters.to_date,
        country:      filters.country,
        brand:        filters.brand,
        subcategory:  filters.subcategory,
      },
    })
      .then(d => { if (!cancelled) setStyles(d.styles || []); })
      .catch(e => { if (!cancelled) setStylesError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setStylesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedStore, filters.from_date, filters.to_date, filters.country, filters.brand, filters.subcategory, filters.dataVersion]);

  const handleStoreChange = (storeName) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (storeName) next.set("store", storeName);
      else next.delete("store");
      return next;
    }, { replace: true });
  };

  // KPIs for the selected store
  const storeKPIs = useMemo(
    () => allStores.find(s => s.store === selectedStore) || null,
    [allStores, selectedStore],
  );

  // Aggregated KPIs across all stores (shown when no store is selected)
  const allStoresKPIs = useMemo(() => {
    if (!allStores.length) return null;
    const revenue       = allStores.reduce((s, r) => s + (r.revenue_6m          || 0), 0);
    const units         = allStores.reduce((s, r) => s + (r.units_6m            || 0), 0);
    const stock         = allStores.reduce((s, r) => s + (r.total_stock         || 0), 0);
    const sqftSum       = allStores.reduce((s, r) => s + (r.sqft                || 0), 0);
    const styleSum      = allStores.reduce((s, r) => s + (r.style_count         || 0), 0);
    const colourSum     = allStores.reduce((s, r) => s + (r.colour_style_count  || 0), 0);
    const withOpt       = allStores.filter(r => r.optimal_stock != null);
    const optimal       = withOpt.reduce((s, r) => s + r.optimal_stock, 0);
    const avgSOR        = revenue > 0
      ? allStores.reduce((s, r) => s + (r.avg_sor || 0) * (r.revenue_6m || 0), 0) / revenue
      : null;
    return {
      revenue_6m:          revenue,
      units_6m:            units,
      total_stock:         stock,
      optimal_stock:       withOpt.length ? optimal : null,
      stock_variance:      withOpt.length ? stock - optimal : null,
      sqft:                sqftSum || null,
      avg_sor:             avgSOR,
      store_tier:          null,
      style_count:         styleSum,
      colour_style_count:  colourSum,
    };
  }, [allStores]);

  // Active KPIs: specific store or all-stores aggregate
  const displayKPIs = selectedStore ? storeKPIs : allStoresKPIs;

  // Derived: revenue per sq ft
  const revPerSqft = useMemo(() => {
    if (!displayKPIs?.revenue_6m || !displayKPIs?.sqft) return null;
    return Math.round(displayKPIs.revenue_6m / displayKPIs.sqft);
  }, [displayKPIs]);

  // Derived: at-risk style count (only meaningful for a specific store)
  const atRiskCount = useMemo(() =>
    styles.filter(s => {
      const rec = (s.recommendation || "").toLowerCase();
      return rec && rec !== "on track";
    }).length,
    [styles],
  );

  // Derived: units from styles list (specific store) or aggregate
  const totalUnits = selectedStore
    ? styles.reduce((sum, s) => sum + (s.units_6m || 0), 0)
    : (allStoresKPIs?.units_6m ?? 0);

  const totalRevenue = displayKPIs?.revenue_6m ?? null;

  // All-stores actual vs optimal chart data (only stores with optimal set)
  const allStoresOptChart = useMemo(() =>
    allStores
      .filter(s => s.optimal_stock != null)
      .sort((a, b) => b.revenue_6m - a.revenue_6m)
      .map(s => ({
        name:     s.store,
        actual:   s.total_stock,
        optimal:  s.optimal_stock,
        variance: s.stock_variance,
      })),
    [allStores],
  );

  // All-stores rev/sqft chart data
  const revSqftChart = useMemo(() =>
    allStores
      .filter(s => s.sqft && s.sqft > 0 && s.revenue_6m > 0)
      .map(s => ({
        name:      s.store,
        revSqft:   Math.round(s.revenue_6m / s.sqft),
        tier:      s.store_tier,
      }))
      .sort((a, b) => b.revSqft - a.revSqft),
    [allStores],
  );

  // Revenue by subcategory chart (selected store)
  const subcatChart = useMemo(() => {
    const map = {};
    for (const s of styles) {
      const cat = s.subcategory || "Other";
      map[cat] = (map[cat] || 0) + (s.revenue_6m || 0);
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, value]) => ({ name, revenue: Math.round(value / 1000) }));
  }, [styles]);

  // Style table columns
  const styleCols = [
    { key: "style_name",   label: "Style",        sortable: true, mobilePrimary: true,
      render: r => <span className="font-medium text-foreground">{r.style_name}</span> },
    { key: "style_number", label: "Style #",      sortable: true },
    { key: "subcategory",  label: "Category",     sortable: true },
    { key: "tier",         label: "Tier",          sortable: true,
      render: r => <span className="text-[11px]">{r.tier || "—"}</span> },
    { key: "revenue_6m",   label: "Revenue 6m",   sortable: true, numeric: true,
      render: r => fmtKES(r.revenue_6m) },
    { key: "units_6m",     label: "Units 6m",     sortable: true, numeric: true,
      render: r => fmtNum(r.units_6m) },
    { key: "soh_current",  label: "Stock",        sortable: true, numeric: true,
      render: r => r.soh_current != null ? fmtNum(r.soh_current) : "—" },
    { key: "sor_6m",       label: "SOR %",        sortable: true, numeric: true,
      render: r => r.sor_6m != null ? fmtPct(r.sor_6m) : "—" },
    { key: "rate_of_sale", label: "ROS /wk",      sortable: true, numeric: true,
      render: r => r.rate_of_sale != null ? (r.rate_of_sale).toFixed(1) : "—" },
    { key: "recommendation", label: "Action",     sortable: true,
      render: r => <ActionPill action={r.recommendation} /> },
  ];

  // ── Unified render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 pb-8">

      {/* Header */}
      <div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-[22px] font-bold text-foreground leading-tight">
            {selectedStore || "All Stores"}
          </h2>
          {storeKPIs?.store_tier && storeKPIs.store_tier !== "—" && (
            <TierBadge tier={storeKPIs.store_tier} />
          )}
          <span className="text-[14px] text-muted font-medium shrink-0">
            — Store Performance Detail
          </span>
        </div>
        <p className="text-[12px] text-muted mt-0.5">
          {storeListLoading
            ? "Loading stores…"
            : selectedStore
              ? storeKPIs
                ? `${storeKPIs.style_count} styles active · ${fmtNum(storeKPIs.total_stock)} units in stock`
                : "Loading…"
              : `${allStores.length} stores · ${fmtNum(allStoresKPIs?.total_stock ?? 0)} total units in stock`}
        </p>
        <div className="mt-2 max-w-xs">
          {!storeListLoading && (
            <StorePicker stores={allStores} value={selectedStore} onChange={handleStoreChange} />
          )}
        </div>
      </div>

      {/* KPI rows — always shown once data is ready */}
      {!storeListLoading && displayKPIs && (
        <>
          {/* Row 1 — Inventory */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KPICard label="Actual Stock" value={fmtNum(displayKPIs.total_stock)}
              sub={selectedStore ? "Units on hand right now" : "Total units across all stores"}
              icon={Package} showDelta={false} testId="sd-actual-stock" />

            <KPICard label="Optimal Stock"
              value={displayKPIs.optimal_stock != null ? fmtNum(displayKPIs.optimal_stock) : "—"}
              sub={selectedStore ? "Target unit capacity" : "Combined target capacity"}
              icon={ArrowsLeftRight} showDelta={false} testId="sd-optimal-stock" />

            <KPICard label="Stock Variance"
              value={displayKPIs.stock_variance != null
                ? <span style={{ color: varianceColor(displayKPIs.stock_variance) }}>
                    {displayKPIs.stock_variance >= 0 ? "+" : ""}{fmtNum(displayKPIs.stock_variance)}
                  </span>
                : "—"}
              sub={displayKPIs.stock_variance != null
                ? displayKPIs.stock_variance >= 0 ? "Over capacity" : "Under capacity"
                : "Actual vs optimal"}
              showDelta={false} testId="sd-variance" />

            <KPICard label="Square Footage"
              value={displayKPIs.sqft != null ? fmtNum(displayKPIs.sqft) + " sq ft" : "—"}
              sub={selectedStore ? "Retail selling area" : "Total retail area"}
              icon={Ruler} showDelta={false} testId="sd-sqft" />

            <KPICard label="Rev / Sq Ft (6m)"
              value={revPerSqft != null ? fmtKES(revPerSqft) : "—"}
              sub="6m net revenue per sq ft"
              icon={CurrencyCircleDollar} showDelta={false} testId="sd-rev-sqft" />
          </div>

          {/* Row 2 — Performance */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KPICard label="Revenue (6m)"
              value={totalRevenue != null ? fmtKES(totalRevenue) : "—"}
              sub="6-month net revenue"
              icon={TrendUp} showDelta={false} testId="sd-revenue" />

            <KPICard label="Units Sold (6m)"
              value={totalUnits > 0 ? fmtNum(totalUnits) : "—"}
              sub="Total units sold in period"
              icon={CubeFocus} showDelta={false} testId="sd-units" />

            <KPICard label="No. of Styles"
              value={displayKPIs.style_count != null ? fmtNum(displayKPIs.style_count) : "—"}
              sub={(() => {
                const sc = displayKPIs.style_count;
                const st = displayKPIs.total_stock;
                if (sc && st) return `Avg ${fmtNum(Math.round(st / sc))} units/style`;
                return "No. of styles with sales";
              })()}
              icon={ChartBar} showDelta={false} testId="sd-style-count" />

            <KPICard label="No. of Colour Styles"
              value={displayKPIs.colour_style_count != null ? fmtNum(displayKPIs.colour_style_count) : "—"}
              sub={(() => {
                const cc = displayKPIs.colour_style_count;
                const st = displayKPIs.total_stock;
                if (cc && st) return `Avg ${fmtNum(Math.round(st / cc))} units/colour`;
                return "No. of colour-style combos";
              })()}
              icon={ChartBar} showDelta={false} testId="sd-colour-count" />

            <KPICard label="At-Risk Styles"
              value={!selectedStore
                ? "—"
                : stylesLoading
                  ? "…"
                  : <span style={{ color: atRiskCount > 0 ? "#d97706" : "#1a5c38" }}>
                      {fmtNum(atRiskCount)}
                    </span>}
              sub={!selectedStore
                ? "Select a store to see"
                : atRiskCount === 1 ? "1 style needs action" : `${atRiskCount} styles need action`}
              icon={Warning} showDelta={false} testId="sd-at-risk" />

            <KPICard label="Avg Sell-Through"
              value={displayKPIs.avg_sor != null ? fmtPct(displayKPIs.avg_sor) : "—"}
              sub="Avg SOR % across styles"
              icon={Percent} showDelta={false} testId="sd-avg-sor" />
          </div>
        </>
      )}

      {/* All-stores charts (shown when no specific store is selected) */}
      {!selectedStore && !storeListLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {allStoresOptChart.length > 0 && (
            <div className="card-white p-5">
              <SectionTitle
                title="Actual vs Optimal Stock — All Stores"
                subtitle="Stores with configured optimal stock level only"
              />
              <ResponsiveContainer width="100%" height={Math.max(240, allStoresOptChart.length * 28)}>
                <BarChart data={allStoresOptChart} layout="vertical" margin={{ top: 4, right: 32, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} />
                  <Tooltip formatter={(v, name) => [fmtNum(v), name === "actual" ? "Actual Stock" : "Optimal Stock"]} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="actual"  name="Actual"  fill="#1a5c38" radius={[0, 3, 3, 0]} barSize={8} />
                  <Bar dataKey="optimal" name="Optimal" fill="#d1fae5" stroke="#1a5c38" strokeWidth={1} radius={[0, 3, 3, 0]} barSize={8} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {revSqftChart.length > 0 && (
            <div className="card-white p-5">
              <SectionTitle
                title="Revenue per Sq Ft — All Stores (6m)"
                subtitle="Stores with sq footage configured"
              />
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
      )}

      {/* Store-specific: subcategory chart + styles table */}
      {selectedStore && (
        stylesLoading
          ? <Loading label={`Loading styles for ${selectedStore}…`} />
          : stylesError
          ? <ErrorBox message={stylesError} />
          : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-4 card-white p-5">
                <SectionTitle title="Revenue by Category" subtitle="6-month net revenue · top 10 categories" />
                {subcatChart.length === 0
                  ? <Empty />
                  : (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={subcatChart} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => "K" + v} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={90} />
                        <Tooltip formatter={v => [fmtKES(v * 1000), "Revenue"]} />
                        <Bar dataKey="revenue" name="Revenue" radius={[0, 3, 3, 0]} fill="#1a5c38" />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
              </div>
              <div className="lg:col-span-8 card-white p-5">
                <SectionTitle
                  title={`All Active Styles — ${selectedStore}`}
                  subtitle={`${styles.length} styles with sales or stock in the selected period`}
                />
                {styles.length === 0
                  ? <Empty label="No styles found for this store in the selected period." />
                  : (
                    <div className="mt-3">
                      <SortableTable
                        columns={styleCols}
                        rows={styles}
                        initialSort={{ key: "revenue_6m", dir: "desc" }}
                        exportName={`store_styles_${selectedStore.replace(/\s+/g, "_")}.csv`}
                        maxHeight="60vh"
                        testId="store-styles-table"
                      />
                    </div>
                  )}
              </div>
            </div>
          )
      )}
    </div>
  );
};

export default MerchStoreDetail;
