/**
 * MerchLifecycle — Style Lifecycle & Age Analysis tab
 * ?tab=merch-lifecycle
 *
 * Data: /api/merch/styles (full list), /api/merch/by-tier
 * Charts: Launched by Year bar, Age Distribution bar,
 *         Reorder Count Distribution donut, Avg Reorder by Tier bar,
 *         Age vs Lifetime SOR scatter, Tier 1 Top Performers table
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ScatterChart, Scatter, ZAxis, LabelList,
} from "recharts";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import { apiFetch, fmtNum, fmtDec } from "@/lib/api";
import { useMerchFilters } from "./MerchandisingHub";

// ── Colours ───────────────────────────────────────────────────────────────────
const ERA_COLOR = (year) => {
  if (year <= 2021) return "#7c3aed";
  if (year <= 2023) return "#0891b2";
  if (year <= 2025) return "#4b7bec";
  return "#1a5c38";
};
const AGE_COLORS = ["#1a5c38", "#00c853", "#d97706", "#7c3aed", "#94a3b8"];
const REORDER_COLORS = ["#94a3b8", "#1a5c38", "#00c853", "#d97706", "#ef4444"];
const TIER_COLORS = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3": "#0891b2", "Tier 4": "#d97706", "Retired": "#94a3b8" };

const REORDER_BUCKETS = [
  { label: "0×",    test: (r) => r === 0 },
  { label: "1–5×",  test: (r) => r >= 1 && r <= 5 },
  { label: "6–10×", test: (r) => r >= 6 && r <= 10 },
  { label: "11–20×",test: (r) => r >= 11 && r <= 20 },
  { label: "21+×",  test: (r) => r >= 21 },
];

const AGE_BUCKETS = [
  { label: "0–26 wks",   min: 0,   max: 26 },
  { label: "27–52 wks",  min: 27,  max: 52 },
  { label: "53–104 wks", min: 53,  max: 104 },
  { label: "105–208 wks",min: 105, max: 208 },
  { label: "209+ wks",   min: 209, max: Infinity },
];

const ageWeeks = (launchDate) => {
  if (!launchDate) return null;
  try {
    const days = (Date.now() - new Date(launchDate).getTime()) / 86_400_000;
    return Math.max(0, Math.round(days / 7));
  } catch { return null; }
};

const MerchLifecycle = () => {
  const filters = useMerchFilters();
  const [styles, setStyles] = useState([]);
  const [tierRows, setTierRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("reorder_count");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { country: filters.country, from_date: filters.from_date, to_date: filters.to_date };
    Promise.all([
      apiFetch("/merch/styles", { params }),
      apiFetch("/merch/by-tier", { params }),
    ])
      .then(([sData, tData]) => {
        if (cancelled) return;
        setStyles(sData.styles || []);
        setTierRows(tData.rows || []);
      })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.from_date, filters.to_date, filters.dataVersion]);

  // ── Derived metrics ───────────────────────────────────────────────────────
  const enriched = useMemo(() =>
    styles.map(s => ({ ...s, age_wks: ageWeeks(s.launch_date) })),
    [styles]);

  const kpis = useMemo(() => {
    const withAge  = enriched.filter(s => s.age_wks !== null);
    const avgAge   = withAge.length ? Math.round(withAge.reduce((a, s) => a + s.age_wks, 0) / withAge.length) : null;
    const curYear  = new Date().getFullYear();
    const newest   = enriched.filter(s => s.launch_date && parseInt(s.launch_date.slice(0, 4)) === curYear).length;
    const oldest   = enriched.filter(s => s.launch_date && parseInt(s.launch_date.slice(0, 4)) <= 2019).length;
    const reorders = enriched.map(s => s.reorder_count || 0);
    const avgReo   = reorders.length ? reorders.reduce((a, b) => a + b, 0) / reorders.length : 0;
    const maxReo   = reorders.length ? Math.max(...reorders) : 0;
    return { avgAge, newest, oldest, avgReo, maxReo };
  }, [enriched]);

  // Charts
  const byYearData = useMemo(() => {
    const map = {};
    enriched.forEach(s => {
      if (!s.launch_date) return;
      const y = parseInt(s.launch_date.slice(0, 4));
      if (!y || y < 2015) return;
      map[y] = (map[y] || 0) + 1;
    });
    return Object.entries(map).sort(([a], [b]) => a - b)
      .map(([year, count]) => ({ year: parseInt(year), count, fill: ERA_COLOR(parseInt(year)) }));
  }, [enriched]);

  const ageDistData = useMemo(() => {
    const counts = AGE_BUCKETS.map(b => ({ name: b.label, count: 0, fill: "#1a5c38" }));
    enriched.forEach(s => {
      if (s.age_wks === null) return;
      const idx = AGE_BUCKETS.findIndex(b => s.age_wks >= b.min && s.age_wks <= b.max);
      if (idx >= 0) counts[idx].count += 1;
    });
    return counts.map((c, i) => ({ ...c, fill: AGE_COLORS[i % AGE_COLORS.length] }));
  }, [enriched]);

  const reorderDistData = useMemo(() => {
    const counts = REORDER_BUCKETS.map(b => ({ name: b.label, value: 0 }));
    enriched.forEach(s => {
      const rc = s.reorder_count || 0;
      const idx = REORDER_BUCKETS.findIndex(b => b.test(rc));
      if (idx >= 0) counts[idx].value += 1;
    });
    return counts;
  }, [enriched]);

  const avgReorderByTier = useMemo(() => {
    const TIER_ORDER = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];
    const map = {};
    enriched.forEach(s => { if (!map[s.tier]) map[s.tier] = []; map[s.tier].push(s.reorder_count || 0); });
    return TIER_ORDER.filter(t => map[t]?.length)
      .map(t => ({
        tier: t,
        avg:  parseFloat((map[t].reduce((a, b) => a + b, 0) / map[t].length).toFixed(1)),
        fill: TIER_COLORS[t] || "#94a3b8",
      }));
  }, [enriched]);

  const scatterData = useMemo(() =>
    enriched
      .filter(s => s.age_wks !== null && s.units_life > 0)
      .map(s => {
        const sor = s.units_life > 0
          ? Math.min(100, Math.round(s.units_life * 100 / (s.units_life + (s.current_stock || 0))))
          : null;
        return { x: s.age_wks, y: sor, tier: s.tier, name: s.style_name, fill: TIER_COLORS[s.tier] || "#94a3b8" };
      })
      .filter(s => s.y !== null)
      .slice(0, 300),
    [enriched]);

  const tier1Table = useMemo(() => {
    const t1 = enriched.filter(s => s.tier === "Tier 1");
    return [...t1].sort((a, b) => {
      if (sortKey === "reorder_count") return (b.reorder_count || 0) - (a.reorder_count || 0);
      if (sortKey === "age_wks") return (b.age_wks || 0) - (a.age_wks || 0);
      if (sortKey === "sor") {
        const sorA = a.units_life > 0 ? a.units_life * 100 / (a.units_life + (a.current_stock || 0)) : 0;
        const sorB = b.units_life > 0 ? b.units_life * 100 / (b.units_life + (b.current_stock || 0)) : 0;
        return sorB - sorA;
      }
      return 0;
    }).slice(0, 8);
  }, [enriched, sortKey]);

  if (loading) return <Loading label="Loading lifecycle data…" />;
  if (error)   return <ErrorBox message={error} />;

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h2 className="text-[22px] font-bold text-foreground">Style Lifecycle &amp; Age Analysis</h2>
        <p className="text-[13px] text-muted mt-0.5">Launch Cohorts, Age Distribution &amp; Reorder Performance · As at {today}</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard label="Avg Style Age"    value={kpis.avgAge !== null ? `${fmtNum(kpis.avgAge)} weeks` : "—"} sub="≈ 2 years avg" showDelta={false} accent />
        <KPICard label="Newest Styles"    value={`${fmtNum(kpis.newest)} styles`} sub={`Launched ${new Date().getFullYear()}`} showDelta={false} />
        <KPICard label="Oldest Styles"    value={`${fmtNum(kpis.oldest)} styles`} sub="Launched ≤ 2019" showDelta={false} />
        <KPICard label="Avg Reorder Count" value={`${fmtDec(kpis.avgReo, 1)}×`} sub="Per active style" showDelta={false} />
        <KPICard label="Most Reordered"   value={`${fmtNum(kpis.maxReo)}×`} sub="Tier 1 core styles" showDelta={false} />
      </div>

      {/* Chart row 1: By Year, Age Dist, Reorder Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Launched by Year */}
        <div className="card-white p-5">
          <SectionTitle title="Styles Launched by Year" />
          <div className="mt-3" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byYearData} margin={{ bottom: 10, top: 10, left: -10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="year" tick={{ fontSize: 10 }} label={{ value: "Launch Year", position: "insideBottom", offset: -5, fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => [fmtNum(v), "Styles"]} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {byYearData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="count" position="top" style={{ fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Age Distribution */}
        <div className="card-white p-5">
          <SectionTitle title="Portfolio Age Distribution" subtitle="Style Age (weeks)" />
          <div className="mt-3" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={ageDistData} margin={{ bottom: 20, top: 10, left: -10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} label={{ value: "Style Age", position: "insideBottom", offset: -12, fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} label={{ value: "No. of Styles", angle: -90, position: "insideLeft", offset: 15, fontSize: 10 }} />
                <Tooltip formatter={(v) => [fmtNum(v), "Styles"]} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {ageDistData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="count" position="top" style={{ fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Reorder Count Distribution */}
        <div className="card-white p-5 flex flex-col">
          <SectionTitle title="Reorder Count Distribution" />
          <div className="flex-1 mt-3" style={{ minHeight: 240 }}>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={reorderDistData} cx="50%" cy="50%" innerRadius={60} outerRadius={95}
                  paddingAngle={3} dataKey="value"
                  label={({ name, value }) => value > 0 ? `${name}` : ""}
                  labelLine={false}
                >
                  {reorderDistData.map((d, i) => <Cell key={i} fill={REORDER_COLORS[i]} />)}
                </Pie>
                <Tooltip formatter={(v, n, p) => [fmtNum(v) + " styles", p.payload.name]} />
                <Legend iconSize={10} formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Chart row 2: Avg Reorder by Tier, Scatter, Tier 1 Table */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Avg Reorder by Tier */}
        <div className="card-white p-5">
          <SectionTitle title="Avg Reorder Count by Tier" />
          <div className="mt-3" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={avgReorderByTier} margin={{ top: 20, right: 20, bottom: 10, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="tier" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} label={{ value: "Avg Reorder Count", angle: -90, position: "insideLeft", offset: 15, fontSize: 10 }} />
                <Tooltip formatter={(v) => [fmtDec(v, 1) + "×", "Avg Reorders"]} />
                <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                  {avgReorderByTier.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="avg" position="top" formatter={(v) => `${fmtDec(v, 1)}×`} style={{ fontSize: 11, fontWeight: "bold" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Age vs Lifetime SOR Scatter */}
        <div className="card-white p-5">
          <SectionTitle title="Style Age vs Lifetime SOR % (sample)" />
          <div className="mt-3" style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="x" name="Age (wks)" type="number" label={{ value: "Style Age (weeks)", position: "insideBottom", offset: -10, fontSize: 10 }} tick={{ fontSize: 10 }} />
                <YAxis dataKey="y" name="Lifetime SOR %" domain={[0, 100]} label={{ value: "Lifetime SOR %", angle: -90, position: "insideLeft", offset: 10, fontSize: 10 }} tick={{ fontSize: 10 }} />
                <ZAxis range={[20, 20]} />
                <Tooltip formatter={(v, n) => [n === "x" ? `${v} wks` : `${v}%`, n === "x" ? "Age" : "Lifetime SOR"]} />
                <Scatter data={scatterData} shape={(props) => {
                  const { cx, cy, payload } = props;
                  return <circle cx={cx} cy={cy} r={4} fill={payload.fill} fillOpacity={0.65} />;
                }} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {Object.entries(TIER_COLORS).filter(([t]) => t !== "Retired").map(([t, c]) => (
              <span key={t} className="flex items-center gap-1 text-[10px] text-muted">
                <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: c }} /> {t}
              </span>
            ))}
          </div>
        </div>

        {/* Tier 1 Top Performers table */}
        <div className="card-white p-5">
          <div className="flex items-center justify-between mb-3">
            <SectionTitle title="Tier 1 — Top Performers" />
            <select
              className="text-[11px] border border-border rounded px-2 py-1 bg-white"
              value={sortKey}
              onChange={e => setSortKey(e.target.value)}
            >
              <option value="reorder_count">By Reorders</option>
              <option value="age_wks">By Age</option>
              <option value="sor">By Lifetime SOR</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11.5px]">
              <thead>
                <tr className="border-b-2 border-line">
                  <th className="text-left font-semibold text-muted pb-2 pr-2">Style</th>
                  <th className="text-right font-semibold text-muted pb-2 px-2">Age</th>
                  <th className="text-right font-semibold text-muted pb-2 px-2">Reorders</th>
                  <th className="text-right font-semibold text-muted pb-2 pl-2">Life SOR%</th>
                </tr>
              </thead>
              <tbody>
                {tier1Table.map((s, i) => {
                  const sor = s.units_life > 0
                    ? Math.round(s.units_life * 100 / (s.units_life + (s.current_stock || 0)))
                    : null;
                  return (
                    <tr key={s.style_name} className="border-b border-line/50 hover:bg-slate-50">
                      <td className="py-1.5 pr-2 font-medium text-foreground truncate max-w-[140px]" title={s.style_name}>{s.style_name}</td>
                      <td className="text-right py-1.5 px-2 text-muted tabular-nums">{s.age_wks !== null ? `${fmtNum(s.age_wks)}w` : "—"}</td>
                      <td className="text-right py-1.5 px-2 font-semibold tabular-nums">{s.reorder_count || 0}×</td>
                      <td className="text-right py-1.5 pl-2 tabular-nums">{sor !== null ? `${sor}%` : "—"}</td>
                    </tr>
                  );
                })}
                {tier1Table.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-muted text-[12px]">No Tier 1 styles found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MerchLifecycle;
