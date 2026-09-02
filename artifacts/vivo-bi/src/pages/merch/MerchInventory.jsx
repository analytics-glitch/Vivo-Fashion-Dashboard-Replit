/**
 * Inventory & Stock Health tab — Merchandising Hub
 * Consolidates the former Inventory & Stock Health and Replenishment
 * Planning tabs (Task 1286; renamed from "Inventory & Replenishment" in
 * Task 1324 — the merch-inventory pageId is unchanged), organised in two
 * sections:
 *   1. Inventory & Stock Health — stock KPIs, Stock Mix drill-down,
 *      top stock styles, Avg WOC by subcategory, brand/recency/tier charts
 *   2. Replenishment Planning — velocity/reorder KPIs, high-velocity WOC,
 *      velocity distribution, reorder by tier, WOC bucket mix
 * The near-identical "Avg WOC by Subcategory" chart and the duplicated
 * zero-stock KPI from the source tabs appear exactly once. Both sections
 * share ONE fetch of the five /api/merch/* aggregates.
 *
 * API contracts:
 *   summary  → { total_styles, total_stock_units, avg_woc, woc_gt20_count,
 *                woc_lt3_active_count, no_sale_7d_active_count,
 *                no_sale_30d_count (retired-scoped), zero_stock_count,
 *                weekly_velocity, woc_lt4_count, ... }
 *   styles   → { styles: [...] }   each row: current_stock, woc, weekly_avg,
 *               reorder_count, last_sale_days, full_price_pct, subcategory,
 *               brand, tier
 *   by-brand → { rows: [{ brand, current_stock, avg_woc }] }
 *   by-subcategory → { rows: [{ subcategory, avg_woc }] }
 *   by-tier  → { rows: [{ tier, current_stock }] }
 */
import React, { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Cell, PieChart, Pie, Legend, LabelList,
  ReferenceLine, ComposedChart, Line,
} from "recharts";
import { Loading, ErrorBox } from "@/components/common";
import {
  useMerchData, useMerchParams, MerchKPICard, ChartCard, SubcatFilter,
  C, fmtNum, fmtWoc, fmtPct1, wocColor,
} from "./MerchHelpers";
import { api, fmtDec } from "@/lib/api";
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
const STOCK_TIER_RADIAN = Math.PI / 180;

// External callout for the Stock by Tier donut. The connector is drawn here
// rather than by Recharts' default label line so the text can include the
// segment's name, units, and percentage in the segment colour.
const renderStockTierLabel = ({
  cx, cy, midAngle, outerRadius, name, fill, payload,
}) => {
  const angle = -midAngle * STOCK_TIER_RADIAN;
  const startX = cx + outerRadius * Math.cos(angle);
  const startY = cy + outerRadius * Math.sin(angle);
  const elbowRadius = outerRadius + 14;
  const elbowX = cx + elbowRadius * Math.cos(angle);
  const elbowY = cy + elbowRadius * Math.sin(angle);
  const rightSide = elbowX >= cx;
  const labelX = elbowX + (rightSide ? 8 : -8);
  const color = payload?.color || fill || C.muted;
  const pct = Number(payload?.pct || 0).toFixed(1);
  return (
    <g>
      <path
        d={`M${startX},${startY} L${elbowX},${elbowY} L${labelX},${elbowY}`}
        stroke={color}
        strokeWidth={1}
        fill="none"
      />
      <circle cx={startX} cy={startY} r={2} fill={color} />
      <text
        x={labelX + (rightSide ? 2 : -2)}
        y={elbowY}
        textAnchor={rightSide ? "start" : "end"}
        dominantBaseline="central"
        fill={color}
        style={{ fontSize: 8.5, fontWeight: 700 }}
      >
        {`${name} · ${fmtNum(payload?.value)} units · ${pct}%`}
      </text>
    </g>
  );
};

// ── Replenishment section helpers (from the retired Replenishment tab) ──────
const WOC_COLOR = (woc) => {
  if (woc === null || woc === undefined) return "#94a3b8";
  if (woc < 4)  return "#ef4444";
  if (woc <= 8) return "#d97706";
  return "#1a5c38";
};

const REPLEN_TIER_COLORS = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3": "#0891b2", "Tier 4": "#d97706" };
const STYLE_TIER_ORDER = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];

const truncate = (s, n = 22) => s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "—");

const WOC_BUCKETS = [
  { key: "woc_0_4",   label: "0–4 wks",   min: 0,  max: 4,  fill: "#EF4444" },
  { key: "woc_4_8",   label: "4–8 wks",   min: 4,  max: 8,  fill: "#F59E0B" },
  { key: "woc_8_12",  label: "8–12 wks",  min: 8,  max: 12, fill: "#EAB308" },
  { key: "woc_12_20", label: "12–20 wks", min: 12, max: 20, fill: "#22C55E" },
  { key: "woc_20_plus", label: "20+ wks", min: 20, max: Infinity, fill: "#475569" },
];

const VEL_BUCKETS = [
  { label: "0–5 /wk",    min: 0,   max: 5 },
  { label: "5–20 /wk",   min: 5,   max: 20 },
  { label: "20–50 /wk",  min: 20,  max: 50 },
  { label: "50–100 /wk", min: 50,  max: 100 },
  { label: "100+ /wk",   min: 100, max: Infinity },
];

const VEL_COLORS = ["#94a3b8", "#4b7bec", "#1a5c38", "#d97706", "#ef4444"];

export default function MerchInventory() {
  const [localSubcat, setLocalSubcat] = useState(null);
  // Active-only is the reliable default. The switch is owned here (rather than
  // inside the table) because changing it must refetch server-filtered totals,
  // categories, styles and colours — a client-only hide leaves parents wrong.
  const [showRetiredStockMix, setShowRetiredStockMix] = useState(false);
  const [stockMixRangeDays, setStockMixRangeDays] = useState(90);
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"], localSubcat);
  // Fetched separately so the (heavier) drill-down tree never blocks the KPI
  // band + charts; the section renders its own skeleton / error state.
  const stockMixPeriod = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - stockMixRangeDays + 1);
    return {
      from_date: from.toISOString().slice(0, 10),
      to_date: to.toISOString().slice(0, 10),
    };
  }, [stockMixRangeDays]);
  const mixState = useMerchData(
    ["stock-mix"],
    localSubcat,
    {
      include_retired: showRetiredStockMix,
      ...stockMixPeriod,
    },
  );
  // Exact params useMerchData sends (incl. tab-local subcategory override) —
  // reused by the KPI CSV downloads so the file matches the on-card scope.
  const merchParams = useMerchParams(localSubcat);

  // Authenticated blob download (plain <a href> drops auth in the preview
  // iframe) — same pattern as Store Feedback's export.
  const downloadKpiCsv = (kpiId, fileLabel) => async () => {
    const r = await api.get("/merch/export/kpi.csv", {
      params: { kpi: kpiId, ...merchParams },
      responseType: "blob",
      forceFresh: true,
    });
    const url = URL.createObjectURL(new Blob([r.data], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // styles → { styles: [...] }
  const styleRows = useMemo(() => styles?.styles || [], [styles]);

  // Row counts for the KPI CSV downloads — shown as "· N rows" on the button.
  // Mirrors the server's _KPI_BUCKETS (merch_router.py; keep in lockstep):
  // total_stock/avg_woc export the raw (non-deduped) style rows, so count the
  // same client-held rows; the four count-style KPIs export exactly the
  // deduped style set behind the on-card summary counts, so reuse those
  // counts verbatim. null (data not loaded yet) hides the suffix.
  const kpiCsvCounts = useMemo(() => {
    const sm = summary || {};
    return {
      total_stock: styles?.styles ? styleRows.length : null,
      avg_woc:     styles?.styles
        ? styleRows.filter(r => r.woc !== null && r.woc !== undefined).length
        : null,
      woc_gt20:    sm.woc_gt20_count ?? null,
      woc_lt3:     sm.woc_lt3_active_count ?? null,
      no_sale_7d:  sm.no_sale_7d_active_count ?? null,
      no_sale_30d: sm.no_sale_30d_count ?? null,
    };
  }, [styles, styleRows, summary]);

  // Top 20 styles by current_stock, colour-coded by WOC risk
  const topStock = useMemo(() =>
    [...styleRows]
      .sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))
      .slice(0, 20)
      .map((r) => ({
        ...r,
        _wocColor:  wocColor(r.woc),
        stockLabel: fmtNum(r.current_stock),
      })),
    [styleRows]);

  // Avg WOC by Subcategory — ALL subcats except Men's + Accessories,
  // sorted asc (highest risk / shortest cover first), coloured by WOC risk band.
  // \bmen'?s\b matches "Men's Tops" but NOT "Women's Tops" (no word
  // boundary inside "Women's").
  const subcatWoc = useMemo(() => {
    if (!bySubcategory?.rows) return [];
    const mens = /\bmen'?s\b/i;
    const riskColor = (w) =>
      Number(w) >= 16 ? C.red : Number(w) >= 8 ? C.amber : C.green;
    return [...bySubcategory.rows]
      .filter((r) => r.avg_woc != null)
      .filter((r) => (r.category || "") !== "Accessories" && !mens.test(r.subcategory || ""))
      .sort((a, b) => (a.avg_woc || 0) - (b.avg_woc || 0))
      .map((r) => ({ ...r, color: riskColor(r.avg_woc) }));
  }, [bySubcategory]);

  // Current stock by brand
  // "Safari by Vivo" is the same brand as "Safari" — merge its units in
  // (display-level merge for this chart; the brand filter still lists both).
  const brandStock = useMemo(() => {
    if (!byBrand?.rows) return [];
    const merged = {};
    for (const r of byBrand.rows) {
      const raw = (r.brand || "—").trim();
      const name = raw.toLowerCase() === "safari by vivo" ? "Safari" : raw;
      if (!merged[name]) merged[name] = { brand: name, current_stock: 0 };
      merged[name].current_stock += r.current_stock || 0;
    }
    const rows = Object.values(merged).sort((a, b) => b.current_stock - a.current_stock);
    const total = rows.reduce((s, r) => s + r.current_stock, 0);
    return rows.map((r) => ({
      ...r,
      pct: total > 0 ? (r.current_stock / total) * 100 : 0,
    }));
  }, [byBrand]);

  // Active styles only (Tier 1–4). The API normally maps retired styles to a
  // Retired tier, but keep the lifecycle-status exclusion explicit so this
  // client-side universe remains correct for cached/legacy payloads too.
  const activeStyleRows = useMemo(
    () => styleRows.filter((r) => {
      const tier = String(r.tier || "").trim();
      const lifecycleStatus = String(
        r.status ?? r.lifecycle_status ?? r.lifecycle ?? r.life_cycle ?? ""
      ).trim().toLowerCase();
      return /^Tier [1-4]$/.test(tier)
        && lifecycleStatus !== "retired"
        && lifecycleStatus !== "archived";
    }),
    [styleRows]);

  const recencyBucketLabel = (d) => {
    if (d === null || d === undefined) return "No sale >90d";
    if (d <= 7)  return "Sold in last 7d";
    if (d <= 30) return "Sold 8-30d ago";
    if (d <= 60) return "Sold 31-60d ago";
    if (d <= 90) return "Sold 61-90d ago";
    return "No sale >90d";
  };

  // Active styles by last sale recency — from activeStyleRows.last_sale_days
  const recencyData = useMemo(() => {
    const buckets = { "7d": 0, "8_30d": 0, "31_60d": 0, "61_90d": 0, "gt_90d": 0 };
    for (const r of activeStyleRows) {
      const d = r.last_sale_days;
      if (d === null || d === undefined) { buckets["gt_90d"]++; continue; }
      if (d <= 7)       buckets["7d"]++;
      else if (d <= 30) buckets["8_30d"]++;
      else if (d <= 60) buckets["31_60d"]++;
      else if (d <= 90) buckets["61_90d"]++;
      else              buckets["gt_90d"]++;
    }
    const total = activeStyleRows.length;
    const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
    return [
      { name: "Sold in\nlast 7d",  value: buckets["7d"],     pct: pct(buckets["7d"]),     color: RECENCY_COLORS[0] },
      { name: "Sold 8-30d\nago",   value: buckets["8_30d"],  pct: pct(buckets["8_30d"]),  color: RECENCY_COLORS[1] },
      { name: "Sold 31-60d\nago",  value: buckets["31_60d"], pct: pct(buckets["31_60d"]), color: RECENCY_COLORS[2] },
      { name: "Sold 61-90d\nago",  value: buckets["61_90d"], pct: pct(buckets["61_90d"]), color: RECENCY_COLORS[3] },
      { name: "No sale\n>90d",     value: buckets["gt_90d"], pct: pct(buckets["gt_90d"]), color: RECENCY_COLORS[4] },
    ];
  }, [activeStyleRows]);

  // Active style count and share by lifecycle tier. Keep zero-count tiers in
  // the data so the chart always presents the complete Tier 1–4 portfolio.
  const stylesByTier = useMemo(() => {
    const counts = Object.fromEntries(STYLE_TIER_ORDER.map((tier) => [tier, 0]));
    activeStyleRows.forEach((r) => {
      if (counts[r.tier] !== undefined) counts[r.tier] += 1;
    });
    const total = activeStyleRows.length;
    return STYLE_TIER_ORDER.map((tier) => ({
      tier,
      count: counts[tier],
      pct: total > 0 ? (counts[tier] / total) * 100 : 0,
      fill: REPLEN_TIER_COLORS[tier],
    }));
  }, [activeStyleRows]);

  // Per-style CSV behind the recency chart (client-side, Overview pattern).
  const downloadRecencyCsv = () => {
    const headers = [
      "Style Name", "Style Number", "Brand", "Subcategory", "Tier",
      "Current Stock", "WOC (weeks)", "Last Sale Date", "Last Sale (days)",
      "Recency Bucket",
    ];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = activeStyleRows.map((r) => [
      q(r.style_name), q(r.style_number), q(r.brand), q(r.subcategory),
      r.tier || "",
      r.current_stock ?? "", r.woc ?? "", r.last_sale_date || "",
      r.last_sale_days ?? "", q(recencyBucketLabel(r.last_sale_days)),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Active_Styles_Last_Sale_Recency_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Stock by Tier pie — from by-tier rows
  // Stock by Tier pie — Archived styles excluded; % = share of charted units.
  const tierStockPie = useMemo(() => {
    if (!byTier?.rows) return [];
    const rows = byTier.rows.filter(
      (r) => (r.tier || "").toLowerCase() !== "archived");
    const total = rows.reduce((s, r) => s + (r.current_stock || 0), 0);
    return rows.map((r, i) => ({
      name:  r.tier,
      value: r.current_stock || 0,
      pct:   total > 0 ? ((r.current_stock || 0) / total) * 100 : 0,
      color: TIER_COLORS[i] || C.muted,
    }));
  }, [byTier]);

  const wocLegend = [
    { label: "WOC < 8 wks",  color: C.green },
    { label: "WOC 8-16 wks", color: C.amber },
    { label: "WOC > 16 wks", color: C.teal },
  ];

  // ── Replenishment derivations (from the retired Replenishment tab) ──────

  // Replenishment KPIs — ACTIVE styles only (Tier 1–4, same universe as the
  // recency chart). Velocity uses the summary's active_weekly_velocity so it
  // matches the Overview; the WOC buckets + avg reorder are computed from the
  // client-held active rows so each card's CSV exports exactly its own rows.
  const replenKpis = useMemo(() => {
    if (!summary) return {};
    const act  = activeStyleRows;
    const nAct = act.length;
    const lt4Rows = act.filter(r => r.woc !== null && r.woc < 4);
    const b48Rows = act.filter(r => r.woc !== null && r.woc >= 4 && r.woc <= 8);
    return {
      totalVelocity: summary.active_weekly_velocity || 0,
      wocLt4:  lt4Rows.length,
      pctLt4:  nAct ? (lt4Rows.length / nAct) * 100 : 0,
      wocLt8:  b48Rows.length,
      pctLt8:  nAct ? (b48Rows.length / nAct) * 100 : 0,
      avgReorder: nAct
        ? act.reduce((acc, r) => acc + (r.reorder_count || 0), 0) / nAct
        : 0,
      lt4Rows,
      b48Rows,
    };
  }, [summary, activeStyleRows]);

  // Replen KPI CSVs — one shared 9-column schema, rows/sort vary per card.
  const downloadReplenCsv = (rows, fileLabel) => () => {
    const headers = [
      "Style Name", "Style Number", "Brand", "Subcategory", "Tier",
      "Current Stock", "WOC (weeks)", "Weekly Velocity", "Reorder Count",
    ];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = rows.map((r) => [
      q(r.style_name), q(r.style_number), q(r.brand), q(r.subcategory),
      r.tier || "", r.current_stock ?? "", r.woc ?? "",
      r.weekly_avg ?? "", r.reorder_count ?? "",
    ]);
    const csv = [headers.join(","), ...body.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // High-velocity top 15 sorted by weekly_avg desc
  // High-velocity top 20 — only styles with WOC < 7 (the reorder-pressure
  // zone); full name kept, the axis tick truncates to a single line.
  const highVelData = useMemo(() => {
    const lowCover = styleRows.filter(
      r => r.weekly_avg > 0 && r.woc !== null && r.woc < 7);
    return [...lowCover].sort((a, b) => (b.weekly_avg || 0) - (a.weekly_avg || 0))
      .slice(0, 20)
      .map(r => ({
        name:  r.style_name || "",
        woc:   r.woc,
        fill:  WOC_COLOR(r.woc),
        label: `${fmtNum(r.current_stock)} (${fmtDec(r.woc, 1)}w)`,
        vel:   r.weekly_avg,
      }));
  }, [styleRows]);

  // Velocity distribution
  const velDistData = useMemo(() => {
    const counts = VEL_BUCKETS.map(b => ({ name: b.label, count: 0 }));
    styleRows.forEach(r => {
      const v = r.weekly_avg || 0;
      const i = VEL_BUCKETS.findIndex(b => v >= b.min && v < b.max);
      if (i >= 0) counts[i].count += 1;
    });
    return counts.map((c, i) => ({ ...c, fill: VEL_COLORS[i] }));
  }, [styleRows]);

  // Reorder count & style count by tier (for ComposedChart)
  const byTierChart = useMemo(() => {
    const map = {};
    styleRows.forEach(r => {
      const t = r.tier;
      if (!STYLE_TIER_ORDER.includes(t)) return;
      if (!map[t]) map[t] = { tier: t, reorder_sum: 0, count: 0 };
      map[t].reorder_sum += (r.reorder_count || 0);
      map[t].count += 1;
    });
    return STYLE_TIER_ORDER.filter(t => map[t])
      .map(t => ({
        tier:    t,
        avg_reo: parseFloat((map[t].reorder_sum / map[t].count).toFixed(1)),
        count:   map[t].count,
        fill:    REPLEN_TIER_COLORS[t] || "#94a3b8",
      }));
  }, [styleRows]);

  // WOC bucket mix — stock-unit distribution, ordered from highest risk to
  // lowest risk/overstocked. Percentages therefore describe the stock split,
  // not the number of styles in each bucket.
  const wocDonut = useMemo(() => {
    const counts = WOC_BUCKETS.map(b => ({
      key: b.key, name: b.label, value: 0, fill: b.fill,
    }));
    styleRows.forEach(r => {
      if (r.woc === null) return;
      const i = WOC_BUCKETS.findIndex(b => r.woc >= b.min && r.woc < b.max);
      if (i >= 0) counts[i].value += Number(r.current_stock) || 0;
    });
    const total = counts.reduce((sum, row) => sum + row.value, 0);
    return counts
      .filter(c => c.value > 0)
      .map(c => ({ ...c, pct: total > 0 ? (c.value / total) * 100 : 0 }));
  }, [styleRows]);

  const wocStackData = useMemo(() => [{
    name: "Stock",
    ...Object.fromEntries(wocDonut.map(d => [d.key, d.value])),
  }], [wocDonut]);

  if (loading) return <Loading label="Loading Inventory & Stock Health…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};
  const total = s.total_styles || 0;
  // Risk KPIs are lifecycle-scoped (active vs retired), so their % pills use
  // the matching universe as denominator — not the whole portfolio.
  const activeCt  = s.active_styles_count  || 0;
  const retiredCt = s.retired_styles_count || 0;
  const overstockPct = activeCt ? ((s.woc_gt20_count || 0) / activeCt * 100).toFixed(1) : "0";
  const lowCoverPct  = activeCt ? ((s.woc_lt3_active_count || 0) / activeCt * 100).toFixed(1) : "0";
  const noSale7Pct   = activeCt ? ((s.no_sale_7d_active_count || 0) / activeCt * 100).toFixed(1) : "0";
  const noSalePct    = retiredCt ? ((s.no_sale_30d_count || 0) / retiredCt * 100).toFixed(1) : "0";

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[11px] text-slate-400">
          Stock Levels, Weeks of Cover, Risk Flags &amp; Replenishment Planning
        </div>
        <SubcatFilter value={localSubcat} onChange={setLocalSubcat} />
      </div>

      {/* ── Replenishment Planning KPIs (moved to page top; active styles) ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MerchKPICard
          label="Total Weekly Velocity"
          value={`${fmtNum(Math.round(replenKpis.totalVelocity || 0))} /wk`}
          sub="Across active styles"
          accentColor={C.blue}
          testId="merch-replen-kpi-vel"
          onDownload={downloadReplenCsv(
            [...activeStyleRows].sort((a, b) => (b.weekly_avg || 0) - (a.weekly_avg || 0)),
            "Active_Weekly_Velocity")}
          downloadCount={activeStyleRows.length}
        />
        <MerchKPICard
          label="Styles WOC < 4 wks"
          value={`${fmtNum(replenKpis.wocLt4)} styles`}
          sub={replenKpis.pctLt4 != null ? `${replenKpis.pctLt4.toFixed(1)}% of active styles` : "—"}
          sub2="Urgent reorder needed"
          accentColor={C.red}
          testId="merch-replen-kpi-woc4"
          onDownload={downloadReplenCsv(
            [...(replenKpis.lt4Rows || [])].sort((a, b) => (a.woc ?? 0) - (b.woc ?? 0)),
            "Active_Styles_WOC_under_4")}
          downloadCount={replenKpis.lt4Rows ? replenKpis.lt4Rows.length : null}
        />
        <MerchKPICard
          label="Styles WOC 4–8 wks"
          value={`${fmtNum(replenKpis.wocLt8)} styles`}
          sub={replenKpis.pctLt8 != null ? `${replenKpis.pctLt8.toFixed(1)}% of active styles` : "—"}
          sub2="Reorder soon"
          accentColor={C.amber}
          testId="merch-replen-kpi-woc8"
          onDownload={downloadReplenCsv(
            [...(replenKpis.b48Rows || [])].sort((a, b) => (a.woc ?? 0) - (b.woc ?? 0)),
            "Active_Styles_WOC_4_to_8")}
          downloadCount={replenKpis.b48Rows ? replenKpis.b48Rows.length : null}
        />
        <MerchKPICard
          label="Avg Reorder Count"
          value={`${fmtDec(replenKpis.avgReorder || 0, 1)}×`}
          sub="Per active style"
          accentColor={C.purple}
          testId="merch-replen-kpi-reorder"
          onDownload={downloadReplenCsv(
            [...activeStyleRows].sort((a, b) => (b.reorder_count || 0) - (a.reorder_count || 0)),
            "Active_Styles_Reorder_Count")}
          downloadCount={activeStyleRows.length}
        />
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <MerchKPICard
          label="Total Stock on Hand"
          value={fmtNum(s.total_stock_units)}
          sub={`Active Styles: ${s.active_styles_count != null ? fmtNum(s.active_styles_count) : "—"}`}
          sub2={`Retired Styles: ${s.retired_styles_count != null ? fmtNum(s.retired_styles_count) : "—"}`}
          accentColor={C.blue}
          testId="merch-inv-kpi-stock"
          onDownload={downloadKpiCsv("total_stock", "Total_Stock_on_Hand")}
          downloadCount={kpiCsvCounts.total_stock}
        />
        <MerchKPICard
          label="Avg WOC"
          value={fmtWoc(s.avg_woc)}
          sub="Across active styles"
          accentColor={C.purple}
          testId="merch-inv-kpi-woc"
          onDownload={downloadKpiCsv("avg_woc", "Avg_WOC")}
          downloadCount={kpiCsvCounts.avg_woc}
        />
        <MerchKPICard
          label="Styles WOC > 20"
          value={`${fmtNum(s.woc_gt20_count)} styles`}
          sub={`${overstockPct}% of active styles`}
          accentColor={C.teal}
          testId="merch-inv-kpi-overstock"
          onDownload={downloadKpiCsv("woc_gt20", "Styles_WOC_over_20")}
          downloadCount={kpiCsvCounts.woc_gt20}
        />
        <MerchKPICard
          label="Styles WOC < 3"
          value={`${fmtNum(s.woc_lt3_active_count)} styles`}
          sub={`${lowCoverPct}% of active styles`}
          accentColor={C.red}
          testId="merch-inv-kpi-lowcover"
          onDownload={downloadKpiCsv("woc_lt3", "Styles_WOC_under_3")}
          downloadCount={kpiCsvCounts.woc_lt3}
        />
        <MerchKPICard
          label="Active: No Sale 7d+"
          value={`${fmtNum(s.no_sale_7d_active_count)} styles`}
          sub={`${noSale7Pct}% of active styles`}
          accentColor="#f97316"
          testId="merch-inv-kpi-nosale7"
          onDownload={downloadKpiCsv("no_sale_7d", "Active_No_Sale_7d_plus")}
          downloadCount={kpiCsvCounts.no_sale_7d}
        />
        <MerchKPICard
          label="Retired: No Sale 30d"
          value={`${fmtNum(s.no_sale_30d_count)} styles`}
          sub={`${noSalePct}% of retired styles`}
          accentColor={C.amber}
          testId="merch-inv-kpi-nosale"
          onDownload={downloadKpiCsv("no_sale_30d", "Retired_No_Sale_30d")}
          downloadCount={kpiCsvCounts.no_sale_30d}
        />
      </div>

      {/* ── Portfolio distribution charts — immediately below KPI cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <ChartCard title="Current Stock by Brand">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={brandStock} margin={{ top: 30, right: 8, left: -5, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="brand" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" />
              <YAxis tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v} tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="current_stock" name="Stock Units" fill={C.blue} radius={[4, 4, 0, 0]}>
                <LabelList
                  dataKey="current_stock"
                  position="top"
                  content={({ x, y, width, value, index }) => {
                    const cx = Number(x) + Number(width) / 2;
                    const pct = brandStock[index]?.pct;
                    return (
                      <text x={cx} y={Number(y) - 4} textAnchor="middle" fontSize={9}>
                        <tspan x={cx} dy={-10} fill="#64748b">
                          {pct != null ? `${pct.toFixed(1)}%` : ""}
                        </tspan>
                        <tspan x={cx} dy={10} fontWeight={700} fill="#334155">
                          {fmtNum(value)}
                        </tspan>
                      </text>
                    );
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Active Styles by Tier">
          <div data-testid="styles-by-tier-chart">
            <ResponsiveContainer width="100%" height={290}>
              <BarChart
                data={stylesByTier}
                margin={{ top: 30, right: 8, left: 22, bottom: 8 }}
              >
                <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis
                  dataKey="tier"
                  tick={{ fontSize: 10, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={false}
                  label={{
                    value: "Number of styles",
                    angle: -90,
                    position: "insideLeft",
                    offset: 4,
                    fontSize: 9,
                    fill: "#64748b",
                  }}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0]?.payload;
                    return (
                      <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
                        <div className="font-semibold text-slate-700 mb-1">{label}</div>
                        <div>Styles: <strong>{fmtNum(row?.count)}</strong></div>
                        <div>Share: <strong>{Number(row?.pct || 0).toFixed(1)}%</strong></div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="count" name="Styles" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {stylesByTier.map((entry) => <Cell key={entry.tier} fill={entry.fill} />)}
                  <LabelList
                    dataKey="pct"
                    position="top"
                    content={({ x, y, width, index }) => {
                      const row = stylesByTier[index];
                      if (!row) return null;
                      const cx = Number(x) + Number(width) / 2;
                      return (
                        <text
                          x={cx}
                          y={Number(y) - 7}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight={700}
                          fill={row.fill}
                        >
                          {`${Math.round(row.pct)}%`}
                        </text>
                      );
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard
          title={
            <div className="flex items-center justify-between gap-2">
              <span>Active Styles by Last Sale Recency</span>
              <button
                type="button"
                onClick={downloadRecencyCsv}
                className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                data-testid="recency-csv-btn"
              >
                Download CSV · {activeStyleRows.length} rows
              </button>
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={recencyData} margin={{ top: 30, right: 8, left: -10, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="value" name="Styles" radius={[4, 4, 0, 0]}>
                {recencyData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList
                  dataKey="value"
                  position="top"
                  content={({ x, y, width, value, index }) => {
                    const cx = Number(x) + Number(width) / 2;
                    const pct = recencyData[index]?.pct;
                    return (
                      <text x={cx} y={Number(y) - 4} textAnchor="middle" fontSize={9}>
                        <tspan x={cx} dy={-10} fill="#64748b">
                          {pct != null ? `${pct.toFixed(1)}%` : ""}
                        </tspan>
                        <tspan x={cx} dy={10} fontWeight={700} fill="#334155" fontSize={11}>
                          {fmtNum(value)}
                        </tspan>
                      </text>
                    );
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stock by Tier">
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={tierStockPie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={58}
                innerRadius={31}
                paddingAngle={2}
                label={renderStockTierLabel}
                labelLine={false}
                isAnimationActive={false}
              >
                {tierStockPie.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip
                formatter={(val, name) => [`${fmtNum(val)} units`, name]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }}
              />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Stock Mix drill-down (Category → Sub Category → Style → Colour) ── */}
      <MerchStockMix
        data={mixState.stockMix}
        loading={mixState.loading}
        error={mixState.error}
        showRetired={showRetiredStockMix}
        onShowRetiredChange={setShowRetiredStockMix}
        rangeDays={stockMixRangeDays}
        onRangeDaysChange={setStockMixRangeDays}
      />

      {/* ── Top stock + Avg WOC by Subcat ──
          The subcategory WOC chart is intentionally full-width so every
          category label can sit along the horizontal axis. */}
      <div className="space-y-4">
        <ChartCard title="Top 20 Styles by Current Stock (colour = WOC risk)">
          <div className="flex gap-3 mb-2">
            {wocLegend.map((l, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
                <span className="text-[9px] text-slate-500">{l.label}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={390}>
            <BarChart
              data={topStock}
              margin={{ top: 22, right: 24, left: 8, bottom: 84 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="style_name"
                interval={0}
                angle={-45}
                textAnchor="end"
                height={84}
                tick={{ fontSize: 8.5, fill: "#64748b" }}
                tickLine={false}
                tickFormatter={(v) => truncate(v, 24)}
              />
              <YAxis
                tickFormatter={fmtNum}
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickLine={false}
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
              <Bar dataKey="current_stock" name="Current Stock" radius={[3, 3, 0, 0]}>
                {topStock.map((entry, i) => <Cell key={i} fill={entry._wocColor} />)}
                <LabelList
                  dataKey="stockLabel"
                  position="top"
                  style={{ fontSize: 9, fill: "#64748b" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Avg WOC by Subcategory (colour = risk · excl. Men's & Accessories)">
          <div className="flex gap-3 mb-2">
            {[
              { label: "Healthy (< 8 wks)",    color: C.green },
              { label: "Elevated (8–16 wks)",  color: C.amber },
              { label: "At risk (≥ 16 wks)",   color: C.red },
            ].map((l, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
                <span className="text-[9px] text-slate-500">{l.label}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={390}>
            <BarChart
              data={subcatWoc}
              margin={{ top: 22, right: 24, left: 8, bottom: 82 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="subcategory"
                interval={0}
                angle={-45}
                textAnchor="end"
                height={82}
                tick={{ fontSize: 9, fill: "#64748b" }}
                tickLine={false}
              />
              <YAxis
                domain={[0, "auto"]}
                tickFormatter={(v) => `${v}w`}
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickLine={false}
                label={{
                  value: "Average WOC (weeks)",
                  angle: -90,
                  position: "insideLeft",
                  offset: 8,
                  fontSize: 9,
                  fill: "#64748b",
                }}
              />
              <ReferenceLine
                y={12}
                stroke="#94a3b8"
                strokeDasharray="4 3"
                label={{ value: "Target 12 wks", position: "insideTopRight", fontSize: 9, fill: "#94a3b8" }}
              />
              <Tooltip content={<WocTooltip />} />
              <Bar dataKey="avg_woc" name="Avg WOC" radius={[3, 3, 0, 0]}>
                {subcatWoc.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                <LabelList
                  dataKey="avg_woc"
                  position="top"
                  formatter={(v) => `${Number(v).toFixed(0)}w`}
                  style={{ fontSize: 9, fill: "#64748b" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ════ Replenishment Planning (from the retired Replenishment tab) ════ */}
      <div className="border-t border-slate-200 pt-5">
        <h2 className="text-[18px] font-bold text-foreground">Replenishment Planning</h2>
        <p className="text-[13px] text-muted mt-0.5">Stock Coverage, Velocity &amp; Reorder Prioritisation</p>
      </div>

      {/* ── High-Velocity WOC + WOC Bucket Mix ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Top 20 High-Velocity Styles — Current WOC (< 7 wks only)">
          <div className="mt-1" style={{ height: 520 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={highVelData} layout="vertical" margin={{ left: 8, right: 100, top: 4, bottom: 4 }}>
                <XAxis type="number" domain={[0, 'auto']} tick={{ fontSize: 10 }}
                  label={{ value: "Weeks of Cover (WOC)", position: "insideBottom", offset: -3, fontSize: 10 }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={180}
                  interval={0}
                  /* Single-line tick: plain SVG <text> never word-wraps (recharts'
                     default tick wraps long names onto two rows). Truncate at 38
                     chars; the tooltip shows the full name. */
                  tick={({ x, y, payload }) => {
                    const v = String(payload.value ?? "");
                    const label = v.length > 38 ? v.slice(0, 38) + "…" : v;
                    return (
                      <text x={x} y={y} dy={3} textAnchor="end" fontSize={9} fill="#64748b">
                        {label}
                      </text>
                    );
                  }}
                />
                <Tooltip formatter={(v, n, p) => [
                  v !== null ? `${fmtDec(v, 1)} weeks` : "No WOC",
                  `WOC (${p.payload.vel !== undefined ? fmtDec(p.payload.vel, 1) + ' /wk' : '—'})`
                ]} />
                <ReferenceLine x={4} stroke="#ef4444" strokeDasharray="5 3" label={{ value: "Urgent 4 wks", position: "top", fontSize: 9, fill: "#ef4444" }} />
                <Bar dataKey="woc" radius={[0, 3, 3, 0]}>
                  {highVelData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  <LabelList dataKey="label" position="right" style={{ fontSize: 9, fill: "#475569" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10.5px] text-muted flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#ef4444]" /> &lt; 4 wks (urgent)</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded inline-block bg-[#d97706]" /> 4–7 wks</span>
          </div>
        </ChartCard>

        <ChartCard title="WOC Bucket Mix">
          <div className="mt-2">
            <ResponsiveContainer width="100%" height={118}>
              <BarChart
                data={wocStackData}
                layout="vertical"
                margin={{ top: 18, right: 8, bottom: 18, left: 8 }}
              >
                <XAxis type="number" domain={[0, "dataMax"]} hide />
                <YAxis type="category" dataKey="name" hide />
                <Tooltip
                  formatter={(value, key) => {
                    const bucket = wocDonut.find(d => d.key === key);
                    return [`${fmtNum(value)} units`, bucket?.name || key];
                  }}
                  contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                {wocDonut.map((bucket, index) => (
                  <Bar
                    key={bucket.key}
                    dataKey={bucket.key}
                    stackId="woc-stock"
                    fill={bucket.fill}
                    barSize={68}
                    isAnimationActive={false}
                    radius={
                      index === 0
                        ? [5, 0, 0, 5]
                        : index === wocDonut.length - 1
                          ? [0, 5, 5, 0]
                          : 0
                    }
                  >
                    <LabelList
                      position="center"
                      content={({ x, y, width, height }) => (
                        <text
                          x={Number(x) + Number(width) / 2}
                          y={Number(y) + Number(height) / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={8.5}
                          fontWeight={700}
                          fill={index < 2 ? "#fff" : "#1e293b"}
                        >
                          {`${bucket.name} · ${bucket.pct.toFixed(0)}%`}
                        </text>
                      )}
                    />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-5 gap-1 mt-1 text-center text-[9px] text-slate-500">
            {wocDonut.map((bucket) => (
              <div key={bucket.key} className="min-w-0">
                <div className="font-semibold text-slate-600">{fmtNum(bucket.value)} units</div>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {/* ── Velocity distribution + Reorder by Tier ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Weekly Velocity Distribution">
          <ResponsiveContainer width="100%" height={280}>
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
        </ChartCard>

        <ChartCard title="Reorder Count & Style Count by Tier">
          <ResponsiveContainer width="100%" height={280}>
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
        </ChartCard>
      </div>
    </div>
  );
}
