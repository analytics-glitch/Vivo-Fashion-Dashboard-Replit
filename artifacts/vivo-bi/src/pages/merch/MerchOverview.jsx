/**
 * Executive Overview tab — Merchandising Hub
 * 5 KPI cards + 7 charts + Recommended Actions panel
 *
 * API contracts (from merch_router.py):
 *   summary  → { total_styles, on_track_count, at_risk_count, overdue_count,
 *                total_stock_units, revenue_6m, units_6m, weekly_velocity,
 *                avg_woc, avg_full_price_pct, avg_sor_6m, zero_stock_count,
 *                no_sale_30d_count, woc_lt4_count, woc_gt20_count }
 *   styles   → { styles: [...], count }   (NOT { rows })
 *   by-brand → { rows: [{ brand, style_count, units_6m, revenue_6m,
 *                          current_stock, avg_woc, avg_sor_6m,
 *                          avg_full_price_pct }] }
 *   by-subcategory → same shape with subcategory key
 *   by-tier  → same shape with tier key
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
import { useMerchFilters } from "@/pages/MerchandisingHub";

// ── Tooltips ──────────────────────────────────────────────────────────────────
const KesTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1 max-w-[180px] truncate">{label || payload[0]?.name}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: p.fill || p.color }} />
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
      <div className="font-semibold text-slate-700 mb-1">{label || payload[0]?.name}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// ── Tier / palette ────────────────────────────────────────────────────────────
const TIER_COLOR_ARR = [C.blue, C.teal, C.purple, C.amber, C.green, C.red];

// WOC bucket colours
const WOC_BUCKET_COLORS = [C.green, "#60a5fa", C.amber, C.amber, C.red];

// FP bucket colours
const FP_BUCKET_COLORS = [C.red, C.amber, C.blue, C.green];

export default function MerchOverview() {
  const filters = useMerchFilters();
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"]);

  // ── styles is { styles: [...], count } ────────────────────────────────────
  const styleRows = useMemo(() => styles?.styles || [], [styles]);

  // ── Compute distributions from styles ─────────────────────────────────────
  const wocDist = useMemo(() => {
    const buckets = { "0-4 wks": 0, "4-8 wks": 0, "8-12 wks": 0, "12-20 wks": 0, "20+ wks": 0 };
    for (const r of styleRows) {
      const w = r.woc;
      if (w === null || w === undefined) continue;
      if (w < 4)       buckets["0-4 wks"]++;
      else if (w < 8)  buckets["4-8 wks"]++;
      else if (w < 12) buckets["8-12 wks"]++;
      else if (w < 20) buckets["12-20 wks"]++;
      else             buckets["20+ wks"]++;
    }
    return Object.entries(buckets).map(([name, value], i) => ({ name, value, color: WOC_BUCKET_COLORS[i] }));
  }, [styleRows]);

  const fpDist = useMemo(() => {
    const buckets = { "<70%": 0, "70-85%": 0, "85-95%": 0, ">95%": 0 };
    for (const r of styleRows) {
      const fp = r.full_price_pct;
      if (fp === null || fp === undefined) continue;
      if (fp < 70)       buckets["<70%"]++;
      else if (fp < 85)  buckets["70-85%"]++;
      else if (fp < 95)  buckets["85-95%"]++;
      else               buckets[">95%"]++;
    }
    return Object.entries(buckets).map(([name, value], i) => ({ name, value, color: FP_BUCKET_COLORS[i] }));
  }, [styleRows]);

  // Recommended actions from action_status
  const actionCounts = useMemo(() => {
    const counts = { healthy: 0, on_review: 0, marketing: 0, overdue: 0 };
    for (const r of styleRows) {
      const st = r.action_status;
      const act = r.recommended_action || "";
      if (st === "on_track") {
        counts.healthy++;
      } else if (st === "overdue") {
        counts.overdue++;
      } else {
        // at_risk — split by action label
        if (act.includes("Review") || act.includes("Overstock")) counts.on_review++;
        else counts.marketing++;
      }
    }
    return counts;
  }, [styleRows]);

  // ── Brand data ────────────────────────────────────────────────────────────
  const brandData = useMemo(() => {
    if (!byBrand?.rows) return [];
    return [...byBrand.rows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0)).slice(0, 6);
  }, [byBrand]);

  // ── Top 5 subcategories ───────────────────────────────────────────────────
  const top5SubcatData = useMemo(() => {
    if (!bySubcategory?.rows) return [];
    return [...bySubcategory.rows].sort((a, b) => (b.revenue_6m || 0) - (a.revenue_6m || 0)).slice(0, 5);
  }, [bySubcategory]);

  // ── Tier donut ────────────────────────────────────────────────────────────
  const tierPieData = useMemo(() => {
    if (!byTier?.rows) return [];
    return byTier.rows.map((r, i) => ({
      name:  r.tier,
      value: r.revenue_6m || 0,
      color: TIER_COLOR_ARR[i] || C.muted,
    }));
  }, [byTier]);

  // ── Style status bar ──────────────────────────────────────────────────────
  const styleStatus = useMemo(() => {
    if (!summary) return [];
    return [
      { name: "On Track", value: summary.on_track_count || 0, color: C.green },
      { name: "At Risk",  value: summary.at_risk_count  || 0, color: C.amber },
      { name: "Overdue",  value: summary.overdue_count  || 0, color: C.red },
    ];
  }, [summary]);

  // ── Actions panel ─────────────────────────────────────────────────────────
  const actions = useMemo(() => [
    { label: "Healthy — maintain replenishment",  count: actionCounts.healthy,    color: C.green, bg: "#f0fdf4", text: "#166534" },
    { label: "On Review — monitor closely",       count: actionCounts.on_review,  color: C.amber, bg: "#fffbeb", text: "#92400e" },
    { label: "Consider marketing / price review", count: actionCounts.marketing,  color: "#f97316", bg: "#fff7ed", text: "#9a3412" },
    { label: "Overdue Week-8 read",               count: actionCounts.overdue,    color: C.red,   bg: "#fef2f2", text: "#991b1b" },
  ], [actionCounts]);

  if (loading) return <Loading label="Loading Executive Overview…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};
  const atRiskPct = s.total_styles ? ((s.at_risk_count || 0) / s.total_styles * 100).toFixed(1) : "0";
  const avgRevPerStyle = s.total_styles ? s.revenue_6m / s.total_styles : 0;

  // Build subtitle from active filters
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
  const dateLabel = filters.from_date
    ? (filters.from_date === filters.to_date
        ? fmtDate(filters.from_date)
        : `${fmtDate(filters.from_date)} – ${fmtDate(filters.to_date)}`)
    : "Last 6 months";
  const locationLabel = filters.pos_location
    ? filters.pos_location.split(",").length === 1
      ? filters.pos_location
      : `${filters.pos_location.split(",").length} locations`
    : filters.country
      ? filters.country.split(",").join(", ")
      : "All Locations";

  return (
    <div className="space-y-5 pb-8">
      <div className="text-[11px] text-slate-400">
        Active Style Numbers · {dateLabel} · {locationLabel}
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-3">
        <MerchKPICard
          label="Active Style Numbers"
          value={fmtNum(s.active_styles_count)}
          sub={`Total incl. Retired: ${fmtNum(s.total_styles)}`}
          accentColor={C.blue}
          testId="merch-kpi-active-styles"
        />
        <MerchKPICard
          label="Active Colour Styles"
          value={fmtNum(s.active_colour_styles_count)}
          sub="Distinct style × colour"
          accentColor={C.teal}
          testId="merch-kpi-colour-styles"
        />
        <MerchKPICard
          label="Warehouse Units"
          value={fmtNum(s.warehouse_stock_units)}
          sub="Warehouse Finished Goods"
          accentColor={C.purple}
          testId="merch-kpi-warehouse"
        />
        <MerchKPICard
          label="Total Stock Units"
          value={fmtNum(s.total_stock_units)}
          sub={`WOC > 20: ${fmtNum(s.woc_gt20_count)} styles`}
          accentColor="#0891b2"
          testId="merch-kpi-stock"
        />
        <MerchKPICard
          label="Style Health"
          value={fmtNum(s.on_track_count)}
          sub={`On Track (${s.total_styles ? Math.round((s.on_track_count || 0) / s.total_styles * 100) : 0}%)`}
          sub2={`At Risk: ${fmtNum(s.at_risk_count)} (${atRiskPct}%)`}
          accentColor={C.green}
          testId="merch-kpi-styles"
        />
        <MerchKPICard
          label="Revenue (period)"
          value={fmtKESM(s.revenue_6m)}
          sub="Avg per Style"
          sub2={fmtKESM(avgRevPerStyle)}
          accentColor="#16a34a"
          testId="merch-kpi-revenue"
        />
        <MerchKPICard
          label="Units Sold (period)"
          value={fmtNum(s.units_6m)}
          sub="Weekly Vel."
          sub2={`${fmtNum(s.weekly_velocity)} /wk`}
          accentColor={C.amber}
          testId="merch-kpi-units"
        />
        <MerchKPICard
          label="Avg Full Price %"
          value={fmtPct1(s.avg_full_price_pct)}
          sub="Avg SOR (period)"
          sub2={fmtPct1(s.avg_sor_6m)}
          accentColor={C.red}
          testId="merch-kpi-fp"
        />
      </div>

      {/* ── Row 1 charts ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Revenue by Brand */}
        <ChartCard title="Revenue by Brand (6m)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={brandData}
              layout="vertical"
              margin={{ top: 0, right: 65, left: 45, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="brand" tick={{ fontSize: 10 }} width={50} />
              <Tooltip content={<KesTooltip />} />
              <Bar dataKey="revenue_6m" name="Revenue 6m" fill={C.blue} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_6m" position="right" formatter={fmtKESM} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Top 5 Subcategories */}
        <ChartCard title="Top 5 Subcategories by Revenue (6m)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={top5SubcatData}
              layout="vertical"
              margin={{ top: 0, right: 65, left: 80, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="subcategory" tick={{ fontSize: 9 }} width={80} tickFormatter={(v) => v?.length > 18 ? v.slice(0, 18) + "…" : v} />
              <Tooltip content={<KesTooltip />} />
              <Bar dataKey="revenue_6m" name="Revenue 6m" fill={C.blue} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_6m" position="right" formatter={fmtKESM} style={{ fontSize: 9, fill: "#64748b" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Revenue by Tier donut */}
        <ChartCard title="Revenue by Tier (6m)">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={tierPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40} paddingAngle={2}>
                {tierPieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip formatter={(val, name) => [fmtKESM(val), name]} contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} />
              <Legend formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} iconSize={8} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Row 2 charts + actions ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Style Status */}
        <ChartCard title="Style Status">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={styleStatus} margin={{ top: 16, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="value" name="Styles" radius={[4, 4, 0, 0]}>
                {styleStatus.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList dataKey="value" position="top" style={{ fontSize: 11, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* WOC Distribution */}
        <ChartCard title="Weeks of Cover Distribution">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={wocDist} margin={{ top: 16, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="value" name="Styles" radius={[4, 4, 0, 0]}>
                {wocDist.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList dataKey="value" position="top" style={{ fontSize: 11, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* FP% Distribution */}
        <ChartCard title="Full Price % Distribution">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={fpDist} margin={{ top: 16, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="value" name="Styles" radius={[4, 4, 0, 0]}>
                {fpDist.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList dataKey="value" position="top" style={{ fontSize: 11, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Recommended Actions panel */}
        <ChartCard title="Recommended Actions Summary">
          <div className="space-y-2 mt-2">
            {actions.map((a, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg px-3 py-2.5"
                style={{ backgroundColor: a.bg, borderLeft: `3px solid ${a.color}` }}
              >
                <span className="text-[11px] font-medium" style={{ color: a.text }}>{a.label}</span>
                <span className="text-[14px] font-extrabold tabular-nums" style={{ color: a.color }}>{a.count}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>
    </div>
  );
}
