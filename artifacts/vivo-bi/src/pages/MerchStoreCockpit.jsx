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
import { apiFetch, fmtKES, fmtKESLong, fmtNum, fmtPct, fmtDate } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import SortableTable from "@/components/SortableTable";
import { Loading, ErrorBox, Empty } from "@/components/common";
import { useMerchFilters } from "./MerchandisingHub";
import {
  Storefront, Package, ChartBar, Percent, Tag, TrendUp, CurrencyCircleDollar,
} from "@phosphor-icons/react";

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

  // ── Store list (for picker + optimal context) ─────────────────────────────
  const [stores, setStores] = useState([]);
  useEffect(() => {
    apiFetch("/merch/by-store", {
      params: {
        from_date:   pageFrom   || undefined,
        to_date:     pageTo     || undefined,
        brand:       filters.brand       || undefined,
        subcategory: filters.subcategory || undefined,
      },
    })
      .then(d => setStores(d.rows || []))
      .catch(() => setStores([]));
  }, [pageFrom, pageTo, filters.brand, filters.subcategory, filters.dataVersion]);

  // ── PA params — shared by both primary + compare fetches ─────────────────
  const paBase = useMemo(() => ({
    store:        selectedStore || undefined,
    brand:        filters.brand        || undefined,
    product_type: filters.subcategory  || undefined,
    status:       "active",
  }), [selectedStore, filters.brand, filters.subcategory]);

  // ── Primary period ────────────────────────────────────────────────────────
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!pageFrom || !pageTo) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch("/analytics/product-analysis", {
      params: { ...paBase, date_from: pageFrom, date_to: pageTo },
    })
      .then(d  => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(()=> { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [paBase, pageFrom, pageTo, filters.dataVersion]);

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
            {fmtNum(summary.styles)} active styles · {fmtNum(summary.stock_units)} units in stock
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
              small showDelta={false} label="Active Styles" value={fmtNum(summary.styles)} icon={Tag}
              sub={`${fmtNum(summary.actively_selling)} selling this period`}
              testId="msc-styles"
            />
            <KPICard
              small showDelta={false} label="Avg Sell-Out" value={fmtSor(summary.avg_sor)} icon={Percent}
              formula="Sell-out rate = units sold ÷ (units sold + current stock)"
              testId="msc-sor"
            />
            <KPICard
              small showDelta={false} label="Avg WOC" value={fmtWoc(summary.avg_woc)} icon={ChartBar}
              formula="Weeks of cover = current stock ÷ weekly velocity"
              testId="msc-woc"
            />
          </div>

          {/* Row 3 — Unit economics: ASP card */}
          {asp != null && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="col-span-2 sm:col-span-1 lg:col-span-2">
                <KPICard
                  small label="Avg Selling Price" value={fmtKESLong(asp)} icon={CurrencyCircleDollar}
                  delta={aspDelta} showDelta={hasCompare}
                  sub={
                    <span>
                      {allStoresAsp != null && (
                        <span>
                          All-store avg: <span className="font-semibold">{fmtKESLong(allStoresAsp)}</span>
                          {asp > allStoresAsp
                            ? <span className="text-emerald-600 ml-1">(+{fmtNum(asp - allStoresAsp)} above)</span>
                            : asp < allStoresAsp
                            ? <span className="text-amber-600 ml-1">({fmtNum(allStoresAsp - asp)} below)</span>
                            : null}
                        </span>
                      )}
                      {hasCompare && cmpAsp != null && (
                        <span className={allStoresAsp != null ? "block mt-0.5 text-muted" : ""}>
                          Prior: {fmtKESLong(cmpAsp)}
                        </span>
                      )}
                      {!allStoresAsp && !hasCompare && (
                        <span>Revenue ÷ net units sold</span>
                      )}
                    </span>
                  }
                  formula="ASP = period revenue ÷ net units sold, using the same revenue formula as the Style Cockpit (gross sales minus returns). All-store avg uses the same period from the by-store feed."
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
                    <div className="text-[11px] text-muted uppercase tracking-wide mb-0.5">Rev / sq ft (period)</div>
                    <div className="text-[26px] font-bold">
                      {fmtKES(Math.round(storeRow.revenue_3m / storeRow.sqft))}
                    </div>
                  </div>
                )}
              </div>
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
                testId="msc-styles"
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
