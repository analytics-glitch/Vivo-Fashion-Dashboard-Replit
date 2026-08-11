/**
 * Sell-Through & Markdown Analysis tab — Merchandising Hub
 * 5 KPI cards + 5 charts
 *
 * API contracts:
 *   summary  → { avg_sor_6m, avg_full_price_pct, total_styles, ... }
 *   styles   → { styles: [...] }   each row: sor_6m, full_price_pct,
 *               units_life, revenue_life, current_stock, style_name, brand, tier
 *   by-brand → { rows: [{ brand, avg_sor_6m, avg_full_price_pct }] }
 *   by-subcategory → { rows: [{ subcategory, avg_sor_6m }] }
 *   by-tier  → { rows: [{ tier, avg_sor_6m, avg_full_price_pct }] }
 *
 * NOTE: There is no "lifetime SOR" field on the aggregate endpoints.
 * We derive it per-style from units_life / (units_life + current_stock).
 */
import React, { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Cell, LabelList, ReferenceLine, ScatterChart, Scatter, ZAxis,
  Legend,
} from "recharts";
import { Loading, ErrorBox } from "@/components/common";
import {
  useMerchData, MerchKPICard, ChartCard,
  C, fmtPct1, fmtNum, sorColor,
} from "./MerchHelpers";

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

// Scatter dot tooltip
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

// SOR band colour for scatter/bars (green / amber / red)
const bandColorByValue = (val) => {
  if (val == null) return C.muted;
  if (val >= 60)   return C.green;
  if (val >= 40)   return C.amber;
  return C.red;
};

const SOR_DIST_COLORS = [C.red, C.amber, C.green, "#22d3ee"];

export default function MerchSellThrough() {
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"]);

  // styles → { styles: [...] }
  const styleRows = useMemo(() => styles?.styles || [], [styles]);

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
  const subcatSOR = useMemo(() => {
    if (!bySubcategory?.rows) return [];
    return [...bySubcategory.rows]
      .filter((r) => r.avg_sor_6m != null)
      .sort((a, b) => (a.avg_sor_6m || 0) - (b.avg_sor_6m || 0))
      .slice(0, 10)
      .map((r) => ({ ...r, color: bandColorByValue(r.avg_sor_6m) }));
  }, [bySubcategory]);

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
  const brandFPSOR = useMemo(() => {
    if (!byBrand?.rows) return [];
    return [...byBrand.rows].sort((a, b) => (b.avg_sor_6m || 0) - (a.avg_sor_6m || 0));
  }, [byBrand]);

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

  // FP% vs SOR by Tier
  const tierFPSOR = useMemo(() => {
    if (!byTier?.rows) return [];
    return byTier.rows;
  }, [byTier]);

  if (loading) return <Loading label="Loading Sell-Through & Markdown…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};

  return (
    <div className="space-y-5 pb-8">
      <div className="text-[11px] text-slate-400">
        Sell-Through Rates, Markdown Depth &amp; Price Management
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
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
          label="Avg Full Price %"
          value={fmtPct1(s.avg_full_price_pct)}
          sub="Units sold at full price"
          accentColor={C.purple}
          testId="merch-st-kpi-fp"
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
            <BarChart data={tierFPSOR} margin={{ top: 10, right: 10, left: -5, bottom: 0 }}>
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
