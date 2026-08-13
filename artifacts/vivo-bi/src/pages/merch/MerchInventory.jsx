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

// ── Replenishment section helpers (from the retired Replenishment tab) ──────
const WOC_COLOR = (woc) => {
  if (woc === null || woc === undefined) return "#94a3b8";
  if (woc < 4)  return "#ef4444";
  if (woc <= 8) return "#d97706";
  return "#1a5c38";
};

const REPLEN_TIER_COLORS = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3": "#0891b2", "Tier 4": "#d97706" };

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

export default function MerchInventory() {
  const [localSubcat, setLocalSubcat] = useState(null);
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"], localSubcat);
  // Fetched separately so the (heavier) drill-down tree never blocks the KPI
  // band + charts; the section renders its own skeleton / error state.
  const mixState = useMerchData(["stock-mix"], localSubcat);
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
        stockLabel: `${fmtNum(r.current_stock)} (${r.woc != null ? Number(r.woc).toFixed(0) + "w" : "—"})`,
      })),
    [styleRows]);

  // Avg WOC by Subcategory — ALL subcats except Men's + Accessories,
  // sorted desc (highest risk on top), coloured by WOC risk band.
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
      .sort((a, b) => (b.avg_woc || 0) - (a.avg_woc || 0))
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

  // Active styles only (tier Tier 1–4 — mirrors the summary's Active
  // definition; Retired/Archived excluded) for the recency chart + its CSV.
  const activeStyleRows = useMemo(
    () => styleRows.filter((r) => /^Tier [1-4]$/.test(r.tier || "")),
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
    const TIER_ORDER = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];
    const map = {};
    styleRows.forEach(r => {
      const t = r.tier;
      if (!TIER_ORDER.includes(t)) return;
      if (!map[t]) map[t] = { tier: t, reorder_sum: 0, count: 0 };
      map[t].reorder_sum += (r.reorder_count || 0);
      map[t].count += 1;
    });
    return TIER_ORDER.filter(t => map[t])
      .map(t => ({
        tier:    t,
        avg_reo: parseFloat((map[t].reorder_sum / map[t].count).toFixed(1)),
        count:   map[t].count,
        fill:    REPLEN_TIER_COLORS[t] || "#94a3b8",
      }));
  }, [styleRows]);

  // WOC bucket mix donut
  const wocDonut = useMemo(() => {
    const counts = WOC_BUCKETS.map(b => ({ name: b.label, value: 0, fill: b.fill }));
    styleRows.forEach(r => {
      if (r.woc === null) return;
      const i = WOC_BUCKETS.findIndex(b => r.woc >= b.min && r.woc < b.max);
      if (i >= 0) counts[i].value += 1;
    });
    return counts.filter(c => c.value > 0);
  }, [styleRows]);

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

      {/* ── Stock Mix drill-down (Category → Sub Category → Style → Colour) ── */}
      <MerchStockMix
        data={mixState.stockMix}
        loading={mixState.loading}
        error={mixState.error}
      />

      {/* ── Top 20 stock + Avg WOC by Subcat ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Top 20 Styles by Current Stock (colour = WOC risk)">
          <div className="flex gap-3 mb-2">
            {wocLegend.map((l, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
                <span className="text-[9px] text-slate-500">{l.label}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={520}>
            <BarChart
              data={topStock}
              layout="vertical"
              margin={{ top: 0, right: 85, left: 190, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtNum} tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="style_name"
                width={190}
                interval={0}
                /* Single-line tick: plain SVG <text> never word-wraps (recharts'
                   default tick wraps long names onto two rows). Truncate at 42
                   chars; the tooltip shows the full name. */
                tick={({ x, y, payload }) => {
                  const v = String(payload.value ?? "");
                  const label = v.length > 42 ? v.slice(0, 42) + "…" : v;
                  return (
                    <text x={x} y={y} dy={3} textAnchor="end" fontSize={9} fill="#64748b">
                      {label}
                    </text>
                  );
                }}
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
                {topStock.map((entry, i) => <Cell key={i} fill={entry._wocColor} />)}
                <LabelList
                  dataKey="stockLabel"
                  position="right"
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
          <ResponsiveContainer width="100%" height={Math.max(300, subcatWoc.length * 24 + 40)}>
            <BarChart
              data={subcatWoc}
              layout="vertical"
              margin={{ top: 0, right: 50, left: 140, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="subcategory"
                width={140}
                interval={0}
                /* Single-line tick (plain SVG <text> never word-wraps). */
                tick={({ x, y, payload }) => {
                  const v = String(payload.value ?? "");
                  const label = v.length > 30 ? v.slice(0, 30) + "…" : v;
                  return (
                    <text x={x} y={y} dy={3} textAnchor="end" fontSize={9} fill="#64748b">
                      {label}
                    </text>
                  );
                }}
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
            <BarChart data={brandStock} margin={{ top: 30, right: 8, left: -5, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="brand" tick={{ fontSize: 9 }} interval={0} angle={-20} textAnchor="end" />
              <YAxis tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v} tick={{ fontSize: 10 }} />
              <Tooltip content={<NumTooltip />} />
              <Bar dataKey="current_stock" name="Stock Units" fill={C.blue} radius={[4, 4, 0, 0]}>
                {/* % share on top, units beneath it */}
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
                {/* % share on top, style count beneath it */}
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
              <Legend
                layout="vertical"
                align="right"
                verticalAlign="middle"
                iconSize={10}
                formatter={(v, entry) => {
                  const p = entry?.payload;
                  return (
                    <span style={{ fontSize: 12, color: "#334155" }}>
                      <span style={{ fontWeight: 600 }}>{v}</span>
                      {" · "}{fmtNum(p?.value)} units
                      {" · "}{p?.pct != null ? `${p.pct.toFixed(1)}%` : "—"}
                    </span>
                  );
                }}
              />
            </PieChart>
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
          <div className="flex-1 mt-1 flex items-center justify-center" style={{ minHeight: 380 }}>
            <ResponsiveContainer width="100%" height={380}>
              <PieChart>
                <Pie
                  data={wocDonut}
                  cx="50%" cy="50%"
                  innerRadius={70} outerRadius={110}
                  paddingAngle={3} dataKey="value"
                  label={({ value }) => {
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
