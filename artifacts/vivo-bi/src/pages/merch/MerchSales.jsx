/**
 * Sales & Pricing tab — Merchandising Hub
 * Consolidates the former Sales Performance, Financial Performance and
 * Sell-Through & Markdown tabs plus the unique charts from Category
 * Performance (Task 1286), organised in three sections:
 *   1. Sales — revenue/units KPIs, top styles, revenue by subcategory,
 *      units by brand, weekly velocity by subcategory, revenue-vs-SOR
 *      bubble matrix (+ category CSV export)
 *   2. Pricing & Realisation — tier/brand price + realisation charts,
 *      price-band distribution, FP% by subcategory vs 85% target, FP% mix
 *   3. Sell-Through — SOR KPIs and the five sell-through charts
 * Duplicated revenue-by-subcategory/brand/tier and full-price charts from
 * the source tabs appear exactly once. All sections share ONE fetch of the
 * five /api/merch/* aggregates (the source tabs each fetched the same set).
 *
 * API contracts:
 *   summary  → { total_styles, units_6m, revenue_6m, weekly_velocity,
 *                avg_full_price_pct, avg_sor_6m, avg_gross_margin_pct, ... }
 *   styles   → { styles: [...] }   each row has: style_name, brand, tier,
 *               units_6m, revenue_6m, units_life, revenue_life, full_price,
 *               full_price_pct, avg_selling_price, woc, sor_6m, current_stock
 *   by-brand → { rows: [{ brand, style_count, units_6m, revenue_6m,
 *                          avg_full_price_pct, avg_sor_6m,
 *                          avg_gross_margin_pct }] }
 *   by-subcategory → { rows: [{ subcategory, revenue_6m, units_6m,
 *                          current_stock, style_count, avg_sor_6m,
 *                          avg_full_price_pct }] }
 *   by-tier  → { rows: [{ tier, style_count, revenue_6m, units_6m,
 *                          avg_full_price_pct, avg_sor_6m }] }
 */
import React, { useMemo, useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Cell, PieChart, Pie, Legend, LabelList, ReferenceLine,
  ScatterChart, Scatter, ZAxis, ComposedChart, Line,
} from "recharts";
import { DownloadSimple } from "@phosphor-icons/react";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import {
  useMerchData, MerchKPICard, ChartCard, SubcatFilter,
  C, fmtKESM, fmtKESFull, fmtPct1, fmtNum, fmtAxisM,
  useMerchPeriodLabel,
} from "./MerchHelpers";
import { useMerchFilters } from "@/pages/MerchandisingHub";
import { useFilters } from "@/lib/filters";
import { api, comparePeriod, fmtKES, fmtPct, fmtDec } from "@/lib/api";

const KesTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1 max-w-[180px] truncate">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtKESM(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const NumTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const PriceTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtKESM(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const SorTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtPct1(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// Scatter dot tooltip (Lifetime vs 6m SOR)
const ScatterTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1 max-w-[180px] truncate">{p?.style_name}</div>
      <div>SOR 6m: <strong>{fmtPct1(p?.x)}</strong></div>
      <div>SOR Lifetime: <strong>{fmtPct1(p?.y)}</strong></div>
    </div>
  );
};

// Bubble-matrix tooltip (Category Matrix: Revenue vs SOR)
const BubbleTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg p-3 text-[12px] min-w-[160px]">
      <p className="font-bold text-foreground mb-1">{d.subcategory}</p>
      <p className="text-muted">Revenue: <span className="text-foreground font-medium">{fmtKES(d.revenue_6m_raw)}</span></p>
      <p className="text-muted">SOR: <span className="text-foreground font-medium">{d.sor !== null ? fmtDec(d.sor, 1) + "%" : "—"}</span></p>
      <p className="text-muted">Stock: <span className="text-foreground font-medium">{fmtNum(d.current_stock)}</span></p>
      <p className="text-muted">Styles: <span className="text-foreground font-medium">{d.style_count}</span></p>
    </div>
  );
};

const FP_MIX_COLORS = [C.red, C.amber, C.blue, C.green];
const SOR_DIST_COLORS = [C.red, C.amber, C.green, "#22d3ee"];
const TIER_COLORS  = { "Tier 1": "#1a5c38", "Tier 2": "#00c853", "Tier 3": "#4b7bec", "Tier 4": "#d97706" };
const PRICE_DONUT_COLORS = ["#1a5c38", "#00c853", "#4b7bec", "#d97706", "#ef4444"];
const PRICE_BUCKETS = ["<KES 2K", "2K–4K", "4K–6K", "6K–8K", ">8K"];

const SUBCAT_COLORS = [
  "#1a5c38", "#00c853", "#d97706", "#4b7bec", "#7c3aed",
  "#0891b2", "#be185d", "#065f46", "#9f1239", "#1e40af",
];

// SOR band colour (green / amber / red)
const SOR_COLOR = (sor) => {
  if (sor === null || sor === undefined) return "#94a3b8";
  if (sor >= 60) return "#1a5c38";
  if (sor >= 40) return "#d97706";
  return "#ef4444";
};

const bandColorByValue = (val) => {
  if (val == null) return C.muted;
  if (val >= 60)   return C.green;
  if (val >= 40)   return C.amber;
  return C.red;
};

// Truncate long subcategory names for chart labels
const truncate = (s, n = 20) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

// Price-band bucket helper (full_price in KES)
function priceBuckets(styles) {
  const buckets = [0, 0, 0, 0, 0];
  for (const s of styles) {
    const p = s.full_price || 0;
    if (p < 2000)       buckets[0]++;
    else if (p < 4000)  buckets[1]++;
    else if (p < 6000)  buckets[2]++;
    else if (p < 8000)  buckets[3]++;
    else                buckets[4]++;
  }
  return PRICE_BUCKETS.map((name, i) => ({ name, value: buckets[i] })).filter(d => d.value > 0);
}

// Section heading used to organise the merged content
const SectionHeader = ({ title, subtitle, right }) => (
  <div className="flex items-start justify-between gap-3 flex-wrap border-t border-slate-200 pt-5">
    <div>
      <h2 className="text-[18px] font-bold text-foreground">{title}</h2>
      {subtitle && <p className="text-[13px] text-muted mt-0.5">{subtitle}</p>}
    </div>
    {right}
  </div>
);

export default function MerchSales() {
  const filters     = useMerchFilters();
  const { applied } = useFilters();
  const [localSubcat,   setLocalSubcat]   = useState(null);
  const [prevStyleRows, setPrevStyleRows] = useState([]);

  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"], localSubcat);

  // styles → { styles: [...] }
  const styleRows = useMemo(() => styles?.styles || [], [styles]);
  const subRows   = useMemo(() => bySubcategory?.rows || [], [bySubcategory]);
  const brandRows = useMemo(() => byBrand?.rows || [], [byBrand]);
  const tierRows  = useMemo(() => byTier?.rows || [], [byTier]);

  // ════════════════ SALES derivations ════════════════

  // Charts follow the global date filter: *_period fields are scoped to the
  // selected range (default = trailing 6 months when no dates are set).
  const selRev   = (r) => (r.revenue_period ?? r.revenue_6m) || 0;
  const selUnits = (r) => (r.units_period   ?? r.units_6m)   || 0;
  // Shared compact suffix for chart/KPI labels.
  const periodTag = useMerchPeriodLabel();

  // Top 10 styles by period revenue
  const top10Styles = useMemo(() =>
    [...styleRows].map((r) => ({ ...r, revenue_sel: selRev(r) }))
      .sort((a, b) => b.revenue_sel - a.revenue_sel).slice(0, 10),
    [styleRows]);

  // Revenue by Subcategory
  const subcatRevenue = useMemo(() =>
    [...subRows].map((r) => ({ ...r, revenue_sel: selRev(r) }))
      .sort((a, b) => b.revenue_sel - a.revenue_sel).slice(0, 10),
    [subRows]);

  // Units by Brand
  const brandUnits = useMemo(() =>
    [...brandRows].map((r) => ({ ...r, units_sel: selUnits(r) }))
      .sort((a, b) => b.units_sel - a.units_sel),
    [brandRows]);

  // Bubble matrix: Revenue vs SOR per subcategory (bubble size = stock)
  const bubbleData = useMemo(() =>
    subRows.map(r => ({
      subcategory:    r.subcategory,
      revenue_6m:     Math.round(selRev(r) / 1_000_000),   // KES M (axis only)
      revenue_6m_raw: selRev(r),                            // raw KES for tooltip
      sor:            r.avg_sor_6m,
      current_stock:  r.current_stock || 0,
      style_count:    r.style_count || 0,
      z:              Math.max(20, Math.min(800, (r.current_stock || 0) / 3)),
      fill:           SOR_COLOR(r.avg_sor_6m),
    })), [subRows]);

  // Weekly velocity by subcategory (units_6m / 26 wks, top 12)
  const weeklyVelData = useMemo(() => {
    const weekly = subRows.map(r => ({ ...r, weekly_vel: Math.round((r.units_6m || 0) / 26) }));
    return [...weekly].sort((a, b) => (b.weekly_vel || 0) - (a.weekly_vel || 0))
      .slice(0, 12)
      .map((r, i) => ({ name: truncate(r.subcategory, 22), value: r.weekly_vel, fill: SUBCAT_COLORS[i % SUBCAT_COLORS.length] }));
  }, [subRows]);

  // ════════════════ PRICING derivations ════════════════

  // Avg Full Price (KES) per tier — computed from style rows grouped by tier
  // Each style has a `full_price` (modal price in KES); weight by units_6m for the avg
  const tierFullPriceMap = useMemo(() => {
    const map = {};
    for (const r of styleRows) {
      const t   = r.tier || "—";
      const fp  = r.full_price;
      const u   = r.units_6m || 0;
      if (fp == null || fp <= 0) continue;
      if (!map[t]) map[t] = { sumWt: 0, sumUnits: 0 };
      map[t].sumWt    += fp * u;
      map[t].sumUnits += u;
    }
    return map;
  }, [styleRows]);

  // Avg Full Price vs Avg Selling Price by Tier — both in KES
  const tierPrices = useMemo(() =>
    tierRows.map((r) => {
      const fpMap   = tierFullPriceMap[r.tier] || {};
      const avgFP   = fpMap.sumUnits > 0 ? Math.round(fpMap.sumWt / fpMap.sumUnits) : null;
      const avgSell = r.units_6m > 0 ? Math.round((r.revenue_6m || 0) / r.units_6m) : null;
      return {
        tier:             r.tier,
        "Avg Full Price": avgFP   ?? 0,
        "Avg Sell Price": avgSell ?? 0,
      };
    }), [tierRows, tierFullPriceMap]);

  // FP% distribution (4 buckets) computed from styles
  const fpMixData = useMemo(() => {
    const buckets = { "<70%": 0, "70-85%": 0, "85-95%": 0, ">95%": 0 };
    for (const r of styleRows) {
      const fp = r.full_price_pct;
      if (fp === null || fp === undefined) continue;
      if (fp < 70)      buckets["<70%"]++;
      else if (fp < 85) buckets["70-85%"]++;
      else if (fp < 95) buckets["85-95%"]++;
      else              buckets[">95%"]++;
    }
    return Object.entries(buckets)
      .map(([name, value]) => ({ name, value }))
      .filter((x) => x.value > 0);
  }, [styleRows]);

  // Avg FP% by subcategory vs 85% target (top 12)
  const fpBySubcat = useMemo(() =>
    [...subRows].filter(r => r.avg_full_price_pct !== null)
      .sort((a, b) => (b.avg_full_price_pct || 0) - (a.avg_full_price_pct || 0))
      .slice(0, 12)
      .map((r) => ({
        name:  truncate(r.subcategory, 22),
        value: r.avg_full_price_pct,
        fill:  (r.avg_full_price_pct || 0) >= 85 ? "#1a5c38" : "#d97706",
      })),
    [subRows]);

  // Portfolio price averages (from the retired Financial tab). The Revenue
  // (Lifetime) card moved to the Style Deep Dive — lifetime revenue only
  // makes sense at style level.
  const avgFullPrice = useMemo(() => {
    const valid = styleRows.filter(s => s.full_price > 0);
    if (!valid.length) return 0;
    return valid.reduce((a, b) => a + b.full_price, 0) / valid.length;
  }, [styleRows]);

  const avgSellPrice = useMemo(() => {
    const valid = styleRows.filter(s => s.avg_selling_price > 0);
    if (!valid.length) return 0;
    return valid.reduce((a, b) => a + b.avg_selling_price, 0) / valid.length;
  }, [styleRows]);

  const priceReal = avgFullPrice > 0 ? (avgSellPrice / avgFullPrice) * 100 : 0;

  // Pre-group styles by brand once for brand chart calculations
  const stylesByBrand = useMemo(() => {
    const map = {};
    styleRows.forEach(s => {
      if (!s.brand) return;
      if (!map[s.brand]) map[s.brand] = [];
      map[s.brand].push(s);
    });
    return map;
  }, [styleRows]);

  const brandRealChart = useMemo(() =>
    brandRows.slice(0, 5).map(r => {
      const brandStyles = stylesByBrand[r.brand] || [];
      const validFP    = brandStyles.filter(s => s.full_price > 0);
      const validSell  = brandStyles.filter(s => s.avg_selling_price > 0);
      return {
        name: r.brand || "—",
        fullPrice:   +(validFP.length   ? validFP.reduce((a, b) => a + b.full_price, 0) / validFP.length / 1000 : 0).toFixed(2),
        avgSelling:  +(validSell.length ? validSell.reduce((a, b) => a + b.avg_selling_price, 0) / validSell.length / 1000 : 0).toFixed(2),
        realisation: +(r.avg_full_price_pct || 0),
        // Gross margin % is only available for styles where cost data exists;
        // null means no cost data for this brand.
        grossMargin: r.avg_gross_margin_pct != null ? +r.avg_gross_margin_pct.toFixed(1) : null,
      };
    }), [brandRows, stylesByBrand]);

  const tierAvgRevChart = useMemo(() =>
    tierRows.map(r => ({
      name: r.tier,
      avgRev: r.style_count > 0 ? +((r.revenue_6m / r.style_count) / 1e6).toFixed(3) : 0,
      label: r.style_count > 0 ? fmtKES(r.revenue_6m / r.style_count) : "—",
    })), [tierRows]);

  // Aggregate lifetime revenue per brand from the per-style records (which do
  // carry revenue_life). The /merch/by-brand endpoint does not return a
  // brand-level lifetime aggregate, so we roll it up client-side.
  const brandLifetimeMap = useMemo(() => {
    const map = {};
    styleRows.forEach(s => {
      if (!s.brand) return;
      map[s.brand] = (map[s.brand] || 0) + (s.revenue_life || 0);
    });
    return map;
  }, [styleRows]);

  const lifetimeVs6mChart = useMemo(() =>
    brandRows.slice(0, 5).map(r => ({
      name: r.brand || "—",
      lifetime: +((brandLifetimeMap[r.brand] || 0) / 1e6).toFixed(1),
      sixm: +(r.revenue_6m / 1e6).toFixed(1),
    })), [brandRows, brandLifetimeMap]);

  const priceBandDonut = useMemo(() => priceBuckets(styleRows), [styleRows]);

  // ════════════════ SELL-THROUGH derivations ════════════════

  // Derive lifetime SOR per style (not in API) from units_life + current_stock
  const stylesWithLifetimeSOR = useMemo(() => styleRows.map((r) => {
    const denom = (r.units_life || 0) + (r.current_stock || 0);
    const sor_life = denom > 0 ? Math.round((r.units_life || 0) * 100 / denom * 10) / 10 : null;
    return { ...r, sor_life };
  }), [styleRows]);

  // KPI derived counts
  const [stylesHiSOR, stylesLoSOR, avgLifetimeSOR] = useMemo(() => {
    let hi = 0, lo = 0, sum = 0, cnt = 0;
    for (const r of stylesWithLifetimeSOR) {
      if ((r.sor_6m || 0) >= 90) hi++;
      if (r.sor_6m != null && r.sor_6m < 40) lo++;
      if (r.sor_life != null) { sum += r.sor_life; cnt++; }
    }
    return [hi, lo, cnt > 0 ? Math.round(sum / cnt * 10) / 10 : null];
  }, [stylesWithLifetimeSOR]);

  // SOR by Subcategory — sorted ascending so lowest are at top (most at risk)
  const subcatSOR = useMemo(() =>
    [...subRows]
      .filter((r) => r.avg_sor_6m != null)
      .sort((a, b) => (a.avg_sor_6m || 0) - (b.avg_sor_6m || 0))
      .slice(0, 10)
      .map((r) => ({ ...r, color: bandColorByValue(r.avg_sor_6m) })),
    [subRows]);

  // Scatter: SOR 6m (x) vs SOR Lifetime (y), colour by SOR band
  const scatterData = useMemo(() => {
    const result = [];
    for (const r of stylesWithLifetimeSOR) {
      if (r.sor_6m == null || r.sor_life == null) continue;
      result.push({
        x:          r.sor_6m,
        y:          r.sor_life,
        style_name: r.style_name,
        _color:     bandColorByValue(r.sor_6m),
      });
    }
    return result;
  }, [stylesWithLifetimeSOR]);

  // Split scatter data into 3 colour bands for legend
  const scatterBands = useMemo(() => ({
    high:   { name: "SOR ≥ 60%", data: scatterData.filter((r) => r.x >= 60),                color: C.green },
    mid:    { name: "SOR 40-59%", data: scatterData.filter((r) => r.x >= 40 && r.x < 60),   color: C.amber },
    low:    { name: "SOR < 40%",  data: scatterData.filter((r) => r.x < 40),                 color: C.red   },
  }), [scatterData]);

  // FP% vs SOR by Brand
  const brandFPSOR = useMemo(() =>
    [...brandRows].sort((a, b) => (b.avg_sor_6m || 0) - (a.avg_sor_6m || 0)),
    [brandRows]);

  // SOR distribution from styles
  const sorDist = useMemo(() => {
    const b = { "<40%": 0, "40-60%": 0, "60-80%": 0, ">80%": 0 };
    for (const r of styleRows) {
      const v = r.sor_6m;
      if (v == null) continue;
      if (v < 40)      b["<40%"]++;
      else if (v < 60) b["40-60%"]++;
      else if (v < 80) b["60-80%"]++;
      else             b[">80%"]++;
    }
    return Object.entries(b).map(([name, value], i) => ({ name, value, color: SOR_DIST_COLORS[i] }));
  }, [styleRows]);

  // ════════════════ KPI extras + compare period ════════════════

  const avgUnitsPerStyle = useMemo(() =>
    (summary?.total_styles && (summary?.units_period ?? summary?.units_6m))
      ? Math.round((summary.units_period ?? summary.units_6m) / summary.total_styles)
      : 0,
    [summary]);

  // Styles with >95% FP — count from styleRows
  const stylesHiFp = useMemo(() => styleRows.filter((r) => (r.full_price_pct || 0) >= 95).length, [styleRows]);

  // Average unit (selling) price — weighted by units sold
  const avgUnitPrice = useMemo(() => {
    const totalRev   = styleRows.reduce((s, r) => s + selRev(r), 0);
    const totalUnits = styleRows.reduce((s, r) => s + selUnits(r), 0);
    return totalUnits > 0 ? Math.round(totalRev / totalUnits) : 0;
  }, [styleRows]);

  // Weighted average full price (KES) across the portfolio — weight by units_6m
  const avgFullPriceKES = useMemo(() => {
    let sumWt = 0, sumUnits = 0;
    for (const r of styleRows) {
      const fp = r.full_price;
      const u  = r.units_6m || 0;
      if (fp == null || fp <= 0) continue;
      sumWt    += fp * u;
      sumUnits += u;
    }
    return sumUnits > 0 ? Math.round(sumWt / sumUnits) : 0;
  }, [styleRows]);

  // Derive the compare date range from the global filter-bar compare mode.
  const compareRange = useMemo(() =>
    comparePeriod(
      applied.dateFrom, applied.dateTo,
      applied.compareMode, applied.compareDateFrom, applied.compareDateTo
    ),
    [applied.dateFrom, applied.dateTo, applied.compareMode,
     applied.compareDateFrom, applied.compareDateTo]);

  // Fetch /merch/styles for the compare period whenever the range changes.
  useEffect(() => {
    if (!compareRange) { setPrevStyleRows([]); return; }
    let cancelled = false;
    const effSubcat = localSubcat !== null ? localSubcat : (filters.subcategory || "");
    const params = {
      from_date:    compareRange.date_from,
      to_date:      compareRange.date_to,
      country:      filters.country,
      pos_location: filters.pos_location,
      brand:        filters.brand,
      ...(effSubcat ? { subcategory: effSubcat } : {}),
    };
    api.get("/merch/styles", { params })
      .then((r) => { if (!cancelled) setPrevStyleRows(r.data?.styles || []); })
      .catch(() => { if (!cancelled) setPrevStyleRows([]); });
    return () => { cancelled = true; };
  }, [
    applied.dateFrom, applied.dateTo, applied.compareMode,
    applied.compareDateFrom, applied.compareDateTo,
    filters.country, filters.pos_location, filters.brand,
    filters.subcategory, filters.dataVersion, localSubcat,
    // compareRange is stable (memoized) but listed deps are the real triggers
  ]);

  // Compare period weighted averages
  const prevAvgUnitPrice = useMemo(() => {
    const totalRev   = prevStyleRows.reduce((s, r) => s + ((r.revenue_period ?? r.revenue_6m) || 0), 0);
    const totalUnits = prevStyleRows.reduce((s, r) => s + ((r.units_period ?? r.units_6m) || 0), 0);
    return totalUnits > 0 ? Math.round(totalRev / totalUnits) : null;
  }, [prevStyleRows]);

  const prevAvgFullPriceKES = useMemo(() => {
    let sumWt = 0, sumUnits = 0;
    for (const r of prevStyleRows) {
      const fp = r.full_price;
      const u  = r.units_6m || 0;
      if (fp == null || fp <= 0) continue;
      sumWt    += fp * u;
      sumUnits += u;
    }
    return sumUnits > 0 ? Math.round(sumWt / sumUnits) : null;
  }, [prevStyleRows]);

  // Trend %: positive = up vs compare period, negative = down
  const aupTrend = (avgUnitPrice && prevAvgUnitPrice)
    ? ((avgUnitPrice - prevAvgUnitPrice) / prevAvgUnitPrice * 100)
    : null;

  if (loading) return <Loading label="Loading Sales & Pricing…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};
  const dateSlug = new Date().toISOString().slice(0, 10);

  // Category CSV export (from the retired Category Performance tab)
  const handleCategoryDownload = () => {
    const headers = ["Subcategory", "Revenue 6m (KES)", "Avg SOR 6m (%)", "Weekly Velocity (units/wk)", "Avg Full Price (%)", "Style Count"];
    const rows = [...subRows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0)).map(r => [
      `"${(r.subcategory || "").replace(/"/g, '""')}"`,
      Math.round(r.revenue_6m || 0),
      r.avg_sor_6m !== null && r.avg_sor_6m !== undefined ? Number(r.avg_sor_6m).toFixed(1) : "",
      Math.round((r.units_6m || 0) / 26),
      r.avg_full_price_pct !== null && r.avg_full_price_pct !== undefined ? Number(r.avg_full_price_pct).toFixed(1) : "",
      r.style_count || 0,
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `category-performance-${dateSlug}.csv`;
    a.click();
  };

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[11px] text-slate-400">
          Sales, Pricing &amp; Sell-Through Analysis · follows the global date filter (defaults to last 6 months); SOR/velocity metrics use a fixed 6-month basis
        </div>
        <SubcatFilter value={localSubcat} onChange={setLocalSubcat} />
      </div>

      {/* ════ 1. SALES ════ */}

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <MerchKPICard
          label={`Revenue (${periodTag})`}
          value={fmtKESM(s.revenue_period ?? s.revenue_6m)}
          sub="Avg per Style"
          sub2={s.total_styles ? fmtKESM((s.revenue_period ?? s.revenue_6m) / s.total_styles) : "—"}
          accentColor={C.blue}
          testId="merch-sales-kpi-revenue"
        />
        <MerchKPICard
          label={`Units Sold (${periodTag})`}
          value={fmtNum(s.units_period ?? s.units_6m)}
          sub="Avg per Style"
          sub2={`${fmtNum(avgUnitsPerStyle)} units`}
          accentColor={C.teal}
          testId="merch-sales-kpi-units"
        />
        <MerchKPICard
          label="Avg Unit Price"
          value={fmtKESFull(avgUnitPrice)}
          sub="Avg Full Price"
          sub2={fmtKESFull(avgFullPriceKES)}
          trend={aupTrend}
          trendLabel={compareRange?.label}
          accentColor={C.purple}
          testId="merch-sales-kpi-aup"
        />
        <MerchKPICard
          label="Price Realisation"
          value={fmtPct1(priceReal)}
          sub="Avg sell / full price ratio"
          sub2={`Full ${fmtKESFull(avgFullPrice)} · Sell ${fmtKESFull(avgSellPrice)}`}
          accentColor="#0891b2"
          testId="fin-price-real"
        />
        <MerchKPICard
          label="Avg Full Price %"
          value={fmtPct1(s.avg_full_price_pct)}
          sub="Styles >95% FP"
          sub2={`${fmtNum(stylesHiFp)} styles`}
          accentColor={C.green}
          testId="merch-sales-kpi-fp"
        />
        <MerchKPICard
          label="Total Weekly Vel."
          value={`${fmtNum(s.weekly_velocity)} /wk`}
          sub="Avg per Style"
          sub2={s.total_styles ? `${(s.weekly_velocity / s.total_styles).toFixed(1)} /wk` : "—"}
          accentColor={C.amber}
          testId="merch-sales-kpi-vel"
        />
      </div>

      {/* ── Top 10 styles + Revenue by Subcat ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={`Top 10 Revenue Generating Styles (${periodTag})`}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={top10Styles} layout="vertical" margin={{ top: 0, right: 65, left: 130, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="style_name"
                tick={{ fontSize: 9 }}
                width={130}
                tickFormatter={(v) => v?.length > 24 ? v.slice(0, 24) + "…" : v}
              />
              <Tooltip content={<KesTooltip />} />
              <Bar dataKey="revenue_sel" name="Revenue" fill={C.teal} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_sel" position="right" formatter={fmtKESM} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={`Revenue by Subcategory (${periodTag})`}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={subcatRevenue} margin={{ top: 10, right: 10, left: 0, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="subcategory"
                tick={{ fontSize: 9 }}
                interval={0}
                angle={-35}
                textAnchor="end"
              />
              <YAxis tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <Tooltip content={<KesTooltip />} />
              <Bar dataKey="revenue_sel" name="Revenue" fill={C.blue} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="revenue_sel" position="top" formatter={fmtAxisM} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Units by Brand + Weekly Velocity by Subcategory ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={`Units Sold by Brand (${periodTag})`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={brandUnits} margin={{ top: 16, right: 8, left: -5, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="brand" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" />
              <YAxis tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v} tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="units_sel" name="Units Sold" fill={C.blue} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="units_sel" position="top" formatter={fmtNum} style={{ fontSize: 9, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Weekly Velocity by Subcategory (from the retired Category tab) */}
        <ChartCard title="Weekly Velocity by Subcategory (Top 12)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={weeklyVelData} layout="vertical" margin={{ left: 8, right: 50, top: 4, bottom: 4 }}>
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={130} />
              <Tooltip formatter={(v) => [fmtNum(v) + " /wk", "Velocity"]} />
              <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                {weeklyVelData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                <LabelList dataKey="value" position="right" style={{ fontSize: 10 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Category Matrix bubble (from the retired Category tab) ── */}
      <div className="card-white p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <SectionTitle title="Category Matrix: Revenue vs SOR" subtitle="bubble size = stock" />
          <button
            onClick={handleCategoryDownload}
            data-testid="merch-category-csv"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] text-muted hover:text-foreground hover:border-foreground transition-colors bg-white"
          >
            <DownloadSimple size={13} /> Category CSV
          </button>
        </div>
        <div className="mt-3" style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="revenue_6m" name="Revenue" label={{ value: "Revenue (KES M, selected period)", position: "insideBottom", offset: -10, fontSize: 11 }} tick={{ fontSize: 11 }} />
              <YAxis dataKey="sor" name="SOR %" domain={[0, 100]} label={{ value: "SOR 6m %", angle: -90, position: "insideLeft", offset: 10, fontSize: 11 }} tick={{ fontSize: 11 }} />
              <ZAxis dataKey="z" range={[40, 600]} />
              <Tooltip content={<BubbleTooltip />} />
              <ReferenceLine y={60} stroke="#1a5c38" strokeDasharray="6 3" label={{ value: "SOR target 60%", position: "right", fontSize: 10, fill: "#1a5c38" }} />
              <Scatter data={bubbleData} shape={(props) => {
                const { cx, cy, payload } = props;
                const r = Math.max(5, Math.min(28, Math.sqrt(payload.z || 40)));
                return (
                  <g>
                    <circle cx={cx} cy={cy} r={r} fill={payload.fill} fillOpacity={0.75} stroke={payload.fill} strokeWidth={1.5} />
                    {r > 14 && (
                      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize={8} fill="#fff" fontWeight="bold">
                        {truncate(payload.subcategory, 8)}
                      </text>
                    )}
                  </g>
                );
              }} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center gap-4 mt-2 text-[11px] text-muted flex-wrap">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-[#1a5c38] inline-block" /> SOR ≥ 60%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-[#d97706] inline-block" /> SOR 40–60%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-[#ef4444] inline-block" /> SOR &lt; 40%</span>
        </div>
      </div>

      {/* ════ 2. PRICING & REALISATION ════ */}
      <SectionHeader
        title="Pricing & Realisation"
        subtitle={
          <>
            Pricing, markdown depth &amp; margin performance
            {s.avg_gross_margin_pct != null && (
              <span className="ml-2 text-emerald-700 font-medium">· Portfolio GM {fmtPct(s.avg_gross_margin_pct)}</span>
            )}
          </>
        }
      />

      {/* ── Tier prices + Avg Rev per Style + Price bands ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Avg Full Price (KES) vs Avg Selling Price (KES) by Tier */}
        <ChartCard title="Avg Full Price vs Sell Price by Tier (KES)">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={tierPrices} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="tier" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <Tooltip content={<PriceTooltip />} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="Avg Full Price" fill={C.blue} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Avg Sell Price" fill={C.teal} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Avg Revenue per Style by Tier */}
        <ChartCard title="Avg Revenue per Style by Tier (6m) — KES M per style">
          {tierAvgRevChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={tierAvgRevChart} margin={{ top: 28, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "M"}
                    label={{ value: "KES M per Style", angle: -90, position: "insideLeft", style: { fontSize: 9 } }} />
                  <Tooltip formatter={(v) => [fmtKES(v * 1e6), "Avg Revenue"]} />
                  <Bar dataKey="avgRev" name="Avg Revenue" radius={[3, 3, 0, 0]}>
                    {tierAvgRevChart.map((entry, i) => (
                      <Cell key={i} fill={TIER_COLORS[entry.name] || "#4b7bec"} />
                    ))}
                    <LabelList dataKey="label" position="top" style={{ fontSize: 9, fill: "#555" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </ChartCard>

        {/* Price Band Distribution donut — styles per full-price band in KES
            (distinct metric from the Full Price % Mix below) */}
        <ChartCard title="Price Band Distribution (KES)">
          {priceBandDonut.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={priceBandDonut}
                    cx="50%"
                    cy="45%"
                    innerRadius={55}
                    outerRadius={85}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {priceBandDonut.map((_, i) => (
                      <Cell key={i} fill={PRICE_DONUT_COLORS[i % PRICE_DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [v + " styles", name]} />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    wrapperStyle={{ fontSize: 10 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
        </ChartCard>
      </div>

      {/* ── Price Realisation by Brand + Lifetime vs 6m by Brand ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Price Realisation by Brand">
          {brandRealChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={brandRealChart} margin={{ top: 16, right: 40, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={v => v + "K"}
                    label={{ value: "Price KES (000s)", angle: -90, position: "insideLeft", style: { fontSize: 9 } }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }}
                    tickFormatter={v => v + "%"}
                    label={{ value: "Realisation %", angle: 90, position: "insideRight", style: { fontSize: 9 } }} />
                  <Tooltip
                    formatter={(v, name) => {
                      if (v == null) return ["—", name];
                      if (name === "Realisation %" || name === "Gross Margin %") return [fmtPct(v), name];
                      return ["KES " + (v * 1000).toLocaleString(), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
                  <Bar yAxisId="left" dataKey="fullPrice" name="Full Price (KES 000s)" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey="avgSelling" name="Avg Selling Price" fill="#4b7bec" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="realisation" name="Realisation %"
                    stroke="#d97706" strokeWidth={2} strokeDasharray="6 3" dot={{ r: 4 }} />
                  {/* Gross margin line — only rendered where cost data is available (null = no cost) */}
                  <Line yAxisId="right" type="monotone" dataKey="grossMargin" name="Gross Margin %"
                    stroke="#00b894" strokeWidth={2} strokeDasharray="3 3" dot={{ r: 3 }}
                    connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
        </ChartCard>

        <ChartCard title="Lifetime vs 6m Revenue by Brand (KES M)">
          {lifetimeVs6mChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={lifetimeVs6mChart} margin={{ top: 16, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "M"} />
                  <Tooltip formatter={(v, name) => [v + "M", name]} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="lifetime" name="Lifetime Revenue (KES M)" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="sixm" name="6m Revenue (KES M)" fill="#00c853" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
        </ChartCard>
      </div>

      {/* ── FP% by Subcategory (85% target) + FP% Mix ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* From the retired Category tab */}
        <ChartCard title="Avg Full Price % by Subcategory vs 85% Target">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={fpBySubcat} layout="vertical" margin={{ left: 8, right: 50, top: 4, bottom: 4 }}>
              <XAxis type="number" domain={[70, 100]} tick={{ fontSize: 10 }} unit="%" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={130} />
              <Tooltip formatter={(v) => [fmtDec(v, 1) + "%", "Full Price %"]} />
              <ReferenceLine x={85} stroke="#1a5c38" strokeDasharray="5 3" label={{ value: "Target 85%", position: "top", fontSize: 10, fill: "#1a5c38" }} />
              <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                {fpBySubcat.map((d, i) => <Cell key={i} fill={d.fill} />)}
                <LabelList dataKey="value" position="right" formatter={(v) => fmtDec(v, 1) + "%"} style={{ fontSize: 10 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Full Price % Mix">
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={fpMixData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={45} paddingAngle={2}>
                {fpMixData.map((_, i) => <Cell key={i} fill={FP_MIX_COLORS[i % FP_MIX_COLORS.length]} />)}
              </Pie>
              <Tooltip
                formatter={(val, name) => [`${fmtNum(val)} styles`, name]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }}
              />
              <Legend formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} iconSize={8} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ════ 3. SELL-THROUGH ════ */}
      <SectionHeader
        title="Sell-Through"
        subtitle="Sell-through rates &amp; sell-out performance"
      />

      {/* ── Sell-through KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MerchKPICard
          label="Avg Lifetime SOR"
          value={fmtPct1(avgLifetimeSOR)}
          sub="Based on stock on hand + life sales"
          accentColor={C.blue}
          testId="merch-st-kpi-sor-life"
        />
        <MerchKPICard
          label="Avg SOR (6m)"
          value={fmtPct1(s.avg_sor_6m)}
          sub="6-month period"
          accentColor={C.teal}
          testId="merch-st-kpi-sor-6m"
        />
        <MerchKPICard
          label="Styles SOR > 90%"
          value={fmtNum(stylesHiSOR)}
          sub="High performers"
          accentColor={C.green}
          testId="merch-st-kpi-hi-sor"
        />
        <MerchKPICard
          label="Styles SOR < 40%"
          value={fmtNum(stylesLoSOR)}
          sub="Needs attention"
          accentColor={C.red}
          testId="merch-st-kpi-lo-sor"
        />
      </div>

      {/* ── Row 1: SOR by Subcat + Scatter ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="SOR (6m) by Subcategory vs 60% Target">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={subcatSOR}
              layout="vertical"
              margin={{ top: 0, right: 55, left: 110, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
              <YAxis
                type="category"
                dataKey="subcategory"
                tick={{ fontSize: 9 }}
                width={110}
                tickFormatter={(v) => v?.length > 18 ? v.slice(0, 18) + "…" : v}
              />
              <ReferenceLine
                x={60}
                stroke="#94a3b8"
                strokeDasharray="4 3"
                label={{ value: "60% target", position: "insideTopRight", fontSize: 9, fill: "#94a3b8" }}
              />
              <Tooltip content={<SorTooltip />} />
              <Bar dataKey="avg_sor_6m" name="SOR 6m" radius={[0, 3, 3, 0]}>
                {subcatSOR.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList dataKey="avg_sor_6m" position="right" formatter={fmtPct1} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Lifetime SOR % vs 6m SOR % (per style)">
          <div className="flex gap-4 mb-2">
            {Object.values(scatterBands).map((b, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ backgroundColor: b.color }} />
                <span className="text-[9px] text-slate-500">{b.name}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={265}>
            <ScatterChart margin={{ top: 10, right: 10, left: -10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis type="number" dataKey="x" name="SOR 6m" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} label={{ value: "SOR 6m %", position: "insideBottom", offset: -5, fontSize: 10 }} />
              <YAxis type="number" dataKey="y" name="SOR Life" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} label={{ value: "SOR Lifetime %", angle: -90, position: "insideLeft", fontSize: 10 }} />
              <ZAxis range={[20, 20]} />
              <Tooltip content={<ScatterTip />} cursor={{ strokeDasharray: "3 3" }} />
              {Object.values(scatterBands).map((band, i) => (
                <Scatter key={i} name={band.name} data={band.data} fill={band.color} opacity={0.65} />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Row 2: Brand FP/SOR + SOR dist + Tier FP/SOR ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <ChartCard title="Full Price % vs SOR by Brand">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={brandFPSOR} margin={{ top: 10, right: 10, left: -5, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="brand" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip content={<SorTooltip />} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="avg_full_price_pct" name="Full Price %" fill={C.blue}   radius={[3, 3, 0, 0]} />
              <Bar dataKey="avg_sor_6m"         name="SOR 6m %"    fill={C.teal}   radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="SOR Distribution (6m)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={sorDist} margin={{ top: 16, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="value" name="Styles" radius={[4, 4, 0, 0]}>
                {sorDist.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList dataKey="value" position="top" style={{ fontSize: 11, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Full Price % vs SOR by Tier">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tierRows} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="tier" tick={{ fontSize: 10 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip content={<SorTooltip />} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="avg_full_price_pct" name="Full Price %" fill={C.blue}   radius={[3, 3, 0, 0]} />
              <Bar dataKey="avg_sor_6m"         name="SOR 6m %"    fill={C.teal}   radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
