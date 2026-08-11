/**
 * MerchAtRisk — At-Risk Styles & Action Required tab
 * ?tab=merch-atrisk
 *
 * Data: /api/merch/styles (full list, enriched client-side)
 * Charts: Top 10 At-Risk by stock exposure bar, Portfolio Action Status donut,
 *         At-Risk by Subcategory bar, Status by Style Age Group grouped bar,
 *         Priority Actions panel
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LabelList,
} from "recharts";
import { DownloadSimple } from "@phosphor-icons/react";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import { apiFetch, fmtNum } from "@/lib/api";
import { useMerchFilters } from "./MerchandisingHub";

// ── Colour helpers ────────────────────────────────────────────────────────────
const DAYS_COLOR = (days) => {
  if (days === null || days === undefined) return "#94a3b8";
  if (days === 0) return "#1a5c38";
  if (days <= 7) return "#d97706";
  if (days <= 30) return "#f97316";
  return "#ef4444";
};

const STATUS_COLORS = {
  Healthy:           "#1a5c38",
  "On Review":       "#4b7bec",
  "Marketing Push":  "#d97706",
  Overdue:           "#ef4444",
};
const DONUT_COLORS = Object.values(STATUS_COLORS);

const AGE_GROUPS = [
  { label: "0–8 wks\n(New)",    min: 0,  max: 8 },
  { label: "9–26 wks",          min: 9,  max: 26 },
  { label: "27–52 wks",         min: 27, max: 52 },
  { label: "53–104 wks",        min: 53, max: 104 },
  { label: "104+ wks",          min: 105, max: Infinity },
];

const ageWeeks = (launchDate) => {
  if (!launchDate) return null;
  try { return Math.max(0, Math.round((Date.now() - new Date(launchDate).getTime()) / (86_400_000 * 7))); }
  catch { return null; }
};

const truncate = (s, n = 22) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

const MerchAtRisk = () => {
  const filters = useMerchFilters();
  const [styles, setStyles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { country: filters.country, from_date: filters.from_date, to_date: filters.to_date };
    apiFetch("/merch/styles", { params })
      .then(d => { if (!cancelled) setStyles(d.styles || []); })
      .catch(e => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters.country, filters.from_date, filters.to_date, filters.dataVersion]);

  // ── KPI derivations ───────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const atRisk  = styles.filter(s => s.action_status === "at_risk");
    const overdue = styles.filter(s => s.action_status === "overdue");
    const healthy = styles.filter(s => s.action_status === "on_track");
    // "On Review" mapped from at_risk + overdue (those with last_sale_days 60-89 or overstock)
    const onReview = styles.filter(s =>
      s.action_status === "at_risk" &&
      ["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    );
    const stockAtRisk = [...atRisk, ...overdue].reduce((acc, s) => acc + (s.current_stock || 0), 0);
    const total = styles.length;
    return {
      atRiskCount:  atRisk.length,
      overdueCount: overdue.length,
      onReviewCount: onReview.length,
      stockAtRisk,
      healthyCount: healthy.length,
      total,
    };
  }, [styles]);

  // ── Chart data ────────────────────────────────────────────────────────────

  // Top 10 at-risk by stock exposure
  const top10AtRisk = useMemo(() => {
    const risky = styles.filter(s => s.action_status === "at_risk" || s.action_status === "overdue");
    return [...risky].sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))
      .slice(0, 10)
      .map(s => ({
        name:          truncate(s.style_name, 28),
        stock:         s.current_stock || 0,
        days:          s.last_sale_days,
        daysLabel:     s.last_sale_days === null ? "No sale data" : `Last sale: ${s.last_sale_days}d`,
        fill:          DAYS_COLOR(s.last_sale_days),
      }));
  }, [styles]);

  // Portfolio status donut — colors assigned by name before filtering so zero-count
  // buckets don't shift later slices onto the wrong color.
  const statusDonut = useMemo(() => {
    const healthy  = styles.filter(s => s.action_status === "on_track").length;
    const onReview = styles.filter(s =>
      s.action_status === "at_risk" &&
      ["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    ).length;
    const mktPush = styles.filter(s =>
      s.action_status === "at_risk" &&
      !["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    ).length;
    const overdue = styles.filter(s => s.action_status === "overdue").length;
    // Assign color per named status (not by array index after filtering)
    return [
      { name: `Healthy (${healthy})`,           value: healthy,  fill: STATUS_COLORS["Healthy"] },
      { name: `On Review (${onReview})`,         value: onReview, fill: STATUS_COLORS["On Review"] },
      { name: `Marketing Push (${mktPush})`,     value: mktPush,  fill: STATUS_COLORS["Marketing Push"] },
      { name: `Overdue (${overdue})`,            value: overdue,  fill: STATUS_COLORS["Overdue"] },
    ].filter(d => d.value > 0);
  }, [styles]);

  // At-risk by subcategory
  const atRiskBySub = useMemo(() => {
    const map = {};
    styles.filter(s => s.action_status === "at_risk" || s.action_status === "overdue")
      .forEach(s => { const k = s.subcategory || "—"; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, 10)
      .map(([name, value]) => ({ name: truncate(name, 22), value }));
  }, [styles]);

  // Status by age group — three bars per group matching the three distinct action_status
  // values (on_track/at_risk/overdue), labelled consistently with the donut and KPI cards.
  const statusByAge = useMemo(() => {
    return AGE_GROUPS.map(g => {
      const inGroup = styles.filter(s => {
        const w = ageWeeks(s.launch_date);
        return w !== null && w >= g.min && w <= g.max;
      });
      return {
        label:    g.label.replace("\n", " "),
        Healthy:  inGroup.filter(s => s.action_status === "on_track").length,
        "At Risk": inGroup.filter(s => s.action_status === "at_risk").length,
        Overdue:   inGroup.filter(s => s.action_status === "overdue").length,
      };
    });
  }, [styles]);

  if (loading) return <Loading label="Loading at-risk data…" />;
  if (error)   return <ErrorBox message={error} />;

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const dateSlug = new Date().toISOString().slice(0, 10);

  const handleDownload = () => {
    const atRiskStyles = styles.filter(s => s.action_status === "at_risk" || s.action_status === "overdue");
    const headers = ["Style Name", "Subcategory", "Tier", "Current Stock", "WOC (weeks)", "Last Sale (days)", "Action Status", "Recommended Action"];
    const rows = atRiskStyles.map(s => [
      `"${(s.style_name || "").replace(/"/g, '""')}"`,
      `"${(s.subcategory || "").replace(/"/g, '""')}"`,
      s.tier || "",
      s.current_stock ?? "",
      s.woc !== null && s.woc !== undefined ? s.woc : "",
      s.last_sale_days !== null && s.last_sale_days !== undefined ? s.last_sale_days : "",
      s.action_status || "",
      `"${(s.recommended_action || "").replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `at-risk-styles-${dateSlug}.csv`;
    a.click();
  };

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[22px] font-bold text-foreground">At-Risk Styles &amp; Action Required</h2>
          <p className="text-[13px] text-muted mt-0.5">Underperformers, Slow Movers &amp; Recommended Actions · As at {today}</p>
        </div>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] text-muted hover:text-foreground hover:border-foreground transition-colors bg-white"
        >
          <DownloadSimple size={13} /> Download CSV
        </button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          label="At Risk Styles" value={fmtNum(kpis.atRiskCount)}
          sub={`${kpis.total > 0 ? ((kpis.atRiskCount / kpis.total) * 100).toFixed(1) : 0}% of portfolio`}
          showDelta={false}
        />
        <KPICard
          label="Overdue Styles" value={fmtNum(kpis.overdueCount)}
          sub="Immediate action"
          showDelta={false}
          accent
        />
        <KPICard
          label="On Review" value={fmtNum(kpis.onReviewCount)}
          sub={`${kpis.total > 0 ? ((kpis.onReviewCount / kpis.total) * 100).toFixed(1) : 0}% of portfolio`}
          showDelta={false}
        />
        <KPICard
          label="Stock at Risk" value={`~${fmtNum(Math.round(kpis.stockAtRisk / 500) * 500)} units`}
          sub="Estimated exposure"
          showDelta={false}
        />
        <KPICard
          label="Healthy Styles" value={fmtNum(kpis.healthyCount)}
          sub={`${kpis.total > 0 ? ((kpis.healthyCount / kpis.total) * 100).toFixed(1) : 0}% of portfolio`}
          showDelta={false}
        />
      </div>

      {/* Top 10 exposure + Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 card-white p-5">
          <SectionTitle title="Top 10 At-Risk Styles by Stock Exposure" subtitle="Current Stock Units" />
          <div className="mt-3" style={{ height: 360 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={top10AtRisk} layout="vertical" margin={{ left: 8, right: 120, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} label={{ value: "Current Stock Units", position: "insideBottom", offset: -3, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={160} />
                <Tooltip
                  formatter={(v, n, p) => [fmtNum(v) + " units", "Stock"]}
                  labelFormatter={(l, payload) => `${l} · ${payload?.[0]?.payload?.daysLabel || ""}`}
                />
                <Bar dataKey="stock" radius={[0, 3, 3, 0]}>
                  {top10AtRisk.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="daysLabel" position="right" style={{ fontSize: 9, fill: "#64748b" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Days legend */}
          <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#1a5c38]" /> 0 days since sale</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#d97706]" /> 1–7 days</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#f97316]" /> 8–30 days</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#ef4444]" /> &gt;30 days</span>
          </div>
        </div>

        {/* Portfolio Status donut */}
        <div className="card-white p-5 flex flex-col">
          <SectionTitle title="Portfolio Action Status" />
          <div className="flex-1 flex items-center justify-center mt-2" style={{ minHeight: 280 }}>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={statusDonut}
                  cx="50%" cy="50%"
                  innerRadius={65} outerRadius={100}
                  paddingAngle={3} dataKey="value"
                  label={({ value }) => `${value}`}
                  labelLine={false}
                >
                  {statusDonut.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip formatter={(v, n, p) => [fmtNum(v) + " styles", p.payload.name.replace(/\s*\(.*\)/, "")]} />
                <Legend iconSize={10} formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom row: By subcategory, by age group, priority actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* At-risk by subcategory */}
        <div className="card-white p-5">
          <SectionTitle title="At-Risk Styles by Subcategory" subtitle="No. of At-Risk Styles" />
          <div className="mt-3" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={atRiskBySub} layout="vertical" margin={{ left: 8, right: 40, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={120} />
                <Tooltip formatter={(v) => [fmtNum(v), "At-Risk Styles"]} />
                <Bar dataKey="value" fill="#ef4444" radius={[0, 3, 3, 0]}>
                  <LabelList dataKey="value" position="right" style={{ fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Status by age group */}
        <div className="card-white p-5">
          <SectionTitle title="Status by Style Age Group" subtitle="No. of Styles" />
          <div className="mt-3" style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusByAge} margin={{ bottom: 20, top: 5, left: -10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 10 }} label={{ value: "No. of Styles", angle: -90, position: "insideLeft", offset: 14, fontSize: 9 }} />
                <Tooltip />
                <Legend iconSize={9} formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} />
                <Bar dataKey="Healthy"  fill="#1a5c38" radius={[2, 2, 0, 0]} />
                <Bar dataKey="At Risk"  fill="#d97706" radius={[2, 2, 0, 0]} />
                <Bar dataKey="Overdue"  fill="#ef4444" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Priority Actions panel */}
        <div className="card-white p-5">
          <SectionTitle title="Priority Actions" />
          <div className="mt-3 space-y-3">
            {/* Overdue */}
            <div className="rounded-lg border-l-4 border-[#ef4444] bg-red-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#ef4444]">URGENT</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(kpis.overdueCount)} Overdue styles need immediate review
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#ef4444] tabular-nums">{kpis.overdueCount}</span>
              </div>
            </div>
            {/* At-risk */}
            <div className="rounded-lg border-l-4 border-[#d97706] bg-amber-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#d97706]">ACTION NEEDED</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(kpis.atRiskCount)} styles: marketing push or price review needed
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#d97706] tabular-nums">{kpis.atRiskCount}</span>
              </div>
            </div>
            {/* On review */}
            <div className="rounded-lg border-l-4 border-[#4b7bec] bg-blue-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#4b7bec]">MONITOR</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(kpis.onReviewCount)} styles on review — monitor weekly
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#4b7bec] tabular-nums">{kpis.onReviewCount}</span>
              </div>
            </div>
            {/* Healthy */}
            <div className="rounded-lg border-l-4 border-[#1a5c38] bg-emerald-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#1a5c38]">HEALTHY</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(kpis.healthyCount)} styles healthy — maintain replenishment
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#1a5c38] tabular-nums">{kpis.healthyCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MerchAtRisk;
