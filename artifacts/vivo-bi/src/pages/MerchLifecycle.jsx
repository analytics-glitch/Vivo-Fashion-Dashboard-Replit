/**
 * MerchLifecycle — Lifecycle & Launches tab
 * ?tab=merch-lifecycle
 *
 * Consolidates the former Style Lifecycle & Age and New Arrivals & Pipeline
 * tabs (Task 1286), organised in two sections:
 *   1. Style Lifecycle & Age — launch cohorts, age distribution, reorder
 *      analysis, age-vs-SOR scatter, Tier 1 top performers table
 *   2. New Arrivals & Pipeline — CY/PY launch KPIs, launches by subcategory,
 *      SOR ramp by tier, launch status, top recent launches, monthly launch
 *      cadence, launches by brand
 * Both sections share ONE fetch of /merch/styles, /merch/by-tier,
 * /merch/summary and /merch/launch-ramp.
 *
 * Data: /api/merch/styles (full list), /api/merch/by-tier,
 *       /api/merch/summary, /api/merch/launch-ramp
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, ScatterChart, Scatter, ZAxis, LabelList,
  LineChart, Line, ReferenceLine,
} from "recharts";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { apiFetch, fmtNum, fmtDec, fmtKES } from "@/lib/api";
import { useMerchFilters } from "./MerchandisingHub";
import { SubcatFilter } from "./merch/MerchHelpers";
import { Rocket, CalendarBlank, CurrencyCircleDollar, CheckCircle } from "@phosphor-icons/react";

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

// Arrivals-section colours (from the retired New Arrivals & Pipeline tab)
const STATUS_COLORS  = { "On Track": "#1a5c38", "At Risk": "#d97706", "Overdue": "#ef4444" };
const TIER_LINE_COLORS = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3/4": "#d97706" };
const BRAND_COLORS   = ["#1a5c38", "#4b7bec", "#d97706", "#7c3aed"];

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

// ── month label helper ─────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLabel = (iso) => {
  if (!iso) return "";
  const [, m] = iso.split("-");
  return MONTHS[parseInt(m, 10) - 1] || iso;
};

const MerchLifecycle = () => {
  const filters = useMerchFilters();
  const [styles, setStyles] = useState([]);
  const [tierRows, setTierRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [ramp, setRamp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey]     = useState("reorder_count");
  const [localSubcat, setLocalSubcat] = useState(null);

  const currentYear = new Date().getFullYear();
  const priorYear   = currentYear - 1;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const effSubcat = localSubcat !== null ? localSubcat : (filters.subcategory || "");
    const params = { country: filters.country, from_date: filters.from_date, to_date: filters.to_date,
      pos_location: filters.pos_location,
      brand: filters.brand, ...(effSubcat ? { subcategory: effSubcat } : {}) };
    Promise.all([
      apiFetch("/merch/styles", { params }),
      apiFetch("/merch/by-tier", { params }),
      apiFetch("/merch/summary", { params }),
      // launch-ramp honours the same filter params as the other endpoints
      apiFetch("/merch/launch-ramp", { params }),
    ])
      .then(([sData, tData, sumData, rampData]) => {
        if (cancelled) return;
        setStyles(sData.styles || []);
        setTierRows(tData.rows || []);
        setSummary(sumData);
        setRamp(rampData.by_tier || {});
      })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.from_date, filters.to_date, filters.brand, filters.subcategory, filters.pos_location, filters.dataVersion, localSubcat]);

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

  // ── Arrivals derivations (from the retired New Arrivals & Pipeline tab) ──

  const cyLaunches = useMemo(() =>
    styles.filter(s => s.launch_date && s.launch_date.startsWith(String(currentYear))),
    [styles, currentYear]);

  const pyLaunches = useMemo(() =>
    styles.filter(s => s.launch_date && s.launch_date.startsWith(String(priorYear))),
    [styles, priorYear]);

  const avgAgeCY = useMemo(() => {
    if (!cyLaunches.length) return 0;
    const now = Date.now();
    const total = cyLaunches.reduce((a, s) => {
      const d = new Date(s.launch_date);
      return a + (now - d.getTime()) / (7 * 24 * 3600 * 1000);
    }, 0);
    return Math.round(total / cyLaunches.length);
  }, [cyLaunches]);

  const revCY = useMemo(() => cyLaunches.reduce((a, s) => a + (s.revenue_6m || 0), 0), [cyLaunches]);

  const onTrackCY = useMemo(() =>
    cyLaunches.filter(s => s.action_status === "on_track").length,
    [cyLaunches]);
  const onTrackPct = cyLaunches.length ? Math.round(onTrackCY / cyLaunches.length * 100) : 0;

  // Launches by subcategory
  const bySubcatChart = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      map[s.subcategory || "Other"] = (map[s.subcategory || "Other"] || 0) + 1;
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
  }, [cyLaunches]);

  // SOR ramp chart
  const rampChart = useMemo(() => {
    const tiers = Object.keys(ramp || {});
    const maxWeek = 32;
    const weekSet = new Set();
    for (const tier of tiers) {
      for (const pt of (ramp[tier] || [])) {
        if (pt.week_n <= maxWeek) weekSet.add(pt.week_n);
      }
    }
    const weeks = [...weekSet].sort((a, b) => a - b);
    return weeks.map(w => {
      const row = { week: w };
      for (const tier of tiers) {
        const pt = (ramp[tier] || []).find(p => p.week_n === w);
        row[tier] = pt ? +pt.avg_cumulative_sor_pct.toFixed(1) : undefined;
      }
      return row;
    });
  }, [ramp]);

  // Launch status donut
  const statusDonut = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      const key = s.action_status === "on_track" ? "On Track" :
                  s.action_status === "overdue"  ? "Overdue"  : "At Risk";
      map[key] = (map[key] || 0) + 1;
    }
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [cyLaunches]);

  // Top recent launches by SOR
  const topSOR = useMemo(() =>
    [...cyLaunches]
      .filter(s => s.sor_6m > 0)
      .sort((a, b) => b.sor_6m - a.sor_6m)
      .slice(0, 8)
      .map(s => {
        const ageWks = s.launch_date
          ? Math.round((Date.now() - new Date(s.launch_date).getTime()) / (7 * 24 * 3600 * 1000))
          : 0;
        return { name: s.style_name, sor: +s.sor_6m.toFixed(1), age: ageWks };
      }),
    [cyLaunches]);

  // Monthly launch cadence
  const cadenceChart = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      if (!s.launch_date) continue;
      const mon = s.launch_date.slice(0, 7); // YYYY-MM
      if (!map[mon]) map[mon] = { on: 0, risk: 0 };
      if (s.action_status === "on_track") map[mon].on++;
      else map[mon].risk++;
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mon, v]) => ({ name: monthLabel(mon), onTrack: v.on, atRisk: v.risk }));
  }, [cyLaunches]);

  // By brand donut
  const brandDonut = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      map[s.brand || "Other"] = (map[s.brand || "Other"] || 0) + 1;
    }
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [cyLaunches]);

  if (loading) return <Loading label="Loading lifecycle data…" />;
  if (error)   return <ErrorBox message={error} />;

  // ── Local subcategory selector rendered at top of page content ───────────
  const subcatSelector = <SubcatFilter value={localSubcat} onChange={setLocalSubcat} />;

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="space-y-6 pb-10">
      {subcatSelector}
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

      {/* ════ New Arrivals & Pipeline (from the retired Arrivals tab) ════ */}
      <div className="border-t border-slate-200 pt-5">
        <h2 className="text-[18px] font-bold text-foreground">New Arrivals &amp; Pipeline Performance</h2>
        <p className="text-[12px] text-muted mt-0.5">
          {priorYear}–{currentYear} Launches, Early SOR &amp; Velocity Ramp
        </p>
      </div>

      {/* Arrivals KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          label={`Styles Launched ${currentYear}`}
          value={fmtNum(summary?.styles_launched_current_year ?? cyLaunches.length)}
          sub={`In first 52 weeks`}
          icon={Rocket}
          accent showDelta={false}
          testId="arr-cy-count"
        />
        <KPICard
          label={`Styles Launched ${priorYear}`}
          value={fmtNum(summary?.styles_launched_prior_year ?? pyLaunches.length)}
          sub="Full year"
          icon={CalendarBlank}
          accent showDelta={false}
          testId="arr-py-count"
        />
        <KPICard
          label={`Avg Age (${currentYear} styles)`}
          value={avgAgeCY + " wks"}
          sub="Early lifecycle"
          accent showDelta={false}
          testId="arr-avg-age"
        />
        <KPICard
          label={`${currentYear} Revenue`}
          value={fmtKES(revCY) + "+"}
          sub="Estimated 6m"
          icon={CurrencyCircleDollar}
          accent showDelta={false}
          testId="arr-cy-rev"
        />
        <KPICard
          label="Styles On Track"
          value={onTrackPct + "%"}
          sub={`Of ${currentYear} launches`}
          icon={CheckCircle}
          accent showDelta={false}
          testId="arr-on-track"
        />
      </div>

      {/* Arrivals Row 1: Launches by subcategory + SOR Ramp by Tier + Status donut */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Launches by subcategory — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle title={`${currentYear} Launches by Subcategory`} subtitle={`Styles Launched in ${currentYear}`} />
          {bySubcatChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={bySubcatChart}
                  layout="vertical"
                  margin={{ top: 4, right: 40, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} />
                  <Tooltip />
                  <Bar dataKey="count" name="Launches" fill="#1a5c38" radius={[0, 3, 3, 0]}>
                    <LabelList dataKey="count" position="right" style={{ fontSize: 10 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* SOR Ramp — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle title={`SOR Ramp by Tier — ${currentYear} Launches`} subtitle="Cumulative SOR %" />
          {rampChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={rampChart} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="week" tick={{ fontSize: 10 }} label={{ value: "Weeks Since Launch", position: "insideBottom", offset: -4, style: { fontSize: 10 } }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "%"} domain={[0, 100]} />
                  <Tooltip formatter={(v, n) => [v + "%", n]} />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
                  <ReferenceLine y={60} stroke="#d97706" strokeDasharray="5 3"
                    label={{ value: "Target 60%", position: "right", style: { fontSize: 9, fill: "#d97706" } }} />
                  {Object.keys(ramp || {}).map(tier => (
                    <Line
                      key={tier}
                      type="monotone"
                      dataKey={tier}
                      name={tier}
                      stroke={TIER_LINE_COLORS[tier] || "#4b7bec"}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Launch Status donut — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title={`${currentYear} Launch Status`} />
          {statusDonut.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={statusDonut}
                    cx="50%"
                    cy="42%"
                    innerRadius={55}
                    outerRadius={82}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, value }) => `${name} (${value})`}
                    labelLine
                  >
                    {statusDonut.map((entry, i) => (
                      <Cell key={i} fill={STATUS_COLORS[entry.name] || "#4b7bec"} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v + " styles", n]} />
                </PieChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>

      {/* Arrivals Row 2: Top SOR + Monthly Cadence + Brand Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Top Recent Launches by SOR — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle title="Top Recent Launches by SOR" subtitle="Lifetime SOR %" />
          {topSOR.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={topSOR}
                  layout="vertical"
                  margin={{ top: 4, right: 70, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} domain={[97, 101]}
                    tickFormatter={v => v + "%"} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={130} />
                  <Tooltip formatter={(v, n) => [v + "%", n]} />
                  <Bar dataKey="sor" name="SOR %" fill="#4b7bec" radius={[0, 3, 3, 0]}>
                    <LabelList
                      dataKey="sor"
                      position="right"
                      style={{ fontSize: 9 }}
                      formatter={(v, _, row) => `${v}% (${topSOR.find(s => s.sor === v)?.age ?? "?"}wks)`}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Monthly Cadence stacked — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle title={`${currentYear} Monthly Launch Cadence`} subtitle="Styles Launched" />
          {cadenceChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={cadenceChart} margin={{ top: 16, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="onTrack" name="On Track" stackId="a" fill="#1a5c38" radius={[0, 0, 0, 0]}>
                    <LabelList dataKey="onTrack" position="inside" style={{ fontSize: 9, fill: "#fff" }} />
                  </Bar>
                  <Bar dataKey="atRisk" name="At Risk" stackId="a" fill="#ef4444" radius={[3, 3, 0, 0]}>
                    <LabelList dataKey="atRisk" position="top" style={{ fontSize: 9 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Brand Donut — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title={`${currentYear} Launches by Brand`} />
          {brandDonut.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={brandDonut}
                    cx="50%"
                    cy="42%"
                    innerRadius={55}
                    outerRadius={82}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {brandDonut.map((_, i) => (
                      <Cell key={i} fill={BRAND_COLORS[i % BRAND_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v + " styles", n]} />
                </PieChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>
    </div>
  );
};

export default MerchLifecycle;
