/**
 * Sales Performance tab — Merchandising Hub
 * 5 KPI cards + 5 charts
 *
 * API contracts:
 *   summary  → { total_styles, units_6m, revenue_6m, weekly_velocity,
 *                avg_full_price_pct, avg_sor_6m, woc_gt20_count, ... }
 *   styles   → { styles: [...] }   each row has: style_name, units_6m,
 *               revenue_6m, full_price_pct, avg_selling_price, woc, sor_6m
 *   by-brand → { rows: [{ brand, units_6m, revenue_6m, avg_full_price_pct }] }
 *   by-subcategory → { rows: [{ subcategory, revenue_6m, units_6m }] }
 *   by-tier  → { rows: [{ tier, revenue_6m, units_6m, avg_full_price_pct }] }
 */
import React, { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Cell, PieChart, Pie, Legend, LabelList,
} from "recharts";
import { Loading, ErrorBox } from "@/components/common";
import {
  useMerchData, MerchKPICard, ChartCard,
  C, fmtKESM, fmtPct1, fmtNum, fmtAxisM,
} from "./MerchHelpers";

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

const PctTooltip = ({ active, payload, label }) => {
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

const FP_MIX_COLORS = [C.red, C.amber, C.blue, C.green];

export default function MerchSales() {
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"]);

  // styles → { styles: [...] }
  const styleRows = useMemo(() => styles?.styles || [], [styles]);

  // Top 10 styles by revenue_6m
  const top10Styles = useMemo(() =>
    [...styleRows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0)).slice(0, 10),
    [styleRows]);

  // Revenue by Subcategory
  const subcatRevenue = useMemo(() => {
    if (!bySubcategory?.rows) return [];
    return [...bySubcategory.rows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0)).slice(0, 10);
  }, [bySubcategory]);

  // Units by Brand
  const brandUnits = useMemo(() => {
    if (!byBrand?.rows) return [];
    return [...byBrand.rows].sort((a, b) => (b.units_6m || 0) - (a.units_6m || 0));
  }, [byBrand]);

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
  const tierPrices = useMemo(() => {
    if (!byTier?.rows) return [];
    return byTier.rows.map((r) => {
      const fpMap   = tierFullPriceMap[r.tier] || {};
      const avgFP   = fpMap.sumUnits > 0 ? Math.round(fpMap.sumWt / fpMap.sumUnits) : null;
      const avgSell = r.units_6m > 0 ? Math.round((r.revenue_6m || 0) / r.units_6m) : null;
      return {
        tier:             r.tier,
        "Avg Full Price": avgFP   ?? 0,
        "Avg Sell Price": avgSell ?? 0,
      };
    });
  }, [byTier, tierFullPriceMap]);

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

  // Summary-derived KPI extras
  const avgUnitsPerStyle = useMemo(() =>
    (summary?.total_styles && summary?.units_6m)
      ? Math.round(summary.units_6m / summary.total_styles)
      : 0,
    [summary]);

  // Styles with >95% FP — count from styleRows
  const stylesHiFp = useMemo(() => styleRows.filter((r) => (r.full_price_pct || 0) >= 95).length, [styleRows]);

  // Average unit (selling) price — weighted by units sold
  const avgUnitPrice = useMemo(() => {
    const totalRev   = styleRows.reduce((s, r) => s + (r.revenue_6m || 0), 0);
    const totalUnits = styleRows.reduce((s, r) => s + (r.units_6m   || 0), 0);
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

  if (loading) return <Loading label="Loading Sales Performance…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};

  return (
    <div className="space-y-5 pb-8">
      <div className="text-[11px] text-slate-400">
        Revenue &amp; Units Analysis · 6-Month View · All Brands · All Subcategories
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <MerchKPICard
          label="Revenue (6m)"
          value={fmtKESM(s.revenue_6m)}
          sub="Avg per Style"
          sub2={s.total_styles ? fmtKESM(s.revenue_6m / s.total_styles) : "—"}
          accentColor={C.blue}
          testId="merch-sales-kpi-revenue"
        />
        <MerchKPICard
          label="Units Sold (6m)"
          value={fmtNum(s.units_6m)}
          sub="Avg per Style"
          sub2={`${fmtNum(avgUnitsPerStyle)} units`}
          accentColor={C.teal}
          testId="merch-sales-kpi-units"
        />
        <MerchKPICard
          label="Avg Unit Price"
          value={fmtKESM(avgUnitPrice)}
          sub="Avg Full Price (KES)"
          sub2={fmtKESM(avgFullPriceKES)}
          accentColor={C.purple}
          testId="merch-sales-kpi-aup"
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
        <ChartCard title="Top 10 Revenue Generating Styles (6m)">
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
              <Bar dataKey="revenue_6m" name="Revenue 6m" fill={C.teal} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_6m" position="right" formatter={fmtKESM} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Revenue by Subcategory (6m)">
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
              <Bar dataKey="revenue_6m" name="Revenue 6m" fill={C.blue} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="revenue_6m" position="top" formatter={fmtAxisM} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Units by Brand + Tier prices + FP mix ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <ChartCard title="Units Sold by Brand (6m)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={brandUnits} margin={{ top: 16, right: 8, left: -5, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="brand" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" />
              <YAxis tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v} tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="units_6m" name="Units Sold" fill={C.blue} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="units_6m" position="top" formatter={fmtNum} style={{ fontSize: 9, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Avg Full Price (KES) vs Avg Selling Price (KES) by Tier */}
        <ChartCard title="Avg Full Price vs Sell Price by Tier (KES)">
          <ResponsiveContainer width="100%" height={210}>
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

        <ChartCard title="Full Price % Mix">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={fpMixData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} innerRadius={35} paddingAngle={2}>
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
    </div>
  );
}
