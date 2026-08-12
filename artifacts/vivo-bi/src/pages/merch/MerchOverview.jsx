/**
 * Overview tab — Merchandising Hub
 * Portfolio KPI cards + mix charts, PLUS the full "At-Risk & Actions" section
 * merged in from the retired At-Risk & Actions tab (Task 1286):
 *   • health KPI row (At Risk / Overdue / On Review / Stock at Risk / Healthy)
 *   • Top 10 At-Risk styles by stock exposure (+ last-sale recency legend)
 *   • Portfolio Action Status donut (supersedes the old 3-way Style Status bar)
 *   • At-Risk by Subcategory · Status by Style Age Group
 *   • Priority Actions panel (supersedes the old Recommended Actions summary)
 *   • At-risk CSV export
 *   • Labeled CSV download links on every KPI card — portfolio row via
 *     /api/merch/export/kpi.csv buckets (server-side, count-lockstep);
 *     at-risk row serialises the same client-derived arrays it renders
 * All at-risk derivations reuse the SAME /api/merch/styles rows the overview
 * already fetches — no second fetch.
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
 *                (+ revenue_prev / trend_pct because this page passes trend=1
 *                 — trend is vs the consecutive previous window of equal length)
 *   by-subcategory → same shape with subcategory key
 *   by-tier  → same shape with tier key
 */
import React, { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Cell, PieChart, Pie, Legend, LabelList,
} from "recharts";
import { DownloadSimple } from "@phosphor-icons/react";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import {
  useMerchData, useMerchParams, MerchKPICard, ChartCard, SubcatFilter,
  C, fmtKESM, fmtPct1, fmtNum, fmtAxisM,
} from "./MerchHelpers";
// fmtDate aliased: the component body declares its own local fmtDate helper
import { api, datePresets, fmtDate as fmtDateApi } from "@/lib/api";
import { useFilters } from "@/lib/filters";
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

// Tooltip for the Revenue-by-Brand / Top-5-Subcategories bars: revenue, share
// of total revenue, and trend vs the consecutive previous period (server
// fields revenue_prev / trend_pct — trend_pct is null when the prev window
// had no positive revenue for that bucket).
const ShareTrendTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const r = payload[0]?.payload || {};
  const t = r.trend_pct;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100 leading-4">
      <div className="font-semibold text-slate-700 mb-1 max-w-[200px] truncate">{label}</div>
      <div className="text-slate-500">Revenue: <span className="font-semibold text-slate-800">{fmtKESM(r.revenue_sel || 0)}</span></div>
      <div className="text-slate-500">Share of revenue: <span className="font-semibold text-slate-800">{r.share_pct == null ? "—" : `${r.share_pct.toFixed(1)}%`}</span></div>
      <div className="text-slate-500">
        Prev period: <span className="font-semibold text-slate-800">{fmtKESM(r.revenue_prev || 0)}</span>
        {t == null
          ? <span className="text-slate-400"> · trend n/a</span>
          : <span className={t >= 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold"}> · {t >= 0 ? "▲" : "▼"}{Math.abs(t).toFixed(1)}%</span>}
      </div>
    </div>
  );
};

// Two-line end-of-bar label: revenue on top, "share% · trend" underneath.
// Recharts passes the bar rect (x/y/width/height) + row index; the factory
// closes over the chart's data array to reach share_pct / trend_pct.
const barEndLabel = (rows) => ({ x = 0, y = 0, width = 0, height = 0, index }) => {
  const r = rows[index] || {};
  const tx = x + Math.max(width, 0) + 6;
  const cy = y + height / 2;
  const t = r.trend_pct == null ? null : Math.round(r.trend_pct);
  const share = r.share_pct == null ? "—"
    : `${r.share_pct.toFixed(r.share_pct < 10 ? 1 : 0)}%`;
  return (
    <g>
      <text x={tx} y={cy - 1} fontSize={9} fontWeight={600} fill="#334155">{fmtKESM(r.revenue_sel || 0)}</text>
      <text x={tx} y={cy + 9} fontSize={8.5}>
        <tspan fill="#64748b">{share}</tspan>
        {t == null
          ? <tspan fill="#94a3b8"> · –</tspan>
          : <tspan fill={t >= 0 ? "#16a34a" : "#dc2626"}> · {t >= 0 ? "▲" : "▼"}{Math.abs(t)}%</tspan>}
      </text>
    </g>
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

// ── At-Risk section helpers (from the retired At-Risk & Actions tab) ─────────
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

export default function MerchOverview() {
  const filters = useMerchFilters();
  const [localSubcat, setLocalSubcat] = useState(null);
  const { summary, styles, byBrand, bySubcategory, byTier, loading, error } =
    useMerchData(["summary", "styles", "by-brand", "by-subcategory", "by-tier"], localSubcat,
                 { trend: 1 }); // by-brand/by-subcategory add prev-window trend fields
  // Exact params useMerchData sends (incl. tab-local subcategory override) —
  // reused by the KPI CSV downloads so each file matches its on-card scope.
  const merchParams = useMerchParams(localSubcat);

  // Authenticated blob download (plain <a href> drops auth in the preview
  // iframe) — same pattern as the Inventory tab's KPI card exports.
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

  // ── Chart period label ────────────────────────────────────────────────────
  // Same wording as the global filter bar's date pill: preset label when one
  // is active ("Today", "Last 30 days"…), explicit range for custom dates,
  // and the backend's trailing-6-months default when no dates are applied.
  const { preset: gPreset } = useFilters(); // same field the FilterBar pill reads
  const periodLabel = useMemo(() => {
    const presets = datePresets();
    if (gPreset && gPreset !== "custom" && presets[gPreset]) {
      return presets[gPreset].label;
    }
    const f = filters.from_date, t = filters.to_date;
    if (f && t) return f === t ? fmtDateApi(f) : `${fmtDateApi(f)} – ${fmtDateApi(t)}`;
    return "Last 6 months";
  }, [gPreset, filters.from_date, filters.to_date]);

  // ── Brand data ────────────────────────────────────────────────────────────
  // Charts follow the global date filter: revenue_period is scoped to the
  // selected range (defaults to the trailing 6 months when no dates are set).
  // share_pct = % of the FULL universe's revenue (all brands / all
  // subcategories in scope), not just the sliced top rows shown.
  const selRev = (r) => (r.revenue_period ?? r.revenue_6m) || 0;
  const withShare = (rows, keep) => {
    const mapped = rows.map((r) => ({ ...r, revenue_sel: selRev(r) }));
    const total = mapped.reduce((sum, r) => sum + r.revenue_sel, 0);
    return mapped
      .sort((a, b) => b.revenue_sel - a.revenue_sel)
      .slice(0, keep)
      .map((r) => ({ ...r, share_pct: total > 0 ? (r.revenue_sel / total) * 100 : null }));
  };

  const brandData = useMemo(
    () => (byBrand?.rows ? withShare(byBrand.rows, 6) : []), [byBrand]);

  // ── Top 5 subcategories ───────────────────────────────────────────────────
  const top5SubcatData = useMemo(
    () => (bySubcategory?.rows ? withShare(bySubcategory.rows, 5) : []), [bySubcategory]);

  // ── Tier donut ────────────────────────────────────────────────────────────
  const tierPieData = useMemo(() => {
    if (!byTier?.rows) return [];
    return byTier.rows.map((r, i) => ({
      name:  r.tier,
      value: selRev(r),
      color: TIER_COLOR_ARR[i] || C.muted,
    }));
  }, [byTier]);

  // ── At-Risk KPI derivations (from styles rows — same fetch) ───────────────
  const riskKpis = useMemo(() => {
    const atRisk  = styleRows.filter(s => s.action_status === "at_risk");
    const overdue = styleRows.filter(s => s.action_status === "overdue");
    const healthy = styleRows.filter(s => s.action_status === "on_track");
    // "On Review" mapped from at_risk (those with last_sale_days 60-89 or overstock)
    const onReview = styleRows.filter(s =>
      s.action_status === "at_risk" &&
      ["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    );
    const stockAtRisk = [...atRisk, ...overdue].reduce((acc, s) => acc + (s.current_stock || 0), 0);
    const total = styleRows.length;
    return {
      atRiskCount:  atRisk.length,
      overdueCount: overdue.length,
      onReviewCount: onReview.length,
      stockAtRisk,
      healthyCount: healthy.length,
      total,
      // arrays kept for the per-card CSV downloads — serialising these exact
      // rows guarantees each file matches its card count
      atRiskRows: atRisk, overdueRows: overdue, onReviewRows: onReview, healthyRows: healthy,
    };
  }, [styleRows]);

  // Top 10 at-risk by stock exposure
  const top10AtRisk = useMemo(() => {
    const risky = styleRows.filter(s => s.action_status === "at_risk" || s.action_status === "overdue");
    return [...risky].sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))
      .slice(0, 10)
      .map(s => ({
        name:          truncate(s.style_name, 28),
        stock:         s.current_stock || 0,
        days:          s.last_sale_days,
        daysLabel:     s.last_sale_days === null ? "No sale data" : `Last sale: ${s.last_sale_days}d`,
        fill:          DAYS_COLOR(s.last_sale_days),
      }));
  }, [styleRows]);

  // Portfolio status donut — colors assigned by name before filtering so zero-count
  // buckets don't shift later slices onto the wrong color.
  const statusDonut = useMemo(() => {
    const healthy  = styleRows.filter(s => s.action_status === "on_track").length;
    const onReview = styleRows.filter(s =>
      s.action_status === "at_risk" &&
      ["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    ).length;
    const mktPush = styleRows.filter(s =>
      s.action_status === "at_risk" &&
      !["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    ).length;
    const overdue = styleRows.filter(s => s.action_status === "overdue").length;
    // Assign color per named status (not by array index after filtering)
    return [
      { name: `Healthy (${healthy})`,           value: healthy,  fill: STATUS_COLORS["Healthy"] },
      { name: `On Review (${onReview})`,         value: onReview, fill: STATUS_COLORS["On Review"] },
      { name: `Marketing Push (${mktPush})`,     value: mktPush,  fill: STATUS_COLORS["Marketing Push"] },
      { name: `Overdue (${overdue})`,            value: overdue,  fill: STATUS_COLORS["Overdue"] },
    ].filter(d => d.value > 0);
  }, [styleRows]);

  // At-risk by subcategory
  const atRiskBySub = useMemo(() => {
    const map = {};
    styleRows.filter(s => s.action_status === "at_risk" || s.action_status === "overdue")
      .forEach(s => { const k = s.subcategory || "—"; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, 10)
      .map(([name, value]) => ({ name: truncate(name, 22), value }));
  }, [styleRows]);

  // Status by age group — three bars per group matching the three distinct action_status
  // values (on_track/at_risk/overdue), labelled consistently with the donut and KPI cards.
  const statusByAge = useMemo(() => {
    return AGE_GROUPS.map(g => {
      const inGroup = styleRows.filter(s => {
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
  }, [styleRows]);

  if (loading) return <Loading label="Loading Overview…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};
  const atRiskPct = s.total_styles ? ((s.at_risk_count || 0) / s.total_styles * 100).toFixed(1) : "0";
  // Lifecycle-split card derivations (Aug 2026 rework) — every ratio guards a
  // zero/missing denominator, mirroring how the warehouse % was derived before.
  // Avg/Style denominators use the deduped ALL-style universe counts (zero-stock
  // styles included) so they match the exhaustive revenue numerators:
  // active_styles_all_count for Active; retired_styles_count already counts all
  // Retired styles (no stock gate) so it is the matching Retired denominator.
  const totalRevPeriod        = (s.revenue_period ?? s.revenue_6m) || 0;
  const avgRevPerActiveStyle  = s.active_styles_all_count ? (s.active_revenue_period || 0) / s.active_styles_all_count : 0;
  const avgRevPerRetiredStyle = s.retired_styles_count ? (s.retired_revenue_period || 0) / s.retired_styles_count : 0;
  const activeRevSharePct     = totalRevPeriod ? Math.round((s.active_revenue_period  || 0) / totalRevPeriod * 100) : 0;
  const retiredRevSharePct    = totalRevPeriod ? Math.round((s.retired_revenue_period || 0) / totalRevPeriod * 100) : 0;
  const activeWhPct           = s.active_stock_units  ? Math.round((s.active_warehouse_stock_units  || 0) / s.active_stock_units  * 100) : 0;
  const retiredWhPct          = s.retired_stock_units ? Math.round((s.retired_warehouse_stock_units || 0) / s.retired_stock_units * 100) : 0;

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

  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const dateSlug = new Date().toISOString().slice(0, 10);

  // Client-side CSVs: the at-risk row's numbers are derived from styleRows in
  // this component, so each card download serialises the exact array it
  // renders — the server buckets cover the portfolio KPI row instead.
  const buildStyleCsv = (rows) => {
    const headers = ["Style Name", "Subcategory", "Tier", "Current Stock", "WOC (weeks)", "Last Sale (days)", "Action Status", "Recommended Action"];
    const body = rows.map(r => [
      `"${(r.style_name || "").replace(/"/g, '""')}"`,
      `"${(r.subcategory || "").replace(/"/g, '""')}"`,
      r.tier || "",
      r.current_stock ?? "",
      r.woc !== null && r.woc !== undefined ? r.woc : "",
      r.last_sale_days !== null && r.last_sale_days !== undefined ? r.last_sale_days : "",
      r.action_status || "",
      `"${(r.recommended_action || "").replace(/"/g, '""')}"`,
    ]);
    return [headers.join(","), ...body.map(r => r.join(","))].join("\n");
  };
  const downloadCsvText = (csv, fname) => {
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fname}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  // At-risk section export (filename unchanged from the retired tab)
  const handleDownload = () => {
    const atRiskStyles = styleRows.filter(r => r.action_status === "at_risk" || r.action_status === "overdue");
    downloadCsvText(buildStyleCsv(atRiskStyles), `at-risk-styles-${dateSlug}`);
  };

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[11px] text-slate-400">
          Active Style Lines · {dateLabel} · {locationLabel}
        </div>
        <SubcatFilter value={localSubcat} onChange={setLocalSubcat} />
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        <MerchKPICard
          label="Active Styles"
          value={fmtNum(s.active_styles_count)}
          sub={`SOH: ${fmtNum(s.active_stock_units)} units`}
          accentColor={C.blue}
          testId="merch-kpi-active-styles"
          onDownload={downloadKpiCsv("active_styles", "Active_Style_Lines")}
        />
        <MerchKPICard
          label="Retired Styles"
          value={fmtNum(s.retired_styles_count)}
          sub={`SOH: ${fmtNum(s.retired_stock_units)} units`}
          sub2={`${retiredWhPct}% of SOH in Warehouse`}
          accentColor="#94a3b8"
          testId="merch-kpi-retired-styles"
          onDownload={downloadKpiCsv("retired_styles", "Retired_Style_Lines")}
        />
        <MerchKPICard
          label="Archived Styles"
          value={fmtNum(s.archived_styles_count)}
          sub={`SOH: ${fmtNum(s.archived_stock_units)} units`}
          accentColor="#64748b"
          testId="merch-kpi-archived-styles"
          onDownload={downloadKpiCsv("archived_styles", "Archived_Style_Lines")}
        />
        <MerchKPICard
          label="Active Colour Styles"
          value={fmtNum(s.active_colour_styles_count)}
          sub="Distinct style × colour"
          sub2="In stock · Active styles only"
          accentColor={C.teal}
          testId="merch-kpi-colour-styles"
          onDownload={downloadKpiCsv("active_colours", "Active_Colour_Styles")}
        />
        <MerchKPICard
          label="Warehouse Active SOH"
          value={fmtNum(s.active_warehouse_stock_units)}
          sub={`${activeWhPct}% of Active SOH`}
          accentColor={C.purple}
          testId="merch-kpi-warehouse"
          onDownload={downloadKpiCsv("warehouse_units", "Warehouse_Units")}
        />
        <MerchKPICard
          label="Total SOH"
          value={fmtNum(s.total_stock_units)}
          sub={`WOC > 20 (active): ${fmtNum(s.woc_gt20_count)} styles`}
          accentColor="#0891b2"
          testId="merch-kpi-stock"
          onDownload={downloadKpiCsv("total_stock", "Total_Stock_Units")}
        />
        <MerchKPICard
          label="Active Units Sold (Period)"
          value={fmtNum(s.active_units_period)}
          sub="Trailing 6m Vel. (Active)"
          sub2={`${fmtNum(s.active_weekly_velocity)} /wk`}
          accentColor={C.amber}
          testId="merch-kpi-units"
        />
        <MerchKPICard
          label="Active Style Revenue (Period)"
          value={fmtKESM(s.active_revenue_period)}
          sub={`Avg/Active Style: ${fmtKESM(avgRevPerActiveStyle)}`}
          sub2={`${activeRevSharePct}% of total revenue`}
          accentColor="#16a34a"
          testId="merch-kpi-revenue"
        />
        <MerchKPICard
          label="Retired Style Revenue"
          value={fmtKESM(s.retired_revenue_period)}
          sub={`Avg/Retired Style: ${fmtKESM(avgRevPerRetiredStyle)}`}
          sub2={`${retiredRevSharePct}% of total revenue`}
          accentColor="#a16207"
          testId="merch-kpi-retired-revenue"
        />
        <MerchKPICard
          label="SOR (Period)"
          value={fmtPct1(s.avg_sor_period_active)}
          sub="Active Styles Only"
          accentColor="#0ea5e9"
          testId="merch-kpi-sor"
        />
        <MerchKPICard
          label="Style Health"
          value={fmtNum(s.on_track_count)}
          sub={`On Track (${s.total_styles ? Math.round((s.on_track_count || 0) / s.total_styles * 100) : 0}%)`}
          sub2={`At Risk: ${fmtNum(s.at_risk_count)} (${atRiskPct}%)`}
          accentColor={C.green}
          testId="merch-kpi-styles"
          onDownload={downloadKpiCsv("on_track", "On_Track_Styles")}
        />
        <MerchKPICard
          label="Avg Full Price %"
          value={fmtPct1(s.avg_full_price_pct)}
          sub="Avg SOR (period)"
          sub2={fmtPct1(s.avg_sor_6m)}
          accentColor={C.red}
          testId="merch-kpi-fp"
          onDownload={downloadKpiCsv("full_price", "Full_Price_Pct_Styles")}
        />
      </div>

      {/* ── Row 1 charts ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Revenue by Brand */}
        <ChartCard title={`Revenue by Brand (${periodLabel})`}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={brandData}
              layout="vertical"
              margin={{ top: 0, right: 84, left: 45, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="brand" tick={{ fontSize: 10 }} width={50} />
              <Tooltip content={<ShareTrendTooltip />} />
              <Bar dataKey="revenue_sel" name="Revenue" fill={C.blue} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_sel" content={barEndLabel(brandData)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Top 5 Subcategories */}
        <ChartCard title={`Top 5 Subcategories by Revenue (${periodLabel})`}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={top5SubcatData}
              layout="vertical"
              margin={{ top: 0, right: 84, left: 80, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="subcategory" tick={{ fontSize: 9 }} width={80} tickFormatter={(v) => v?.length > 18 ? v.slice(0, 18) + "…" : v} />
              <Tooltip content={<ShareTrendTooltip />} />
              <Bar dataKey="revenue_sel" name="Revenue" fill={C.blue} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_sel" content={barEndLabel(top5SubcatData)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Revenue by Tier donut */}
        <ChartCard title={`Revenue by Tier (${filters.from_date ? "Selected Period" : "6m"})`}>
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

      {/* ── Row 2: distributions ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
      </div>

      {/* ════ At-Risk & Actions section (merged from the retired tab) ════ */}
      <div className="flex items-start justify-between gap-3 flex-wrap border-t border-slate-200 pt-5">
        <div>
          <h2 className="text-[18px] font-bold text-foreground">At-Risk Styles &amp; Action Required</h2>
          <p className="text-[13px] text-muted mt-0.5">Underperformers, Slow Movers &amp; Recommended Actions · As at {today}</p>
        </div>
        <button
          onClick={handleDownload}
          data-testid="merch-atrisk-csv"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] text-muted hover:text-foreground hover:border-foreground transition-colors bg-white"
        >
          <DownloadSimple size={13} /> Download CSV
        </button>
      </div>

      {/* At-risk KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <MerchKPICard
          label="At Risk Styles" value={fmtNum(riskKpis.atRiskCount)}
          sub={`${riskKpis.total > 0 ? ((riskKpis.atRiskCount / riskKpis.total) * 100).toFixed(1) : 0}% of portfolio`}
          accentColor={C.amber}
          testId="merch-kpi-atrisk"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.atRiskRows), `At_Risk_Styles_${dateSlug}`)}
        />
        <MerchKPICard
          label="Overdue Styles" value={fmtNum(riskKpis.overdueCount)}
          sub="Immediate action"
          accentColor={C.red}
          testId="merch-kpi-overdue"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.overdueRows), `Overdue_Styles_${dateSlug}`)}
        />
        <MerchKPICard
          label="On Review" value={fmtNum(riskKpis.onReviewCount)}
          sub={`${riskKpis.total > 0 ? ((riskKpis.onReviewCount / riskKpis.total) * 100).toFixed(1) : 0}% of portfolio`}
          accentColor="#4b7bec"
          testId="merch-kpi-onreview"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.onReviewRows), `On_Review_Styles_${dateSlug}`)}
        />
        <MerchKPICard
          label="Stock at Risk" value={`~${fmtNum(Math.round(riskKpis.stockAtRisk / 500) * 500)} units`}
          sub="Estimated exposure"
          accentColor={C.purple}
          testId="merch-kpi-stockatrisk"
          onDownload={async () => downloadCsvText(
            buildStyleCsv([...riskKpis.atRiskRows, ...riskKpis.overdueRows]
              .sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))),
            `Stock_at_Risk_Styles_${dateSlug}`)}
        />
        <MerchKPICard
          label="Healthy Styles" value={fmtNum(riskKpis.healthyCount)}
          sub={`${riskKpis.total > 0 ? ((riskKpis.healthyCount / riskKpis.total) * 100).toFixed(1) : 0}% of portfolio`}
          accentColor={C.green}
          testId="merch-kpi-healthy"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.healthyRows), `Healthy_Styles_${dateSlug}`)}
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
                    {fmtNum(riskKpis.overdueCount)} Overdue styles need immediate review
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#ef4444] tabular-nums">{riskKpis.overdueCount}</span>
              </div>
            </div>
            {/* At-risk */}
            <div className="rounded-lg border-l-4 border-[#d97706] bg-amber-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#d97706]">ACTION NEEDED</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(riskKpis.atRiskCount)} styles: marketing push or price review needed
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#d97706] tabular-nums">{riskKpis.atRiskCount}</span>
              </div>
            </div>
            {/* On review */}
            <div className="rounded-lg border-l-4 border-[#4b7bec] bg-blue-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#4b7bec]">MONITOR</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(riskKpis.onReviewCount)} styles on review — monitor weekly
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#4b7bec] tabular-nums">{riskKpis.onReviewCount}</span>
              </div>
            </div>
            {/* Healthy */}
            <div className="rounded-lg border-l-4 border-[#1a5c38] bg-emerald-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#1a5c38]">HEALTHY</p>
                  <p className="text-[13px] font-semibold text-foreground mt-0.5">
                    {fmtNum(riskKpis.healthyCount)} styles healthy — maintain replenishment
                  </p>
                </div>
                <span className="text-[22px] font-extrabold text-[#1a5c38] tabular-nums">{riskKpis.healthyCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
