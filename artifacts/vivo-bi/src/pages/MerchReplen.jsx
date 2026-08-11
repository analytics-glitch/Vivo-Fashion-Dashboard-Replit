/**
 * MerchReplen — Replenishment & Reorder Planning tab
 * ?tab=merch-replen
 *
 * Data: /api/merch/styles, /api/merch/by-subcategory, /api/merch/by-tier, /api/merch/summary
 * Charts: High-Velocity WOC bar, Avg WOC by Subcategory bar,
 *         Weekly Velocity Distribution bar, Reorder Count+Style Count by Tier ComposedChart,
 *         WOC Bucket Mix donut
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, PieChart, Pie, Cell, Legend, LabelList,
  ComposedChart, Line,
} from "recharts";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import { apiFetch, fmtNum, fmtDec } from "@/lib/api";
import { useMerchFilters } from "./MerchandisingHub";

// ── Colour helpers ────────────────────────────────────────────────────────────
const WOC_COLOR = (woc) => {
  if (woc === null || woc === undefined) return "#94a3b8";
  if (woc < 4)  return "#ef4444";
  if (woc <= 8) return "#d97706";
  return "#1a5c38";
};

const TIER_COLORS = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3": "#0891b2", "Tier 4": "#d97706" };
const DONUT_COLORS = ["#ef4444", "#d97706", "#1a5c38", "#4b7bec", "#7c3aed"];

const truncate = (s, n = 22) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

const WOC_BUCKETS = [
  { label: "0–4 wks",   min: 0,  max: 4,  fill: "#ef4444" },
  { label: "4–8 wks",   min: 4,  max: 8,  fill: "#d97706" },
  { label: "8–12 wks",  min: 8,  max: 12, fill: "#00c853" },
  { label: "12–20 wks", min: 12, max: 20, fill: "#4b7bec" },
  { label: "20+ wks",   min: 20, max: Infinity, fill: "#7c3aed" },
];

const VEL_BUCKETS = [
  { label: "0–5 /wk",    min: 0,   max: 5 },
  { label: "5–20 /wk",   min: 5,   max: 20 },
  { label: "20–50 /wk",  min: 20,  max: 50 },
  { label: "50–100 /wk", min: 50,  max: 100 },
  { label: "100+ /wk",   min: 100, max: Infinity },
];

const VEL_COLORS = ["#94a3b8", "#4b7bec", "#1a5c38", "#d97706", "#ef4444"];

const MerchReplen = () => {
  const filters = useMerchFilters();
  const [styles, setStyles]   = useState([]);
  const [subRows, setSubRows] = useState([]);
  const [tierRows, setTierRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { country: filters.country, from_date: filters.from_date, to_date: filters.to_date };
    Promise.all([
      apiFetch("/merch/styles",          { params }),
      apiFetch("/merch/by-subcategory",  { params }),
      apiFetch("/merch/by-tier",         { params }),
      apiFetch("/merch/summary",         { params }),
    ])
      .then(([sd, sub, tier, sum]) => {
        if (cancelled) return;
        setStyles(sd.styles || []);
        setSubRows(sub.rows || []);
        setTierRows(tier.rows || []);
        setSummary(sum);
      })
      .catch(e => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.from_date, filters.to_date, filters.dataVersion]);

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    if (!summary) return {};
    return {
      totalVelocity: summary.weekly_velocity || 0,
      wocLt4:        summary.woc_lt4_count   || 0,
      wocLt8:        styles.filter(s => s.woc !== null && s.woc >= 4 && s.woc <= 8).length,
      avgReorder:    styles.length
        ? styles.reduce((acc, s) => acc + (s.reorder_count || 0), 0) / styles.length
        : 0,
      zeroStock:     summary.zero_stock_count || 0,
    };
  }, [summary, styles]);

  // ── Chart data ────────────────────────────────────────────────────────────

  // High-velocity top 15 sorted by weekly_avg desc
  const highVelData = useMemo(() => {
    const withStock = styles.filter(s => s.weekly_avg > 0);
    return [...withStock].sort((a, b) => (b.weekly_avg || 0) - (a.weekly_avg || 0))
      .slice(0, 15)
      .map(s => ({
        name:  truncate(s.style_name, 26),
        woc:   s.woc,
        fill:  WOC_COLOR(s.woc),
        label: s.woc !== null
          ? `${fmtNum(s.current_stock)} (${fmtDec(s.woc, 1)}w)`
          : `${fmtNum(s.current_stock)} (—)`,
        vel:   s.weekly_avg,
      }));
  }, [styles]);

  // Avg WOC by subcategory
  const wocBySub = useMemo(() =>
    [...subRows]
      .filter(r => r.avg_woc !== null)
      .sort((a, b) => (b.avg_woc || 0) - (a.avg_woc || 0))
      .slice(0, 12)
      .map(r => ({
        name:  truncate(r.subcategory, 22),
        woc:   r.avg_woc,
        fill:  WOC_COLOR(r.avg_woc),
      })),
    [subRows]);

  // Velocity distribution
  const velDistData = useMemo(() => {
    const counts = VEL_BUCKETS.map(b => ({ name: b.label, count: 0 }));
    styles.forEach(s => {
      const v = s.weekly_avg || 0;
      const i = VEL_BUCKETS.findIndex(b => v >= b.min && v < b.max);
      if (i >= 0) counts[i].count += 1;
    });
    return counts.map((c, i) => ({ ...c, fill: VEL_COLORS[i] }));
  }, [styles]);

  // Reorder count & style count by tier (for ComposedChart)
  const byTierChart = useMemo(() => {
    const TIER_ORDER = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];
    const map = {};
    styles.forEach(s => {
      const t = s.tier;
      if (!TIER_ORDER.includes(t)) return;
      if (!map[t]) map[t] = { tier: t, reorder_sum: 0, count: 0 };
      map[t].reorder_sum += (s.reorder_count || 0);
      map[t].count += 1;
    });
    return TIER_ORDER.filter(t => map[t])
      .map(t => ({
        tier:    t,
        avg_reo: parseFloat((map[t].reorder_sum / map[t].count).toFixed(1)),
        count:   map[t].count,
        fill:    TIER_COLORS[t] || "#94a3b8",
      }));
  }, [styles]);

  // WOC bucket mix donut
  const wocDonut = useMemo(() => {
    const counts = WOC_BUCKETS.map(b => ({ name: b.label, value: 0, fill: b.fill }));
    styles.forEach(s => {
      if (s.woc === null) return;
      const i = WOC_BUCKETS.findIndex(b => s.woc >= b.min && s.woc < b.max);
      if (i >= 0) counts[i].value += 1;
    });
    return counts.filter(c => c.value > 0);
  }, [styles]);

  if (loading) return <Loading label="Loading replenishment data…" />;
  if (error)   return <ErrorBox message={error} />;

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h2 className="text-[22px] font-bold text-foreground">Replenishment &amp; Reorder Planning</h2>
        <p className="text-[13px] text-muted mt-0.5">Stock Coverage, Velocity &amp; Reorder Prioritisation · As at {today}</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          label="Total Weekly Velocity"
          value={`${fmtNum(Math.round(kpis.totalVelocity))} /wk`}
          sub="Across all styles"
          showDelta={false}
          accent
        />
        <KPICard
          label="Styles WOC < 4 wks"
          value={`${fmtNum(kpis.wocLt4)} styles`}
          sub="Urgent reorder needed"
          showDelta={false}
        />
        <KPICard
          label="Styles WOC 4–8 wks"
          value={`${fmtNum(kpis.wocLt8)} styles`}
          sub="Reorder soon"
          showDelta={false}
        />
        <KPICard
          label="Avg Reorder Count"
          value={`${fmtDec(kpis.avgReorder, 1)}×`}
          sub="Per active style"
          showDelta={false}
        />
        <KPICard
          label="Styles with 0 Stock"
          value={fmtNum(kpis.zeroStock)}
          sub="All styles in stock"
          showDelta={false}
        />
      </div>

      {/* Top row: High-Velocity WOC + Avg WOC by subcategory */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* High-velocity styles current WOC */}
        <div className="card-white p-5">
          <SectionTitle title="High-Velocity Styles — Current WOC" subtitle="Weeks of Cover (WOC)" />
          <div className="mt-3" style={{ height: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={highVelData} layout="vertical" margin={{ left: 8, right: 100, top: 4, bottom: 4 }}>
                <XAxis type="number" domain={[0, 'auto']} tick={{ fontSize: 10 }}
                  label={{ value: "Weeks of Cover (WOC)", position: "insideBottom", offset: -3, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={145} />
                <Tooltip formatter={(v, n, p) => [
                  v !== null ? `${fmtDec(v, 1)} weeks` : "No WOC",
                  `WOC (${p.payload.vel !== undefined ? fmtDec(p.payload.vel, 1) + ' /wk' : '—'})`
                ]} />
                <ReferenceLine x={4} stroke="#ef4444" strokeDasharray="5 3" label={{ value: "Urgent 4 wks", position: "top", fontSize: 9, fill: "#ef4444" }} />
                <ReferenceLine x={8} stroke="#d97706" strokeDasharray="5 3" label={{ value: "Reorder trigger 8 wks", position: "top", fontSize: 9, fill: "#d97706" }} />
                <Bar dataKey="woc" radius={[0, 3, 3, 0]}>
                  {highVelData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="label" position="right" style={{ fontSize: 9, fill: "#475569" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#ef4444]" /> &lt; 4 wks (urgent)</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#d97706]" /> 4–8 wks</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#1a5c38]" /> &gt; 8 wks</span>
          </div>
        </div>

        {/* Avg WOC by subcategory */}
        <div className="card-white p-5">
          <SectionTitle title="Avg WOC by Subcategory" subtitle="Avg Weeks of Cover" />
          <div className="mt-3" style={{ height: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={wocBySub} layout="vertical" margin={{ left: 8, right: 50, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} unit="w" />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={130} />
                <Tooltip formatter={(v) => [v !== null ? `${fmtDec(v, 1)} weeks` : "—", "Avg WOC"]} />
                <ReferenceLine x={12} stroke="#1a5c38" strokeDasharray="5 3"
                  label={{ value: "Target 12 wks", position: "insideTopLeft", fontSize: 9, fill: "#1a5c38" }} />
                <Bar dataKey="woc" radius={[0, 3, 3, 0]}>
                  {wocBySub.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="woc" position="right" formatter={(v) => v !== null ? `${fmtDec(v, 0)}w` : ""} style={{ fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom row: Velocity dist, Reorder+Tier composed, WOC donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Velocity distribution */}
        <div className="card-white p-5">
          <SectionTitle title="Weekly Velocity Distribution" />
          <div className="mt-3" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={velDistData} margin={{ top: 20, right: 10, bottom: 10, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 10 }} label={{ value: "No. of Styles", angle: -90, position: "insideLeft", offset: 14, fontSize: 9 }} />
                <Tooltip formatter={(v) => [fmtNum(v), "Styles"]} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {velDistData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="count" position="top" style={{ fontSize: 11, fontWeight: "bold" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Reorder Count & Style Count by Tier — ComposedChart */}
        <div className="card-white p-5">
          <SectionTitle title="Reorder Count & Style Count by Tier" />
          <div className="mt-3" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={byTierChart} margin={{ top: 20, right: 40, bottom: 10, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="tier" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 10 }} label={{ value: "Avg Reorder Count", angle: -90, position: "insideLeft", offset: 14, fontSize: 9 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} label={{ value: "No. of Styles", angle: 90, position: "insideRight", offset: 14, fontSize: 9 }} />
                <Tooltip
                  formatter={(v, name) =>
                    name === "avg_reo"
                      ? [`${fmtDec(v, 1)}×`, "Avg Reorders"]
                      : [fmtNum(v), "Style Count"]
                  }
                />
                <Legend iconSize={10} formatter={(v) => <span style={{ fontSize: 10 }}>{v === "avg_reo" ? "Avg Reorder Count" : "Style Count"}</span>} />
                <Bar yAxisId="left" dataKey="avg_reo" radius={[4, 4, 0, 0]}>
                  {byTierChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="avg_reo" position="top" formatter={(v) => `${fmtDec(v, 1)}×`} style={{ fontSize: 10, fontWeight: "bold" }} />
                </Bar>
                <Line yAxisId="right" type="monotone" dataKey="count" stroke="#94a3b8" strokeWidth={2} dot={{ r: 4, fill: "#475569" }} strokeDasharray="4 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* WOC Bucket Mix donut */}
        <div className="card-white p-5 flex flex-col">
          <SectionTitle title="WOC Bucket Mix" />
          <div className="flex-1 mt-3 flex items-center justify-center" style={{ minHeight: 240 }}>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={wocDonut}
                  cx="50%" cy="50%"
                  innerRadius={65} outerRadius={100}
                  paddingAngle={3} dataKey="value"
                  label={({ value, name }) => {
                    const total = wocDonut.reduce((a, d) => a + d.value, 0);
                    return total > 0 ? `${Math.round(value * 100 / total)}%` : "";
                  }}
                  labelLine={false}
                >
                  {wocDonut.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip formatter={(v, n, p) => [fmtNum(v) + " styles", p.payload.name]} />
                <Legend iconSize={10} formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MerchReplen;
