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
 *                active_total_styles (status counts are ACTIVE styles only and
 *                partition active_total_styles exactly),
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
  C, fmtKESM, fmtKESFull, fmtPct1, fmtNum, fmtAxisM, sorGapColor, discountDepthColor,
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

// Tooltip for the Revenue-by-Brand / Subcategories bars: revenue, share
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

// Outside labels for the Revenue-by-Tier donut (user request Aug 2026): tier
// name + % of period revenue beside each slice, in the slice colour. Slices
// under 2% skip the label (legend + tooltip still cover them); labelLine is
// off so skipped slices don't leave stray pointer lines.
const RADIAN = Math.PI / 180;
const renderTierPieLabel = ({ cx, cy, midAngle, outerRadius, percent, name, fill, payload }) => {
  if (!percent || percent < 0.02) return null;
  const r = outerRadius + 14;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  const color = payload?.color || payload?.payload?.color || fill;
  return (
    <text
      x={x} y={y} fill={color}
      textAnchor={x > cx ? "start" : "end"}
      dominantBaseline="central"
      style={{ fontSize: 10.5, fontWeight: 700 }}
    >
      {`${name} · ${(percent * 100).toFixed(percent < 0.10 ? 1 : 0)}%`}
    </text>
  );
};

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

// Mens subcategories ("Men's Tops", "Mens …"): anchored + case-insensitive so
// "Women's…" names can never match (task 1335 — these are excluded from the
// Overview subcategory revenue chart only, nowhere else in the hub).
const MENS_SUBCAT_RE = /^men['’]?s\b/i;

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

  // ── ACTIVE style rows (Tier 1–4) ──────────────────────────────────────────
  // Shared universe for the At-Risk & Actions section AND both distribution
  // charts (user requests Aug 2026): Retired/Archived styles aren't
  // actionable — thousands of dead retired styles all read "overdue" and were
  // drowning the risk cards. The server summary applies the SAME gate to
  // on_track/at_risk/overdue counts, so the Style Health card and the at-risk
  // cards always agree.
  const activeStyleRows = useMemo(
    () => styleRows.filter(s => s.tier !== "Retired" && s.tier !== "Archived"),
    [styleRows]);

  // ── Compute distributions from styles ─────────────────────────────────────
  // Active styles only (user request Aug 2026, matching the FP% chart).
  const wocDist = useMemo(() => {
    const buckets = { "0-4 wks": 0, "4-8 wks": 0, "8-12 wks": 0, "12-20 wks": 0, "20+ wks": 0 };
    for (const r of activeStyleRows) {
      const w = r.woc;
      if (w === null || w === undefined) continue;
      if (w < 4)       buckets["0-4 wks"]++;
      else if (w < 8)  buckets["4-8 wks"]++;
      else if (w < 12) buckets["8-12 wks"]++;
      else if (w < 20) buckets["12-20 wks"]++;
      else             buckets["20+ wks"]++;
    }
    return Object.entries(buckets).map(([name, value], i) => ({ name, value, color: WOC_BUCKET_COLORS[i] }));
  }, [activeStyleRows]);

  // Active styles only (user request Aug 2026) — retired/archived styles'
  // historical full-price % isn't actionable and was inflating the buckets.
  const fpDist = useMemo(() => {
    const buckets = { "<70%": 0, "70-85%": 0, "85-95%": 0, ">95%": 0 };
    for (const r of activeStyleRows) {
      const fp = r.full_price_pct;
      if (fp === null || fp === undefined) continue;
      if (fp < 70)       buckets["<70%"]++;
      else if (fp < 85)  buckets["70-85%"]++;
      else if (fp < 95)  buckets["85-95%"]++;
      else               buckets[">95%"]++;
    }
    return Object.entries(buckets).map(([name, value], i) => ({ name, value, color: FP_BUCKET_COLORS[i] }));
  }, [activeStyleRows]);

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

  // ── Subcategories (all, ex-Accessories/Mens) ──────────────────────────────
  // Task 1335: list EVERY subcategory with revenue in the selected period —
  // no top-N slice — minus Accessories-parented subcats (the server sends the
  // modal parent `category` for exactly this) and mens subcats. share_pct is
  // still computed over the FULL universe total (before the exclusions) so
  // each bar reads as its true share of all revenue; zero-revenue rows are
  // dropped to avoid empty bars.
  const subcatData = useMemo(() => {
    const mapped = (bySubcategory?.rows || []).map((r) => ({ ...r, revenue_sel: selRev(r) }));
    const total = mapped.reduce((sum, r) => sum + r.revenue_sel, 0);
    return mapped
      .filter((r) => r.category !== "Accessories"
                  && !MENS_SUBCAT_RE.test(r.subcategory || "")
                  && r.revenue_sel > 0)
      .sort((a, b) => b.revenue_sel - a.revenue_sel)
      .map((r) => ({ ...r, share_pct: total > 0 ? (r.revenue_sel / total) * 100 : null }));
  }, [bySubcategory]);
  // Chart height scales with the row count (~28px/bar fits the two-line end
  // labels) so ~20 bars render un-squashed; the old fixed 220px is the floor.
  const subcatChartHeight = Math.max(220, subcatData.length * 28 + 40);

  // ── Tier donut ────────────────────────────────────────────────────────────
  const tierPieData = useMemo(() => {
    if (!byTier?.rows) return [];
    return byTier.rows.map((r, i) => ({
      name:  r.tier,
      value: selRev(r),
      color: TIER_COLOR_ARR[i] || C.muted,
    }));
  }, [byTier]);

  // ── At-Risk KPI derivations (activeStyleRows — declared up with the
  //    distributions, since the FP% chart shares the active-only universe) ──
  const riskKpis = useMemo(() => {
    const atRisk  = activeStyleRows.filter(s => s.action_status === "at_risk");
    const overdue = activeStyleRows.filter(s => s.action_status === "overdue");
    const healthy = activeStyleRows.filter(s => s.action_status === "on_track");
    // "On Review" mapped from at_risk (those with last_sale_days 60-89 or overstock)
    const onReview = activeStyleRows.filter(s =>
      s.action_status === "at_risk" &&
      ["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    );
    const stockAtRisk = [...atRisk, ...overdue].reduce((acc, s) => acc + (s.current_stock || 0), 0);
    const total = activeStyleRows.length;
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
  }, [activeStyleRows]);

  // Top 10 at-risk by stock exposure (active styles only)
  const top10AtRisk = useMemo(() => {
    const risky = activeStyleRows.filter(s => s.action_status === "at_risk" || s.action_status === "overdue");
    return [...risky].sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))
      .slice(0, 10)
      .map(s => ({
        name:          truncate(s.style_name, 28),
        stock:         s.current_stock || 0,
        days:          s.last_sale_days,
        daysLabel:     s.last_sale_days === null ? "No sale data" : `Last sale: ${s.last_sale_days}d`,
        fill:          DAYS_COLOR(s.last_sale_days),
      }));
  }, [activeStyleRows]);

  // Portfolio status donut (active styles only) — colors assigned by name
  // before filtering so zero-count buckets don't shift later slices onto the
  // wrong color.
  const statusDonut = useMemo(() => {
    const healthy  = activeStyleRows.filter(s => s.action_status === "on_track").length;
    const onReview = activeStyleRows.filter(s =>
      s.action_status === "at_risk" &&
      ["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    ).length;
    const mktPush = activeStyleRows.filter(s =>
      s.action_status === "at_risk" &&
      !["At-Risk — Investigate", "Overstock — Review"].includes(s.recommended_action)
    ).length;
    const overdue = activeStyleRows.filter(s => s.action_status === "overdue").length;
    // Assign color per named status (not by array index after filtering)
    return [
      { name: `Healthy (${healthy})`,           value: healthy,  fill: STATUS_COLORS["Healthy"] },
      { name: `On Review (${onReview})`,         value: onReview, fill: STATUS_COLORS["On Review"] },
      { name: `Marketing Push (${mktPush})`,     value: mktPush,  fill: STATUS_COLORS["Marketing Push"] },
      { name: `Overdue (${overdue})`,            value: overdue,  fill: STATUS_COLORS["Overdue"] },
    ].filter(d => d.value > 0);
  }, [activeStyleRows]);

  // At-risk by subcategory (active styles only)
  const atRiskBySub = useMemo(() => {
    const map = {};
    activeStyleRows.filter(s => s.action_status === "at_risk" || s.action_status === "overdue")
      .forEach(s => { const k = s.subcategory || "—"; map[k] = (map[k] || 0) + 1; });
    return Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, 10)
      .map(([name, value]) => ({ name: truncate(name, 22), value }));
  }, [activeStyleRows]);

  // Status by age group (active styles only) — three bars per group matching
  // the three distinct action_status values (on_track/at_risk/overdue),
  // labelled consistently with the donut and KPI cards.
  const statusByAge = useMemo(() => {
    return AGE_GROUPS.map(g => {
      const inGroup = activeStyleRows.filter(s => {
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
  }, [activeStyleRows]);

  if (loading) return <Loading label="Loading Overview…" />;
  if (error)   return <ErrorBox message={error} />;

  const s = summary || {};
  // Denominator = active-tier style rows (server-gated), matching the counts.
  const atRiskPct = s.active_total_styles ? ((s.at_risk_count || 0) / s.active_total_styles * 100).toFixed(1) : "0";
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
  // Bottom-line card stats (user request Aug 2026): per-style averages + ASP.
  // SOH/style and colours/style divide by the in-stock active count (the
  // card's own headline); ASP = period revenue ÷ period units. The retired
  // units/style note only renders when the API provides retired_units_period
  // (older cached/prod payloads may lack it).
  const avgSohPerActiveStyle     = s.active_styles_count ? (s.active_stock_units || 0) / s.active_styles_count : 0;
  const avgColoursPerActiveStyle = s.active_styles_count ? (s.active_colour_styles_count || 0) / s.active_styles_count : 0;
  const activeAsp                = s.active_units_period ? (s.active_revenue_period || 0) / s.active_units_period : 0;
  const avgUnitsPerRetiredStyle  = s.retired_units_period != null && s.retired_styles_count
    ? s.retired_units_period / s.retired_styles_count : null;
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

  // At-Risk-by-Subcategory card export: the exact active at-risk/overdue
  // universe the chart aggregates, sorted in bar order (subcategory at-risk
  // count desc, then stock desc) so filtering the file by a subcategory
  // reconciles with its bar. All subcategories included — the chart trims to
  // the top 10 only for display space. The Recommended Action column names
  // the rule that flagged each style.
  const downloadAtRiskBySubCsv = () => {
    const risky = activeStyleRows.filter(s => s.action_status === "at_risk" || s.action_status === "overdue");
    const counts = {};
    risky.forEach(s => { const k = s.subcategory || "—"; counts[k] = (counts[k] || 0) + 1; });
    const rows = [...risky].sort((a, b) =>
      (counts[b.subcategory || "—"] - counts[a.subcategory || "—"]) ||
      (a.subcategory || "—").localeCompare(b.subcategory || "—") ||
      (b.current_stock || 0) - (a.current_stock || 0));
    downloadCsvText(buildStyleCsv(rows), `at-risk-styles-by-subcategory-${dateSlug}`);
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
      {/* Card order + bottom-line stats fixed by the user (Aug 2026): actives
          first (styles → SOR → colours → revenue → units → full price), then
          stock, then retired/archived, ending on Style Health. */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        <MerchKPICard
          label="Active Styles"
          value={fmtNum(s.active_styles_count)}
          sub={`SOH: ${fmtNum(s.active_stock_units)} units`}
          testId="merch-kpi-active-styles"
          onDownload={downloadKpiCsv("active_styles", "Active_Style_Lines")}
          note={`Avg SOH/Style: ${fmtNum(avgSohPerActiveStyle)} units`}
        />
        <MerchKPICard
          label="SOR (Period)"
          value={fmtPct1(s.avg_sor_period_active)}
          sub={
            <>
              <div>Active Styles Only</div>
              <div>Full price SOR: {fmtPct1(s.full_price_sor_period)}</div>
            </>
          }
          sub2={
            <span style={{ color: sorGapColor(s.discounted_sor_gap_pp) }}>
              Discounted: {s.discounted_sor_gap_pp == null ? "—" : `${Number(s.discounted_sor_gap_pp).toFixed(1)}pp`}
            </span>
          }
          testId="merch-kpi-sor"
        />
        <MerchKPICard
          label="Active Colour Styles"
          value={fmtNum(s.active_colour_styles_count)}
          sub="In stock · Active styles only"
          testId="merch-kpi-colour-styles"
          onDownload={downloadKpiCsv("active_colours", "Active_Colour_Styles")}
          note={`Avg Colours/Style: ${avgColoursPerActiveStyle.toFixed(1)}`}
        />
        <MerchKPICard
          label="Active Style Revenue (Period)"
          value={fmtKESM(s.active_revenue_period)}
          sub={`Avg/Active Style: ${fmtKESM(avgRevPerActiveStyle)}`}
          sub2={`${activeRevSharePct}% of total revenue`}
          testId="merch-kpi-revenue"
          note={`ASP (period): ${fmtKESFull(activeAsp)}`}
        />
        <MerchKPICard
          label="Active Units Sold (Period)"
          value={fmtNum(s.active_units_period)}
          sub="Trailing 6m Vel. (Active)"
          sub2={`${fmtNum(s.active_weekly_velocity)} /wk`}
          testId="merch-kpi-units"
          note={`ASP (period): ${fmtKESFull(activeAsp)}`}
        />
        <MerchKPICard
          label="Avg Full Price %"
          value={fmtPct1(s.avg_full_price_pct)}
          sub="Avg SOR (period)"
          sub2={fmtPct1(s.avg_sor_6m)}
          testId="merch-kpi-fp"
          onDownload={downloadKpiCsv("full_price", "Full_Price_Pct_Styles")}
        />
        <MerchKPICard
          label="Total SOH"
          value={fmtNum(s.total_stock_units)}
          sub={`WOC > 20 (active): ${fmtNum(s.woc_gt20_count)} styles`}
          testId="merch-kpi-stock"
          onDownload={downloadKpiCsv("total_stock", "Total_Stock_Units")}
        />
        <MerchKPICard
          label="Warehouse Active SOH"
          value={fmtNum(s.active_warehouse_stock_units)}
          sub={`${activeWhPct}% of Active SOH`}
          testId="merch-kpi-warehouse"
          onDownload={downloadKpiCsv("warehouse_units", "Warehouse_Units")}
        />
        <MerchKPICard
          label="Retired Styles"
          value={fmtNum(s.retired_styles_count)}
          sub={`SOH: ${fmtNum(s.retired_stock_units)} units`}
          sub2={`${retiredWhPct}% of SOH in Warehouse`}
          testId="merch-kpi-retired-styles"
          onDownload={downloadKpiCsv("retired_styles", "Retired_Style_Lines")}
        />
        <MerchKPICard
          label="Retired Style Revenue"
          value={fmtKESM(s.retired_revenue_period)}
          sub={`Avg/Retired Style: ${fmtKESM(avgRevPerRetiredStyle)}`}
          sub2={`${retiredRevSharePct}% of total revenue`}
          testId="merch-kpi-retired-revenue"
          note={
            <>
              <div style={{ color: discountDepthColor(s.retired_discount_depth_pct) }}>
                Avg discount depth: {fmtPct1(s.retired_discount_depth_pct)} off full price
              </div>
              {avgUnitsPerRetiredStyle != null && (
                <div>Avg Units Sold/Style (period): {
                  avgUnitsPerRetiredStyle > 0 && avgUnitsPerRetiredStyle < 0.05
                    ? "<0.1" // tiny-but-real average (e.g. "Today" filter) — don't show a misleading 0.0
                    : avgUnitsPerRetiredStyle < 10 ? avgUnitsPerRetiredStyle.toFixed(1) : fmtNum(avgUnitsPerRetiredStyle)
                }</div>
              )}
            </>
          }
        />
        <MerchKPICard
          label="Archived Styles"
          value={fmtNum(s.archived_styles_count)}
          sub={`SOH: ${fmtNum(s.archived_stock_units)} units`}
          testId="merch-kpi-archived-styles"
          onDownload={downloadKpiCsv("archived_styles", "Archived_Style_Lines")}
        />
        <MerchKPICard
          label="Style Health"
          value={fmtNum(s.on_track_count)}
          sub={`On Track (${s.active_total_styles ? Math.round((s.on_track_count || 0) / s.active_total_styles * 100) : 0}% of active)`}
          sub2={`At Risk: ${fmtNum(s.at_risk_count)} (${atRiskPct}%)`}
          testId="merch-kpi-styles"
          onDownload={downloadKpiCsv("on_track", "On_Track_Styles")}
        />
      </div>

      {/* ── At-Risk & Action Required (moved above the charts so the
             actionable cards lead the page — user request Aug 2026). Each card
             carries a `note` summarising the merch_router _recommend rules
             that feed its bucket. Detail charts stay below ("At-Risk
             Breakdown"). ── */}
      <div className="flex items-start justify-between gap-3 flex-wrap border-t border-slate-200 pt-5">
        <div>
          <h2 className="text-[18px] font-bold text-foreground">At-Risk Styles &amp; Action Required</h2>
          <p className="text-[13px] text-muted mt-0.5">Active styles only · Underperformers, Slow Movers &amp; Recommended Actions · As at {today}</p>
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
          sub={`${riskKpis.total > 0 ? ((riskKpis.atRiskCount / riskKpis.total) * 100).toFixed(1) : 0}% of active styles`}
          statusAccent={C.red}
          testId="merch-kpi-atrisk"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.atRiskRows), `At_Risk_Styles_${dateSlug}`)}
          note="Any warning rule: out of stock but selling · cover < 1.5 wks (< 2 for hot sellers) · no sales 60–89 days · overstock (cover > 16 wks) · heavy markdown"
        />
        <MerchKPICard
          label="Overdue Styles" value={fmtNum(riskKpis.overdueCount)}
          sub="Immediate action"
          statusAccent={C.red}
          testId="merch-kpi-overdue"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.overdueRows), `Overdue_Styles_${dateSlug}`)}
          note="Critical rules: in stock but no sales for 90+ days · severe overstock (cover > 26 wks) · discontinue candidates (no stock, no sales 90+ days)"
        />
        <MerchKPICard
          label="On Review" value={fmtNum(riskKpis.onReviewCount)}
          sub={`${riskKpis.total > 0 ? ((riskKpis.onReviewCount / riskKpis.total) * 100).toFixed(1) : 0}% of active styles`}
          statusAccent={C.amber}
          testId="merch-kpi-onreview"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.onReviewRows), `On_Review_Styles_${dateSlug}`)}
          note="At-risk styles queued for weekly review: in stock but no sales for 60–89 days, or overstock (cover > 16 wks)"
        />
        <MerchKPICard
          label="Stock at Risk" value={`~${fmtNum(Math.round(riskKpis.stockAtRisk / 500) * 500)} units`}
          sub="Estimated exposure"
          statusAccent={C.red}
          testId="merch-kpi-stockatrisk"
          onDownload={async () => downloadCsvText(
            buildStyleCsv([...riskKpis.atRiskRows, ...riskKpis.overdueRows]
              .sort((a, b) => (b.current_stock || 0) - (a.current_stock || 0))),
            `Stock_at_Risk_Styles_${dateSlug}`)}
          note="Total units currently held by all At Risk + Overdue styles (rounded to the nearest 500)"
        />
        <MerchKPICard
          label="Healthy Styles" value={fmtNum(riskKpis.healthyCount)}
          sub={`${riskKpis.total > 0 ? ((riskKpis.healthyCount / riskKpis.total) * 100).toFixed(1) : 0}% of active styles`}
          statusAccent={C.green}
          testId="merch-kpi-healthy"
          onDownload={async () => downloadCsvText(buildStyleCsv(riskKpis.healthyRows), `Healthy_Styles_${dateSlug}`)}
          note="No risk rule tripped — selling steadily with balanced cover; maintain replenishment"
        />
      </div>

      {/* ── Row 1 charts ── */}
      {/* Task 1335: the subcategory chart lists every womenswear subcat, so it
          spans half the row on desktop with Brand + Tier stacked in the other
          half (everything single-column below lg). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Subcategories by Revenue (all, ex-Accessories/Mens) */}
        <ChartCard title={`Subcategories by Revenue (${periodLabel})`}>
          <ResponsiveContainer width="100%" height={subcatChartHeight}>
            <BarChart
              data={subcatData}
              layout="vertical"
              margin={{ top: 0, right: 84, left: 8, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="subcategory" interval={0} tick={{ fontSize: 10 }} width={140} tickFormatter={(v) => v?.length > 26 ? v.slice(0, 26) + "…" : v} />
              <Tooltip content={<ShareTrendTooltip />} />
              <Bar dataKey="revenue_sel" name="Revenue" fill={C.blue} radius={[0, 3, 3, 0]}>
                <LabelList dataKey="revenue_sel" content={barEndLabel(subcatData)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Brand + Tier share the other half, stacked */}
        <div className="flex flex-col gap-4">
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

          {/* Revenue by Tier donut */}
          <ChartCard title={`Revenue by Tier (${filters.from_date ? "Selected Period" : "6m"})`}>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={tierPieData} dataKey="value" nameKey="name"
                  cx="50%" cy="50%" outerRadius={70} innerRadius={40} paddingAngle={2}
                  label={renderTierPieLabel} labelLine={false} isAnimationActive={false}
                >
                  {tierPieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip formatter={(val, name) => [fmtKESM(val), name]} contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                <Legend formatter={(v) => <span style={{ fontSize: 10 }}>{v}</span>} iconSize={8} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>

      {/* ── Row 2: distributions ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* WOC Distribution */}
        <ChartCard title="Weeks of Cover Distribution (Active Styles)">
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
        <ChartCard title="Full Price % Distribution (Active Styles)">
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

      {/* ── At-Risk Breakdown — drill-down charts for the At-Risk & Action
             Required cards that now sit at the top of the page. ── */}
      <div className="border-t border-slate-200 pt-5">
        <h3 className="text-[15px] font-bold text-foreground">At-Risk Breakdown</h3>
        <p className="text-[12px] text-muted mt-0.5">Drill-down for the At-Risk Styles &amp; Action Required cards at the top of the page</p>
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
          <SectionTitle
            title="At-Risk Styles by Subcategory"
            subtitle="No. of At-Risk Styles"
            action={
              <button
                onClick={downloadAtRiskBySubCsv}
                data-testid="merch-atrisk-bysub-csv"
                title="Download every at-risk style with its subcategory (all subcategories, not just the top 10 shown)"
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] text-muted hover:text-foreground hover:border-foreground transition-colors bg-white"
              >
                <DownloadSimple size={12} /> CSV
              </button>
            }
          />
          {/* Flagging criteria — plain-language summary of merch_router.py's
              _recommend rules 1-9 (any tripped rule ⇒ at_risk or overdue).
              SectionTitle has mb-4, so pull the explainer up under it. */}
          <p className="text-[10.5px] text-muted leading-4 -mt-2.5">
            An active style is flagged when any rule trips: out of stock (still selling → reorder
            · no sales 90+ days → discontinue) · cover &lt; 1.5 wks (&lt; 2 for hot sellers) · in
            stock but no sales for 60+ days · overstock (cover &gt; 16 wks) · heavy markdown
            (&lt; 30% sold at full price with cover &gt; 4 wks).
          </p>
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
