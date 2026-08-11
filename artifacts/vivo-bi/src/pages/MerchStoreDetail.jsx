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
  CurrencyCircleDollar, Ruler,
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
    apiFetch("/merch/by-store", {
      params: {
        from_date:   filters.from_date,
        to_date:     filters.to_date,
        country:     filters.country,
        brand:       filters.brand,
        subcategory: filters.subcategory,
      },
    })
      .then(d => { if (!cancelled) setAllStores(d.rows || []); })
      .catch(() => { if (!cancelled) setAllStores([]); })
      .finally(() => { if (!cancelled) setStoreListLoading(false); });
    return () => { cancelled = true; };
  }, [filters.from_date, filters.to_date, filters.country, filters.brand, filters.subcategory, filters.dataVersion]);

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

  // Derived: revenue per sq ft
  const revPerSqft = useMemo(() => {
    if (!storeKPIs?.revenue_6m || !storeKPIs?.sqft) return null;
    return Math.round(storeKPIs.revenue_6m / storeKPIs.sqft);
  }, [storeKPIs]);

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

  // ── Empty state (no store selected) ──────────────────────────────────────
  if (!selectedStore) {
    return (
      <div className="space-y-5 pb-8">
        <div>
          <h2 className="text-[22px] font-bold text-foreground">Store Performance Detail</h2>
          <p className="text-[12px] text-muted mt-0.5">Select a store to view its merchandising performance</p>
        </div>

        <div className="card-white p-6 flex flex-col gap-3 items-start max-w-lg">
          <p className="text-[13px] font-medium">Choose a store:</p>
          {storeListLoading
            ? <p className="text-[12px] text-muted">Loading stores…</p>
            : <StorePicker stores={allStores} value={selectedStore} onChange={handleStoreChange} />
          }
          {allStores.length > 0 && (
            <p className="text-[11px] text-muted">{allStores.length} stores available</p>
          )}
        </div>

        {/* All-stores overview charts */}
        {!storeListLoading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Actual vs Optimal stock chart */}
            {allStoresOptChart.length > 0 && (
              <div className="card-white p-5">
                <SectionTitle
                  title="Actual vs Optimal Stock — All Stores"
                  subtitle="Stores with configured optimal stock level only"
                />
                <ResponsiveContainer width="100%" height={Math.max(240, allStoresOptChart.length * 28)}>
                  <BarChart
                    data={allStoresOptChart}
                    layout="vertical"
                    margin={{ top: 4, right: 32, left: 4, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 9 }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} />
                    <Tooltip
                      formatter={(v, name) => [fmtNum(v), name === "actual" ? "Actual Stock" : "Optimal Stock"]}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar dataKey="actual"  name="Actual"  fill="#1a5c38" radius={[0, 3, 3, 0]} barSize={8} />
                    <Bar dataKey="optimal" name="Optimal" fill="#d1fae5" stroke="#1a5c38" strokeWidth={1} radius={[0, 3, 3, 0]} barSize={8} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Revenue per sq ft chart */}
            {revSqftChart.length > 0 && (
              <div className="card-white p-5">
                <SectionTitle
                  title="Revenue per Sq Ft — All Stores (6m)"
                  subtitle="Stores with sq footage configured"
                />
                <ResponsiveContainer width="100%" height={Math.max(240, revSqftChart.length * 28)}>
                  <BarChart
                    data={revSqftChart}
                    layout="vertical"
                    margin={{ top: 4, right: 32, left: 4, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => "K" + Math.round(v / 1000)} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={110} />
                    <Tooltip formatter={v => [fmtKES(v) + "/sq ft", "Rev/Sq Ft"]} />
                    <Bar dataKey="revSqft" name="Rev/Sq Ft" radius={[0, 3, 3, 0]} fill="#4b7bec">
                      <LabelList
                        dataKey="revSqft"
                        position="right"
                        style={{ fontSize: 8, fill: "#4b7bec" }}
                        formatter={v => fmtKES(v)}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Selected store view ───────────────────────────────────────────────────
  return (
    <div className="space-y-5 pb-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-[22px] font-bold text-foreground leading-tight">
              {selectedStore}
            </h2>
            {storeKPIs?.store_tier && storeKPIs.store_tier !== "—" && (
              <TierBadge tier={storeKPIs.store_tier} />
            )}
            <span className="text-[14px] text-muted font-medium shrink-0">
              — Store Performance Detail
            </span>
          </div>
          <p className="text-[12px] text-muted mt-0.5">
            {storeKPIs
              ? `${storeKPIs.style_count} styles active · ${fmtNum(storeKPIs.total_stock)} units in stock`
              : "Loading store KPIs…"}
          </p>
          <div className="mt-2 max-w-xs">
            {!storeListLoading && (
              <StorePicker stores={allStores} value={selectedStore} onChange={handleStoreChange} />
            )}
          </div>
        </div>
        {storeKPIs && (
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="text-[11px] text-muted">6m Revenue</div>
            <div className="text-[18px] font-bold text-brand">{fmtKES(storeKPIs.revenue_6m)}</div>
            <div className="text-[11px] text-muted">6m Units</div>
            <div className="text-[14px] font-bold tabular-nums">{fmtNum(storeKPIs.units_6m)}</div>
          </div>
        )}
      </div>

      {/* KPI Row 1 — Inventory */}
      {storeKPIs && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KPICard label="Actual Stock" value={fmtNum(storeKPIs.total_stock)}
              sub="Units on hand right now"
              icon={Package} showDelta={false} testId="sd-actual-stock" />

            <KPICard label="Optimal Stock"
              value={storeKPIs.optimal_stock != null ? fmtNum(storeKPIs.optimal_stock) : "—"}
              sub="Target unit capacity"
              icon={ArrowsLeftRight} showDelta={false} testId="sd-optimal-stock" />

            <KPICard label="Stock Variance"
              value={storeKPIs.stock_variance != null
                ? <span style={{ color: varianceColor(storeKPIs.stock_variance) }}>
                    {storeKPIs.stock_variance >= 0 ? "+" : ""}{fmtNum(storeKPIs.stock_variance)}
                  </span>
                : "—"}
              sub={storeKPIs.stock_variance != null
                ? storeKPIs.stock_variance >= 0 ? "Over capacity" : "Under capacity"
                : "Actual vs optimal"}
              showDelta={false} testId="sd-variance" />

            <KPICard label="Square Footage"
              value={storeKPIs.sqft != null ? fmtNum(storeKPIs.sqft) + " sq ft" : "—"}
              sub="Retail selling area"
              icon={Ruler} showDelta={false} testId="sd-sqft" />

            <KPICard label="Rev / Sq Ft (6m)"
              value={revPerSqft != null ? fmtKES(revPerSqft) : "—"}
              sub="6m net revenue per sq ft"
              icon={CurrencyCircleDollar} showDelta={false} testId="sd-rev-sqft" />
          </div>

          {/* KPI Row 2 — Performance */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard label="Active Styles" value={fmtNum(storeKPIs.style_count)}
              sub="Styles with sales in period"
              icon={ChartBar} showDelta={false} testId="sd-style-count" />

            <KPICard label="Avg WOC"
              value={storeKPIs.avg_woc != null
                ? <span style={{ color: wocColor(storeKPIs.avg_woc) }}>{storeKPIs.avg_woc.toFixed(1)} wks</span>
                : "—"}
              sub="Weeks of cover (portfolio avg)"
              showDelta={false} testId="sd-avg-woc" />

            <KPICard label="Avg Sell-Through"
              value={storeKPIs.avg_sor != null ? fmtPct(storeKPIs.avg_sor) : "—"}
              sub="Avg SOR across styles"
              icon={Percent} showDelta={false} testId="sd-avg-sor" />

            <KPICard label="Store Tier"
              value={storeKPIs.store_tier && storeKPIs.store_tier !== "—"
                ? <TierBadge tier={storeKPIs.store_tier} />
                : "—"}
              sub="A=Flagship · B=Standard · C=Regional"
              icon={Storefront} showDelta={false} testId="sd-tier" />
          </div>
        </>
      )}

      {/* Styles content */}
      {stylesLoading
        ? <Loading label={`Loading styles for ${selectedStore}…`} />
        : stylesError
        ? <ErrorBox message={stylesError} />
        : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Revenue by subcategory */}
              <div className="lg:col-span-4 card-white p-5">
                <SectionTitle
                  title="Revenue by Category"
                  subtitle="6-month net revenue · top 10 categories"
                />
                {subcatChart.length === 0
                  ? <Empty />
                  : (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart
                        data={subcatChart}
                        layout="vertical"
                        margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={v => "K" + v} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={90} />
                        <Tooltip formatter={v => [fmtKES(v * 1000), "Revenue"]} />
                        <Bar dataKey="revenue" name="Revenue" radius={[0, 3, 3, 0]} fill="#1a5c38" />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
              </div>

              {/* Style table */}
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
          </div>
        )}
    </div>
  );
};

export default MerchStoreDetail;
