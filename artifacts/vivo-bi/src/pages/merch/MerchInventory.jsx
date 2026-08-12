/**
 * Inventory & Stock Health tab — Merchandising Hub
 * 5 KPI cards + 5 charts
 *
 * API contracts:
 *   summary  → { total_styles, total_stock_units, avg_woc, woc_gt20_count,
 *                zero_stock_count, no_sale_30d_count, ... }
 *   styles   → { styles: [...] }   each row: current_stock, woc,
 *               last_sale_days, full_price_pct, subcategory, brand, tier
 *   by-brand → { rows: [{ brand, current_stock, avg_woc }] }
 *   by-subcategory → { rows: [{ subcategory, avg_woc }] }
 *   by-tier  → { rows: [{ tier, current_stock }] }
 */
import React, { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Cell, PieChart, Pie, Legend, LabelList,
  ReferenceLine,
} from "recharts";
import { Loading, ErrorBox } from "@/components/common";
import {
  useMerchData, MerchKPICard, ChartCard, SubcatFilter,
  C, fmtNum, fmtWoc, fmtPct1, wocColor,
} from "./MerchHelpers";
import MerchStockMix from "./MerchStockMix";

const NumTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1 max-w-[200px] break-words">{label}</div>
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

const WocTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtWoc(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const TIER_COLORS = [C.blue, C.teal, C.purple, C.amber];
const RECENCY_COLORS = [C.green, "#60a5fa", C.amber, C.red, "#94a3b8"];

export default function MerchInventory() {
  const [localSubcat, setLocalSubcat] = useState(null);
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"], localSubcat);
  // Fetched separately so the (heavier) drill-down tree never blocks the KPI
  // band + charts; the section renders its own skeleton / error state.
  const mixState = useMerchData(["stock-mix"], localSubcat);

  // styles → { styles: [...] }
  const styleRows = useMemo(() => styles?.styles || [], [styles]);

  // Top 10 styles by current_stock, colour-coded by WOC risk
  const top10Stock = useMemo(() =>
    [...styleRows]
      .sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))
      .slice(0, 10)
      .map((r) => ({
        ...r,
        _wocColor:  wocColor(r.woc),
        stockLabel: `${fmtNum(r.current_stock)} (${r.woc != null ? Number(r.woc).toFixed(0) + "w" : "—"})`,
      })),
    [styleRows]);

  // Avg WOC by Subcategory (highest risk = highest WOC, sorted desc)
  const subcatWoc = useMemo(() => {
    if (!bySubcategory?.rows) return [];
    return [...bySubcategory.rows]
      .filter((r) => r.avg_woc != null)
      .sort((a, b) => (b.avg_woc || 0) - (a.avg_woc || 0))
      .slice(0, 10)
      .map((r) => ({ ...r, color: wocColor(r.avg_woc) }));
  }, [bySubcategory]);

  // Current stock by brand
  const brandStock = useMemo(() => {
    if (!byBrand?.rows) return [];
    return [...byBrand.rows].sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0));
  }, [byBrand]);

  // Styles by last sale recency — computed from styleRows using last_sale_days
  const recencyData = useMemo(() => {
    const buckets = { "7d": 0, "8_30d": 0, "31_60d": 0, "61_90d": 0, "gt_90d": 0 };
    for (const r of styleRows) {
      const d = r.last_sale_days;
      if (d === null || d === undefined) { buckets["gt_90d"]++; continue; }
      if (d <= 7)       buckets["7d"]++;
      else if (d <= 30) buckets["8_30d"]++;
      else if (d <= 60) buckets["31_60d"]++;
      else if (d <= 90) buckets["61_90d"]++;
      else              buckets["gt_90d"]++;
    }
    return [
      { name: "Sold in\nlast 7d",  value: buckets["7d"],     color: RECENCY_COLORS[0] },
      { name: "Sold 8-30d\nago",   value: buckets["8_30d"],  color: RECENCY_COLORS[1] },
      { name: "Sold 31-60d\nago",  value: buckets["31_60d"], color: RECENCY_COLORS[2] },
      { name: "Sold 61-90d\nago",  value: buckets["61_90d"], color: RECENCY_COLORS[3] },
      { name: "No sale\n>90d",     value: buckets["gt_90d"], color: RECENCY_COLORS[4] },
    ];
  }, [styleRows]);

  // Stock by Tier pie — from by-tier rows
  const tierStockPie = useMemo(() => {
    if (!byTier?.rows) return [];
    return byTier.rows.map((r, i) => ({
      name:  r.tier,
      value: r.current_stock || 0,
      color: TIER_COLORS[i] || C.muted,
    }));
  }, [byTier]);

  const wocLegend = [
    { label: "WOC < 8 wks",  color: C.green },
    { label: "WOC 8-16 wks", color: C.amber },
    { label: "WOC > 16 wks", color: C.teal },
  ];

  if (loading) return <Loading label="Loading Inventory & Stock Health…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};
  const total = s.total_styles || 0;
  const overstockPct = total ? ((s.woc_gt20_count  || 0) / total * 100).toFixed(1) : "0";
  const noSalePct    = total ? ((s.no_sale_30d_count || 0) / total * 100).toFixed(1) : "0";

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[11px] text-slate-400">
          Stock Levels, Weeks of Cover &amp; Risk Flags
        </div>
        <SubcatFilter value={localSubcat} onChange={setLocalSubcat} />
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <MerchKPICard
          label="Total Stock Units"
          value={fmtNum(s.total_stock_units)}
          sub={`Across ${fmtNum(s.total_styles)} styles`}
          accentColor={C.blue}
          testId="merch-inv-kpi-stock"
        />
        <MerchKPICard
          label="Avg WOC"
          value={fmtWoc(s.avg_woc)}
          sub="Across active styles"
          accentColor={C.purple}
          testId="merch-inv-kpi-woc"
        />
        <MerchKPICard
          label="Styles WOC > 20"
          value={`${fmtNum(s.woc_gt20_count)} styles`}
          sub={`${overstockPct}% of portfolio`}
          accentColor={C.teal}
          testId="merch-inv-kpi-overstock"
        />
        <MerchKPICard
          label="Zero Stock Styles"
          value={fmtNum(s.zero_stock_count)}
          sub="All styles vs stock"
          accentColor={C.red}
          testId="merch-inv-kpi-zero"
        />
        <MerchKPICard
          label="Styles No Sale 30d"
          value={`${fmtNum(s.no_sale_30d_count)} styles`}
          sub={`${noSalePct}% of portfolio`}
          accentColor={C.amber}
          testId="merch-inv-kpi-nosale"
        />
      </div>

      {/* ── Stock Mix drill-down (Category → Sub Category → Style → Colour) ── */}
      <MerchStockMix
        data={mixState.stockMix}
        loading={mixState.loading}
        error={mixState.error}
      />

      {/* ── Top 10 stock + Avg WOC by Subcat ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Top 10 Styles by Current Stock (colour = WOC risk)">
          <div className="flex gap-3 mb-2">
            {wocLegend.map((l, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
                <span className="text-[9px] text-slate-500">{l.label}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={top10Stock}
              layout="vertical"
              margin={{ top: 0, right: 70, left: 130, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtNum} tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="style_name"
                tick={{ fontSize: 9 }}
                width={130}
                tickFormatter={(v) => v?.length > 24 ? v.slice(0, 24) + "…" : v}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const r = payload[0]?.payload;
                  return (
                    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
                      <div className="font-semibold text-slate-700 mb-1">{label}</div>
                      <div>Stock: <strong>{fmtNum(r?.current_stock)}</strong></div>
                      <div>WOC: <strong>{fmtWoc(r?.woc)}</strong></div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="current_stock" name="Current Stock" radius={[0, 3, 3, 0]}>
                {top10Stock.map((entry, i) => <Cell key={i} fill={entry._wocColor} />)}
                <LabelList
                  dataKey="stockLabel"
                  position="right"
                  style={{ fontSize: 9, fill: "#64748b" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Avg WOC by Subcategory (highest risk)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={subcatWoc}
              layout="vertical"
              margin={{ top: 0, right: 50, left: 100, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="subcategory"
                tick={{ fontSize: 9 }}
                width={100}
                tickFormatter={(v) => v?.length > 18 ? v.slice(0, 18) + "…" : v}
              />
              <ReferenceLine
                x={12}
                stroke="#94a3b8"
                strokeDasharray="4 3"
                label={{ value: "Target 12 wks", position: "insideTopRight", fontSize: 9, fill: "#94a3b8" }}
              />
              <Tooltip content={<WocTooltip />} />
              <Bar dataKey="avg_woc" name="Avg WOC" radius={[0, 3, 3, 0]}>
                {subcatWoc.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList
                  dataKey="avg_woc"
                  position="right"
                  formatter={(v) => `${Number(v).toFixed(0)}w`}
                  style={{ fontSize: 9, fill: "#64748b" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Brand stock + Recency + Tier pie ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <ChartCard title="Current Stock by Brand">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={brandStock} margin={{ top: 16, right: 8, left: -5, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="brand" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" />
              <YAxis tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v} tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="current_stock" name="Stock Units" fill={C.blue} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="current_stock" position="top" formatter={fmtNum} style={{ fontSize: 9, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Styles by Last Sale Recency">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={recencyData} margin={{ top: 16, right: 8, left: -10, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="value" name="Styles" radius={[4, 4, 0, 0]}>
                {recencyData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList dataKey="value" position="top" style={{ fontSize: 11, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stock by Tier">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={tierStockPie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={75}
                innerRadius={35}
                paddingAngle={2}
              >
                {tierStockPie.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip
                formatter={(val, name) => [`${fmtNum(val)} units`, name]}
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
