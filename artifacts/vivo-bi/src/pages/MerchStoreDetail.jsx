/**
 * MerchStoreDetail — Store Performance Detail tab (tab 12, ?tab=merch-store)
 *
 * Reads ?style= from the URL. Fetches:
 *   • /api/merch/style-stores?style_number=X   → per-store performance
 *   • /api/merch/styles?style_number=X          → style metadata for header
 */
import React, { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, fmtKES, fmtKESLong, fmtNum, fmtPct } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { SortableTable } from "@/components/SortableTable";
import { useMerchFilters } from "./MerchandisingHub";
import MerchStyleSearch, { loadStyles } from "./MerchStyleSearch";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine, Cell, LabelList, ReferenceArea,
  PieChart, Pie, Legend,
} from "recharts";
import {
  Package, Storefront, ChartBar, ArrowsLeftRight, CurrencyCircleDollar, Percent,
} from "@phosphor-icons/react";

// ── WOC colour coding ─────────────────────────────────────────────────────────
const wocColor = (woc, stock) => {
  if (!stock || stock === 0) return "#ef4444"; // OOS
  if (woc < 1)  return "#ef4444";              // critical
  if (woc < 2)  return "#d97706";              // urgent
  if (woc < 4)  return "#eab308";              // watch
  return "#1a5c38";                             // ok
};

const wocLabel = (woc, stock) => {
  if (!stock || stock === 0) return "OOS";
  if (woc < 1)  return woc.toFixed(1);
  if (woc < 2)  return woc.toFixed(1);
  return woc.toFixed(1);
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

// ── Region mapping ────────────────────────────────────────────────────────────
// Simple rule-based region assignment from store name.
function storeRegion(name) {
  const n = String(name || "").toLowerCase();
  if (/nairobi|westgate|garden city|the hub|sarit|galleria|junction|yaya|prestige|cbd|town|city|karen/.test(n))
    return "Nairobi";
  if (/mombasa|coast|nyali|mvita|likoni/.test(n)) return "Coast";
  if (/rift|nakuru|eldoret|kisumu/.test(n)) return "Rift Valley";
  if (/western|kisii|kericho/.test(n)) return "Western";
  if (/central|thika|kirinyaga/.test(n)) return "Central";
  if (/eastern|meru|embu/.test(n)) return "Eastern";
  return "Other";
}

const REGION_COLORS = {
  Nairobi:     "#1a5c38",
  Coast:       "#4b7bec",
  "Rift Valley": "#d97706",
  Western:     "#7c3aed",
  Central:     "#00c853",
  Eastern:     "#ef4444",
  Other:       "#9ca3af",
};

// ── Store tier bands ──────────────────────────────────────────────────────────
const TIER_BANDS = {
  A: { label: "Flagship",  color: "#1a5c38", bg: "rgba(26,92,56,0.04)" },
  B: { label: "Standard",  color: "#4b7bec", bg: "rgba(75,123,236,0.04)" },
  C: { label: "Boutique/Regional", color: "#d97706", bg: "rgba(217,119,6,0.04)" },
};

// ── Main component ─────────────────────────────────────────────────────────────
const MerchStoreDetail = () => {
  const filters = useMerchFilters();
  const [searchParams, setSearchParams] = useSearchParams();

  const styleNumber = searchParams.get("style") || "";

  const [storeData, setStoreData] = useState({ stores: [], donors: [], recipients: [] });
  const [style, setStyle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  useEffect(() => {
    if (!styleNumber) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch("/merch/style-stores", { params: {
        style_number: styleNumber,
        from_date: filters.from_date,
        to_date:   filters.to_date,
        country:   filters.country,
      } }),
      // Fetch filtered styles so metrics (revenue, sor, etc.) respect the active filters.
      apiFetch("/merch/styles", { params: {
        from_date: filters.from_date,
        to_date:   filters.to_date,
        country:   filters.country,
      } }).then(d => d.styles || []),
    ])
      .then(([sd, allStylesList]) => {
        if (cancelled) return;
        setStoreData(sd || { stores: [], donors: [], recipients: [] });
        setStyle(allStylesList.find(s => s.style_number === styleNumber) || null);
      })
      .catch(e => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleNumber, filters.from_date, filters.to_date, filters.country, filters.dataVersion]);

  const handleStyleChange = (num) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set("style", num);
      return next;
    }, { replace: true });
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const stores = useMemo(() =>
    [...(storeData.stores || [])]
      .sort((a, b) => b.revenue_6m - a.revenue_6m),
    [storeData.stores]);

  // KPIs
  const totalStock = useMemo(() => stores.reduce((a, s) => a + (s.current_stock || 0), 0), [stores]);
  const storesOOS  = useMemo(() => stores.filter(s => !s.current_stock || s.current_stock === 0).length, [stores]);
  const storesWOClt2 = useMemo(() => stores.filter(s => s.woc > 0 && s.woc < 2 && s.current_stock > 0).length, [stores]);
  const bestStore  = useMemo(() => stores[0]?.store || "—", [stores]);
  const avgROS     = useMemo(() => {
    const valid = stores.filter(s => s.rate_of_sale > 0);
    if (!valid.length) return 0;
    return valid.reduce((a, s) => a + s.rate_of_sale, 0) / valid.length;
  }, [stores]);
  const totalRev6m = useMemo(() => stores.reduce((a, s) => a + (s.revenue_6m || 0), 0), [stores]);
  const totalUnits = useMemo(() => stores.reduce((a, s) => a + (s.units_6m || 0), 0), [stores]);

  // Revenue per store chart — sorted by revenue desc (already sorted)
  const revChart = useMemo(() =>
    stores.map(s => ({
      name: s.store,
      revenue: +(s.revenue_6m / 1000).toFixed(0),
      woc: s.woc,
      stock: s.current_stock,
      tier: s.store_tier,
      color: wocColor(s.woc, s.current_stock),
    })),
    [stores]);

  // ROS per store chart (sorted by revenue desc to match other charts)
  const rosChart = useMemo(() =>
    stores.map(s => ({
      name: s.store,
      ros: +(s.rate_of_sale || 0).toFixed(2),
      color: wocColor(s.woc, s.current_stock),
    })),
    [stores]);

  // Units per store
  const unitsChart = useMemo(() =>
    stores.map(s => ({
      name: s.store,
      units: s.units_6m || 0,
      color: wocColor(s.woc, s.current_stock),
    })),
    [stores]);

  // WOC chart — sorted high to low
  const wocChart = useMemo(() =>
    [...stores]
      .sort((a, b) => {
        // OOS at end
        if (!a.current_stock && b.current_stock) return 1;
        if (a.current_stock && !b.current_stock) return -1;
        return (b.woc || 0) - (a.woc || 0);
      })
      .map(s => ({
        name: s.store,
        woc: s.woc > 0 ? +(s.woc).toFixed(1) : 0,
        stock: s.current_stock,
        color: wocColor(s.woc, s.current_stock),
        label: wocLabel(s.woc, s.current_stock),
      })),
    [stores]);

  // Revenue by region donut
  const regionDonut = useMemo(() => {
    const map = {};
    for (const s of stores) {
      const r = storeRegion(s.store);
      map[r] = (map[r] || 0) + (s.revenue_6m || 0);
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [stores]);

  // Donor / recipient store lists from backend
  const donors     = storeData.donors || [];
  const recipients = storeData.recipients || [];

  // Find tier ranges for ReferenceArea bands
  const tierBands = useMemo(() => {
    const ranges = {};
    revChart.forEach((d, i) => {
      const t = d.tier || "C";
      if (!ranges[t]) ranges[t] = { start: i, end: i };
      else ranges[t].end = i;
    });
    return ranges;
  }, [revChart]);

  // Table columns
  const storeCols = [
    { key: "store",      label: "Store",          sortable: true, mobilePrimary: true },
    { key: "store_tier", label: "Tier",            sortable: true, render: r => r.store_tier || "C" },
    { key: "revenue_6m", label: "Revenue 6m",      sortable: true, numeric: true,
      render: r => fmtKES(r.revenue_6m) },
    { key: "units_6m",   label: "Units 6m",        sortable: true, numeric: true,
      render: r => fmtNum(r.units_6m) },
    { key: "rate_of_sale",label: "ROS /wk",        sortable: true, numeric: true,
      render: r => (r.rate_of_sale || 0).toFixed(1) },
    { key: "current_stock", label: "Stock",        sortable: true, numeric: true,
      render: r => fmtNum(r.current_stock) },
    { key: "woc",        label: "WOC",             sortable: true, numeric: true,
      render: r => r.woc > 0 ? r.woc.toFixed(1) + " wk" : "OOS" },
    { key: "action",     label: "Action",          sortable: true,
      render: r => <ActionPill action={r.action} /> },
  ];

  const avgROSRef = avgROS;

  if (!styleNumber) {
    return (
      <div className="space-y-4 pb-8">
        <div>
          <h2 className="text-[22px] font-bold text-foreground">Store Performance Detail</h2>
          <p className="text-[12px] text-muted mt-0.5">Select a style to view store performance</p>
        </div>
        <div className="card-white p-6 flex flex-col gap-3 items-start">
          <p className="text-[13px] font-medium">Choose a style:</p>
          <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
        </div>
      </div>
    );
  }

  if (loading) return <Loading label="Loading Store Performance Detail…" />;
  if (error)   return <ErrorBox message={error} />;

  return (
    <div className="space-y-5 pb-8">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-[22px] font-bold text-foreground leading-tight">
              {style?.style_name || styleNumber}
            </h2>
            <span className="text-[14px] text-muted font-medium shrink-0">
              — Store Performance Detail
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border text-[10.5px] font-semibold">
              Page 2 of 2
            </span>
          </div>
          <p className="text-[12px] text-muted mt-0.5 flex flex-wrap gap-x-2">
            {style && (
              <>
                <span className="font-mono">{style.style_number}</span>
                <span className="opacity-40">·</span>
                <span>{style.brand}</span>
                <span className="opacity-40">·</span>
                <span>{style.subcategory}</span>
                <span className="opacity-40">·</span>
                <span>{style.tier}</span>
                <span className="opacity-40">·</span>
                <span>{stores.length} stores</span>
              </>
            )}
            <span className="opacity-40">·</span>
            <span>As at {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
          </p>
          <div className="mt-1.5">
            <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="text-[11px] text-muted">Total 6m Revenue:</div>
          <div className="text-[18px] font-bold text-brand">{fmtKES(totalRev6m)}</div>
          <div className="text-[11px] text-muted">Total 6m Units:</div>
          <div className="text-[14px] font-bold tabular-nums">{fmtNum(totalUnits)}</div>
        </div>
      </div>

      {/* ── KPI Row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KPICard label="Total Stock (all stores)" value={fmtNum(totalStock)}
          sub={`WOC ${avgROS > 0 ? (totalStock / avgROS).toFixed(1) : "—"} wks overall`}
          icon={Package} showDelta={false} testId="sd-total-stock" />
        <KPICard label="Stores Out of Stock" value={<span className="text-rose-600">{storesOOS} stores</span>}
          sub="Need immediate supply"
          showDelta={false} testId="sd-oos" />
        <KPICard label="Stores WOC < 2wks" value={<span className="text-amber-600">{storesWOClt2} stores</span>}
          sub="Urgent reorder zone"
          showDelta={false} testId="sd-low-woc" />
        <KPICard label="Best Store (Revenue)" value={bestStore}
          sub={stores[0] ? fmtKES(stores[0].revenue_6m) + "/6m" : ""}
          icon={Storefront} showDelta={false} testId="sd-best-store" />
        <KPICard label="Avg ROS per Store" value={avgROS.toFixed(1) + " units/wk"}
          sub={`Range ${Math.min(...stores.map(s=>s.rate_of_sale||0)).toFixed(1)}–${Math.max(...stores.map(s=>s.rate_of_sale||0)).toFixed(1)}`}
          icon={ChartBar} showDelta={false} testId="sd-avg-ros" />
        <KPICard label="Gross Margin (6m est.)" value="—"
          sub="Cost N/A · not available"
          showDelta={false} testId="sd-gm" />
      </div>

      {/* ── Revenue per Store + ROS per Store ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Revenue per Store */}
        <div className="card-white p-5">
          <SectionTitle
            title="Revenue per Store — 6 Months (colour = WOC risk)"
            subtitle={
              <span className="flex flex-wrap gap-3 text-[10px] mt-1">
                {[["#ef4444","Out of stock / WOC < 1wk"],["#d97706","WOC 1–2 wks"],["#eab308","WOC 2–4 wks"],["#1a5c38","WOC > 4 wks (overstocked)"]].map(([c,l])=>(
                  <span key={l} className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{background:c}}/>
                    {l}
                  </span>
                ))}
              </span>
            }
          />
          <div className="flex items-center gap-1 text-[10.5px] text-muted mt-1 mb-1 flex-wrap">
            <span className="font-semibold text-brand">Flagship</span>
            <span className="mx-1 opacity-40">|</span>
            <span className="font-semibold text-[#4b7bec]">Standard</span>
            <span className="mx-1 opacity-40">|</span>
            <span className="font-semibold text-[#9ca3af]">Regional</span>
          </div>
          {revChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={revChart} margin={{ top: 8, right: 8, left: 0, bottom: 60 }}>
                  {/* Tier background bands */}
                  {Object.entries(tierBands).map(([tier, { start, end }]) => (
                    <ReferenceArea
                      key={tier}
                      x1={revChart[start]?.name}
                      x2={revChart[end]?.name}
                      fill={TIER_BANDS[tier]?.bg || "transparent"}
                      fillOpacity={1}
                    />
                  ))}
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 8 }} angle={-45} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={v => "K" + v} />
                  <Tooltip
                    formatter={(v, n, p) => [fmtKES(v * 1000), "Revenue"]}
                    labelFormatter={l => l}
                  />
                  <Bar dataKey="revenue" name="Revenue" radius={[3, 3, 0, 0]}>
                    {revChart.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                    {/* Label top 10 stores */}
                    <LabelList
                      dataKey="revenue"
                      position="top"
                      style={{ fontSize: 8 }}
                      formatter={(v, _, idx) => idx < 10 ? "K" + v : ""}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* ROS per Store */}
        <div className="card-white p-5">
          <SectionTitle
            title="Rate of Sale per Store (colour = WOC risk)"
            subtitle="Units/week · 6-month average"
          />
          {rosChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={rosChart} margin={{ top: 8, right: 8, left: 0, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 8 }} angle={-45} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v) => [v + " units/wk", "ROS"]} />
                  <ReferenceLine
                    y={avgROSRef}
                    stroke="#1a5c38"
                    strokeDasharray="5 3"
                    label={{ value: `Portfolio avg ${avgROSRef.toFixed(1)}/wk`, position: "right", style: { fontSize: 9, fill: "#1a5c38" } }}
                  />
                  <Bar dataKey="ros" name="ROS /wk" radius={[3, 3, 0, 0]}>
                    {rosChart.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>

      {/* ── Units per Store + WOC per Store ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Units per Store */}
        <div className="card-white p-5">
          <SectionTitle title="Units Sold per Store — 6 Months" />
          {unitsChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={unitsChart} margin={{ top: 8, right: 8, left: 0, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 8 }} angle={-45} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v) => [fmtNum(v), "Units"]} />
                  <Bar dataKey="units" name="Units" radius={[3, 3, 0, 0]}>
                    {unitsChart.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* WOC per Store — sorted high to low */}
        <div className="card-white p-5">
          <SectionTitle title="Weeks of Cover per Store (sorted high → low)" />
          {wocChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={wocChart} margin={{ top: 8, right: 8, left: 0, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 8 }} angle={-45} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 9 }} label={{ value: "WOC", angle: -90, position: "insideLeft", style: { fontSize: 9 } }} />
                  <Tooltip formatter={(v, n, p) => [
                    p.payload.stock ? v + " weeks" : "Out of stock", "WOC"
                  ]} />
                  <ReferenceLine y={2} stroke="#d97706" strokeDasharray="5 3"
                    label={{ value: "Reorder 2wk", position: "right", style: { fontSize: 9, fill: "#d97706" } }} />
                  <ReferenceLine y={1} stroke="#ef4444" strokeDasharray="5 3"
                    label={{ value: "Critical 1wk", position: "right", style: { fontSize: 9, fill: "#ef4444" } }} />
                  <Bar dataKey="woc" name="WOC" radius={[3, 3, 0, 0]}>
                    {wocChart.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                    <LabelList
                      dataKey="label"
                      position="top"
                      style={{ fontSize: 8 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>

      {/* ── Full Store Data Table + Transfer Plan + Revenue by Region ────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Store data table — 7 */}
        <div className="lg:col-span-7 card-white p-5">
          <SectionTitle
            title={`Full Store Data Table — All ${stores.length} Stores`}
          />
          <div className="mt-3">
            <SortableTable
              columns={storeCols}
              rows={stores}
              initialSort={{ key: "revenue_6m", dir: "desc" }}
              exportName={`store_detail_${styleNumber}.csv`}
              maxHeight="50vh"
              testId="store-detail-table"
            />
          </div>
        </div>

        {/* Transfer Plan + Donut — 5 */}
        <div className="lg:col-span-5 space-y-4">
          {/* Transfer Plan */}
          <div className="card-white p-5">
            <SectionTitle title="Transfer Plan" />
            {donors.length === 0 && recipients.length === 0
              ? <div className="mt-2 text-[12px] text-muted">No transfers recommended at this time.</div>
              : (
                <div className="mt-3 space-y-3">
                  {donors.length > 0 && (
                    <div>
                      <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-teal-700 mb-1.5">
                        DONOR STORES (surplus stock)
                      </div>
                      <div className="space-y-1">
                        {donors.map((storeName, i) => {
                          const s = stores.find(x => x.store === storeName);
                          const recipient = recipients[i] || "—";
                          const recip = stores.find(x => x.store === recipient);
                          return (
                            <div key={i} className="flex items-center gap-2 text-[11.5px] bg-teal-50 rounded px-2 py-1.5 border border-teal-200">
                              <span className="font-semibold text-teal-800 flex-1 truncate">{storeName}</span>
                              <span className="text-muted">→</span>
                              <span className="font-semibold text-blue-700 flex-1 truncate">{recipient}</span>
                              <span className="text-[10px] text-muted">
                                {s ? `${s.current_stock > 2 ? 2 : 1}u` : "1u"}
                              </span>
                              <span className={`text-[10px] font-bold ${
                                (recip?.woc || 0) < 1 ? "text-rose-600" : "text-amber-600"
                              }`}>
                                {(recip?.woc || 0) < 1 ? "HIGH" : "MED"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {recipients.length > 0 && (
                    <div>
                      <div className="text-[10.5px] font-extrabold uppercase tracking-wide text-blue-700 mb-1.5">
                        RECIPIENT STORES (largest stock need)
                      </div>
                      <div className="space-y-1">
                        {recipients.map((storeName, i) => {
                          const s = stores.find(x => x.store === storeName);
                          return (
                            <div key={i} className="flex items-center gap-2 text-[11.5px] bg-blue-50 rounded px-2 py-1.5 border border-blue-200">
                              <span className="font-semibold text-blue-800 flex-1 truncate">{storeName}</span>
                              <span className="text-[10.5px] text-muted">
                                WOC: {s?.woc > 0 ? s.woc.toFixed(1) + " wks" : "OOS"}
                              </span>
                              <span className="text-[10px] font-bold text-rose-600">Recv 2u</span>
                              <span className="text-[10px] text-muted">
                                {s?.rate_of_sale ? (s.rate_of_sale).toFixed(1) + "/wk" : ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="text-[10px] text-muted border-t border-line pt-2">
                    ⓘ Total transferable: {donors.length} stores ·
                    Still need to reorder ~{Math.max(0, recipients.length - donors.length)} units to cover 4-week demand.
                  </div>
                </div>
              )}
          </div>

          {/* Revenue by Region donut */}
          <div className="card-white p-5">
            <SectionTitle title="Revenue Share by Region" />
            {regionDonut.length === 0
              ? <Empty />
              : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={regionDonut}
                      cx="50%"
                      cy="45%"
                      innerRadius={50}
                      outerRadius={75}
                      dataKey="value"
                      nameKey="name"
                      label={({ name, percent }) => percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ""}
                      labelLine={false}
                    >
                      {regionDonut.map((d, i) => (
                        <Cell key={i} fill={REGION_COLORS[d.name] || "#9ca3af"} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v, n) => [fmtKES(v), n]} />
                    <Legend
                      layout="vertical"
                      align="right"
                      verticalAlign="middle"
                      wrapperStyle={{ fontSize: 10 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            {regionDonut[0] && (
              <div className="text-[10px] text-muted text-center mt-1">
                {regionDonut[0].name}: {((regionDonut[0].value / totalRev6m) * 100).toFixed(0)}% of revenue
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MerchStoreDetail;
