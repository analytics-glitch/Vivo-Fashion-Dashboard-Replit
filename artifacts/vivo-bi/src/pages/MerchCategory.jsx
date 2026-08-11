/**
 * MerchCategory — Category Performance tab
 * ?tab=merch-category
 *
 * Data: /api/merch/by-subcategory (aggregates) + /api/merch/summary (totals)
 * Charts: Bubble/Scatter, Active Styles bar, Weekly Velocity bar,
 *         Avg Full Price % bar with 85% target, Revenue Share donut
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, PieChart, Pie, Cell, ScatterChart, Scatter, ZAxis, Legend,
  LabelList,
} from "recharts";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import { apiFetch, fmtKES, fmtNum, fmtDec } from "@/lib/api";
import { useMerchFilters } from "./MerchandisingHub";

// ── Colour helpers ────────────────────────────────────────────────────────────
const SOR_COLOR = (sor) => {
  if (sor === null || sor === undefined) return "#94a3b8";
  if (sor >= 60) return "#1a5c38";
  if (sor >= 40) return "#d97706";
  return "#ef4444";
};

const SUBCAT_COLORS = [
  "#1a5c38", "#00c853", "#d97706", "#4b7bec", "#7c3aed",
  "#0891b2", "#be185d", "#065f46", "#9f1239", "#1e40af",
];

const DONUT_COLORS = ["#1a5c38", "#00c853", "#d97706", "#94a3b8"];

// Truncate long subcategory names for chart labels
const truncate = (s, n = 20) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

const CustomScatterTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg p-3 text-[12px] min-w-[160px]">
      <p className="font-bold text-foreground mb-1">{d.subcategory}</p>
      <p className="text-muted">Revenue 6m: <span className="text-foreground font-medium">{fmtKES(d.revenue_6m_raw)}</span></p>
      <p className="text-muted">SOR: <span className="text-foreground font-medium">{d.sor !== null ? fmtDec(d.sor, 1) + "%" : "—"}</span></p>
      <p className="text-muted">Stock: <span className="text-foreground font-medium">{fmtNum(d.current_stock)}</span></p>
      <p className="text-muted">Styles: <span className="text-foreground font-medium">{d.style_count}</span></p>
    </div>
  );
};

const MerchCategory = () => {
  const filters = useMerchFilters();
  const [subRows, setSubRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { country: filters.country, from_date: filters.from_date, to_date: filters.to_date };
    Promise.all([
      apiFetch("/merch/by-subcategory", { params }),
      apiFetch("/merch/summary", { params }),
    ])
      .then(([subData, sumData]) => {
        if (cancelled) return;
        setSubRows(subData.rows || []);
        setSummary(sumData);
      })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.from_date, filters.to_date, filters.dataVersion]);

  // ── KPI derivations ──────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    if (!subRows.length) return null;
    const byRev    = [...subRows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0));
    const bySor    = [...subRows].filter(r => r.avg_sor_6m !== null).sort((a, b) => b.avg_sor_6m - a.avg_sor_6m);
    const byStyles = [...subRows].sort((a, b) => (b.style_count || 0) - (a.style_count || 0));
    const byPrice  = [...subRows].filter(r => r.avg_full_price_pct !== null).sort((a, b) => b.avg_full_price_pct - a.avg_full_price_pct);
    const byVel    = [...subRows].sort((a, b) => (b.units_6m || 0) - (a.units_6m || 0));
    return {
      topByRevenue:  byRev[0],
      topBySor:      bySor[0],
      mostStyles:    byStyles[0],
      highestPrice:  byPrice[0],
      highestVel:    byVel[0],
    };
  }, [subRows]);

  // ── Chart data ────────────────────────────────────────────────────────────
  const bubbleData = useMemo(() =>
    subRows.map(r => ({
      subcategory:    r.subcategory,
      revenue_6m:     Math.round((r.revenue_6m || 0) / 1_000_000),   // KES M (axis only)
      revenue_6m_raw: r.revenue_6m || 0,                              // raw KES for tooltip
      sor:            r.avg_sor_6m,
      current_stock:  r.current_stock || 0,
      style_count:    r.style_count || 0,
      z:              Math.max(20, Math.min(800, (r.current_stock || 0) / 3)),
      fill:           SOR_COLOR(r.avg_sor_6m),
    })), [subRows]);

  const activeStylesData = useMemo(() =>
    [...subRows].sort((a, b) => (b.style_count || 0) - (a.style_count || 0))
      .slice(0, 15)
      .map((r, i) => ({ name: truncate(r.subcategory, 22), value: r.style_count || 0, fill: SUBCAT_COLORS[i % SUBCAT_COLORS.length] })),
    [subRows]);

  const weeklyVelData = useMemo(() => {
    const weekly = subRows.map(r => ({ ...r, weekly_vel: Math.round((r.units_6m || 0) / 26) }));
    return [...weekly].sort((a, b) => (b.weekly_vel || 0) - (a.weekly_vel || 0))
      .slice(0, 12)
      .map((r, i) => ({ name: truncate(r.subcategory, 22), value: r.weekly_vel, fill: SUBCAT_COLORS[i % SUBCAT_COLORS.length] }));
  }, [subRows]);

  const fpData = useMemo(() =>
    [...subRows].filter(r => r.avg_full_price_pct !== null)
      .sort((a, b) => (b.avg_full_price_pct || 0) - (a.avg_full_price_pct || 0))
      .slice(0, 12)
      .map((r, i) => ({
        name:  truncate(r.subcategory, 22),
        value: r.avg_full_price_pct,
        fill:  (r.avg_full_price_pct || 0) >= 85 ? "#1a5c38" : "#d97706",
      })),
    [subRows]);

  const donutData = useMemo(() => {
    if (!subRows.length) return [];
    const sorted = [...subRows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0));
    const top4   = sorted.slice(0, 4);
    const rest   = sorted.slice(4);
    const restRev = rest.reduce((acc, r) => acc + (r.revenue_6m || 0), 0);
    const total  = subRows.reduce((acc, r) => acc + (r.revenue_6m || 0), 0);
    const pct = (v) => total > 0 ? Math.round(v * 100 / total) : 0;
    const out = top4.map(r => ({ name: truncate(r.subcategory, 16), value: pct(r.revenue_6m || 0) }));
    if (restRev > 0) out.push({ name: "Other", value: pct(restRev) });
    return out;
  }, [subRows]);

  if (loading) return <Loading label="Loading category data…" />;
  if (error)   return <ErrorBox message={error} />;

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div>
        <h2 className="text-[22px] font-bold text-foreground">Category Performance</h2>
        <p className="text-[13px] text-muted mt-0.5">Subcategory Revenue, Velocity & Sell-Through · As at {today}</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          label="Top Category"
          value={kpis?.topByRevenue?.subcategory || "—"}
          sub={kpis?.topByRevenue ? `${fmtKES(kpis.topByRevenue.revenue_6m)} (6m)` : undefined}
          showDelta={false}
          accent
        />
        <KPICard
          label="Fastest Growing"
          value={kpis?.topBySor?.subcategory || "—"}
          sub={kpis?.topBySor ? `${fmtDec(kpis.topBySor.avg_sor_6m, 1)}% SOR` : undefined}
          showDelta={false}
        />
        <KPICard
          label="Most Styles"
          value={kpis?.mostStyles?.subcategory || "—"}
          sub={kpis?.mostStyles ? `${fmtNum(kpis.mostStyles.style_count)} active styles` : undefined}
          showDelta={false}
        />
        <KPICard
          label="Highest Avg Price"
          value={kpis?.highestPrice?.subcategory || "—"}
          sub={kpis?.highestPrice ? `${fmtDec(kpis.highestPrice.avg_full_price_pct, 1)}% FP rate` : undefined}
          showDelta={false}
        />
        <KPICard
          label="Highest Velocity"
          value={kpis?.highestVel?.subcategory || "—"}
          sub={kpis?.highestVel ? `${fmtNum(Math.round((kpis.highestVel.units_6m || 0) / 26))} units/wk` : undefined}
          showDelta={false}
        />
      </div>

      {/* Top row: Bubble chart + Active styles bar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Bubble / Scatter */}
        <div className="card-white p-5">
          <SectionTitle title="Category Matrix: Revenue vs SOR" subtitle="bubble size = stock" />
          <div className="mt-3" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="revenue_6m" name="Revenue 6m" label={{ value: "Revenue 6m (KES M)", position: "insideBottom", offset: -10, fontSize: 11 }} tick={{ fontSize: 11 }} />
                <YAxis dataKey="sor" name="SOR %" domain={[0, 100]} label={{ value: "SOR 6m %", angle: -90, position: "insideLeft", offset: 10, fontSize: 11 }} tick={{ fontSize: 11 }} />
                <ZAxis dataKey="z" range={[40, 600]} />
                <Tooltip content={<CustomScatterTooltip />} />
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

        {/* Active Styles by Subcategory */}
        <div className="card-white p-5">
          <SectionTitle title="Active Styles by Subcategory" subtitle="Number of Active Styles" />
          <div className="mt-3" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={activeStylesData} layout="vertical" margin={{ left: 8, right: 40, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={130} />
                <Tooltip formatter={(v) => [fmtNum(v), "Styles"]} />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {activeStylesData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="value" position="right" style={{ fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom row: Velocity bar, FP% bar, Revenue donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Weekly Velocity */}
        <div className="card-white p-5">
          <SectionTitle title="Weekly Velocity by Subcategory" subtitle="Total Weekly Units Sold" />
          <div className="mt-3" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
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
          </div>
        </div>

        {/* Avg Full Price % */}
        <div className="card-white p-5">
          <SectionTitle title="Avg Full Price % by Subcategory" subtitle="Avg Full Price %" />
          <div className="mt-3" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fpData} layout="vertical" margin={{ left: 8, right: 50, top: 4, bottom: 4 }}>
                <XAxis type="number" domain={[70, 100]} tick={{ fontSize: 10 }} unit="%" />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={130} />
                <Tooltip formatter={(v) => [fmtDec(v, 1) + "%", "Full Price %"]} />
                <ReferenceLine x={85} stroke="#1a5c38" strokeDasharray="5 3" label={{ value: "Target 85%", position: "top", fontSize: 10, fill: "#1a5c38" }} />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {fpData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="value" position="right" formatter={(v) => fmtDec(v, 1) + "%"} style={{ fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Revenue Share donut */}
        <div className="card-white p-5 flex flex-col">
          <SectionTitle title="Revenue Share" subtitle="Top 4 vs Other" />
          <div className="flex-1 mt-3 flex items-center justify-center" style={{ minHeight: 260 }}>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={donutData}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={100}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ name, value }) => `${value}%`}
                  labelLine={false}
                >
                  {donutData.map((d, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n, p) => [`${v}%`, p.payload.name]} />
                <Legend iconSize={10} formatter={(v) => <span style={{ fontSize: 11 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MerchCategory;
