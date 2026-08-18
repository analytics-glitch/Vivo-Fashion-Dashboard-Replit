/**
 * Shared helpers for all Merchandising Hub tab components.
 * Formatting helpers, the MerchKPICard wrapper, and the useMerchData hook.
 */
import React, { useEffect, useState, useCallback, useMemo } from "react";
import { DownloadSimple, CircleNotch } from "@phosphor-icons/react";
import { useMerchFilters } from "@/pages/MerchandisingHub";
import { api } from "@/lib/api";
import { useFilters } from "@/lib/filters";

// ── Colour palette ───────────────────────────────────────────────────────────
export const C = {
  blue:   "#2D6BE4",
  teal:   "#4ECDC4",
  purple: "#7B5EA7",
  green:  "#27AE60",
  amber:  "#F5A623",
  red:    "#E84040",
  muted:  "#94a3b8",
};

// ── Formatters ───────────────────────────────────────────────────────────────
export const fmtWoc = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(1)} wks`;
};

export const fmtSor = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(1)}%`;
};

export const fmtKESM = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "KES 0";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return "KES " + (v / 1_000_000_000).toFixed(1) + "B";
  if (abs >= 1_000_000)     return "KES " + (v / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000)         return "KES " + (v / 1_000).toFixed(0) + "K";
  return "KES " + Math.round(v).toLocaleString("en-US");
};

export const fmtPct1 = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(1)}%`;
};

// Full-price SOR gap colour: small gaps are healthy, larger gaps flag
// discount dependence without changing the primary total-SOR value.
export const sorGapColor = (gap) => {
  if (gap === null || gap === undefined || isNaN(Number(gap))) return undefined;
  return Number(gap) <= 5 ? C.green : Number(gap) <= 15 ? C.amber : C.red;
};

// Retired-style markdown severity: close-to-full-price clearance is healthy,
// while deeper markdowns indicate a more expensive retirement decision.
export const discountDepthColor = (depth) => {
  if (depth === null || depth === undefined || isNaN(Number(depth))) return undefined;
  return Number(depth) <= 10 ? C.green : Number(depth) <= 25 ? C.amber : C.red;
};

export const fmtNum = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "0";
  return Math.round(Number(n)).toLocaleString("en-US");
};

// Full-format price — "KES 4,125" (no abbreviation). Use for per-unit prices
// where the raw number is a meaningful KES figure, not a large aggregate.
export const fmtKESFull = (n) => {
  if (n == null || isNaN(Number(n))) return "—";
  return "KES " + Math.round(Number(n)).toLocaleString("en-US");
};

export const fmtAxisM = (n) => {
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(0) + "M";
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(0) + "K";
  return String(Math.round(v));
};

// Compact period tags keep KPI headings readable while still reflecting the
// exact global dashboard period. Custom ranges retain their dates.
const shortDate = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const shortMonth = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { month: "short" });
};

export const merchPeriodLabel = ({ preset, dateFrom, dateTo }) => {
  const presetLabels = {
    today: "Today",
    yesterday: "Yesterday",
    last_7d: "7d",
    last_30d: "30d",
    last_90d: "90d",
    last_365d: "365d",
    last_12_months: "12m",
    last_week: "Last Week",
    last_quarter: "Last Qtr",
    last_year: "LY",
    mtd: "MTD",
    qtd: "QTD",
    ytd: "YTD",
    this_week: "This Week",
    this_month: "MTD",
    this_year: "YTD",
  };

  if (preset === "last_month") return shortMonth(dateTo) || "Prev Month";
  if (preset && preset !== "custom" && presetLabels[preset]) {
    return presetLabels[preset];
  }

  if (dateFrom && dateTo) {
    const from = shortDate(dateFrom);
    const to = shortDate(dateTo);
    if (from && to) return dateFrom === dateTo ? from : `${from} – ${to}`;
  }
  return "6m";
};

export const useMerchPeriodLabel = () => {
  const { preset, applied } = useFilters();
  return useMemo(
    () => merchPeriodLabel({
      preset,
      dateFrom: applied.dateFrom,
      dateTo: applied.dateTo,
    }),
    [preset, applied.dateFrom, applied.dateTo],
  );
};

// ── MerchKPICard ─────────────────────────────────────────────────────────────
/**
 * Shared KPI card. Cards stay neutral by default; statusAccent is reserved for
 * meaningful status communication (the Overview's At-Risk cards).
 *
 * accentColor remains supported for the other Merchandising Hub tabs, but the
 * Overview passes no accentColor to portfolio cards so their values stay dark
 * and readable.
 */
export const MerchKPICard = ({
  label,
  value,
  sub,
  sub2,
  accentColor = null,
  statusAccent = null,
  testId,
  trend,       // optional number: % change vs compare period (null = hide)
  trendLabel,  // optional string: e.g. "vs Last Month"
  onDownload,  // optional async fn → shows a "Download CSV" button
  downloadCount, // optional number → appends "· N rows" to the download button
  note,        // optional string: small muted criteria/context line at the card foot
}) => {
  const [dlBusy, setDlBusy]   = useState(false);
  const [dlError, setDlError] = useState(false);
  const handleDownload = async () => {
    if (dlBusy || !onDownload) return;
    setDlBusy(true);
    setDlError(false);
    try {
      await onDownload();
    } catch {
      setDlError(true);
      setTimeout(() => setDlError(false), 4000);
    } finally {
      setDlBusy(false);
    }
  };
  const cardAccent = statusAccent || accentColor;
  return (
  <div
    className={`bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex ${
      cardAccent ? "border-l-4" : ""
    }`}
    data-testid={testId}
    style={cardAccent ? { minHeight: 120, borderLeftColor: cardAccent } : { minHeight: 120 }}
  >
    <div className="flex-1 p-4">
      <div className="flex items-start justify-between gap-1 flex-wrap">
        <div className="flex min-w-0 items-center gap-1.5">
          {statusAccent && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: statusAccent }}
              aria-hidden="true"
            />
          )}
          <div className="text-xs font-medium text-gray-500">{label}</div>
        </div>
        {onDownload && (
          <button
            type="button"
            onClick={handleDownload}
            disabled={dlBusy}
            title={dlError ? "Download failed — try again" : "Download CSV"}
            aria-label={`Download ${label} CSV`}
            className={`shrink-0 -mt-1 -mr-1 px-1.5 py-1 rounded-md transition-colors inline-flex items-center gap-1 ${
              dlError ? "text-rose-500" : "text-slate-400 hover:text-slate-600 hover:bg-slate-50"
            } disabled:opacity-50`}
            data-testid={testId ? `${testId}-download` : undefined}
          >
            {dlBusy ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <DownloadSimple size={14} weight={dlError ? "bold" : "regular"} />
            )}
            <span className="text-[10.5px] font-semibold whitespace-nowrap">
              {dlError ? "Retry download" : "Download CSV"}
              {!dlError && downloadCount != null
                ? ` · ${fmtNum(downloadCount)} ${downloadCount === 1 ? "row" : "rows"}`
                : ""}
            </span>
          </button>
        )}
      </div>
      <div
        className="mt-2 text-2xl font-bold leading-none tabular-nums text-gray-900"
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-2 text-xs text-gray-500">{sub}</div>
      )}
      {sub2 && (
        <div className="mt-0.5 text-xs font-medium text-gray-600">{sub2}</div>
      )}
      {note && (
        <div className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-4 text-gray-500">{note}</div>
      )}
      {trend != null && !isNaN(trend) && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <span className={`text-[13px] font-bold leading-none ${
            trend > 0.05 ? "text-emerald-600" : trend < -0.05 ? "text-rose-500" : "text-slate-400"
          }`}>
            {trend > 0.05 ? "↑" : trend < -0.05 ? "↓" : "→"}
          </span>
          <span className={`text-[11px] font-semibold ${
            trend > 0.05 ? "text-emerald-600" : trend < -0.05 ? "text-rose-500" : "text-slate-400"
          }`}>
            {Math.abs(trend).toFixed(1)}%
          </span>
          {trendLabel && (
            <span className="text-[10px] text-slate-400 truncate">{trendLabel}</span>
          )}
        </div>
      )}
    </div>
  </div>
  );
};

// ── SubcatFilter ─────────────────────────────────────────────────────────────
/**
 * Compact subcategory selector for per-tab local scope filtering.
 * Reads the category list from the hub context (no extra fetch needed).
 * value: null = "not set, hub-level applies"; "" = "explicitly all"; "Dresses" = specific.
 * onChange: receives a string value or null (when "All" is selected).
 */
export const SubcatFilter = ({ value, onChange }) => {
  const filters = useMerchFilters();
  const categories = filters.filterOptions?.categories || [];
  if (!categories.length) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide shrink-0">
        Subcategory
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="text-[12px] border border-slate-200 rounded-lg px-2.5 py-1 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-brand min-w-[160px]"
      >
        <option value="">All Subcategories</option>
        {categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      {value && (
        <button
          onClick={() => onChange(null)}
          className="text-[11px] text-slate-400 hover:text-slate-600"
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
};

// ── useMerchData ─────────────────────────────────────────────────────────────
/**
 * Hook that fetches one or more /api/merch/* endpoints with the current
 * hub filters. Returns { data, loading, error } for each URL keyed by
 * the last path segment.
 *
 * localSubcat: optional per-tab subcategory override.
 *   null      → not set; hub-level filters.subcategory is used.
 *   ""        → explicitly "All"; overrides hub-level (clears it for this tab).
 *   "Dresses" → narrow to that subcategory for this tab only.
 *
 * Usage:
 *   const { summary, styles, byBrand, bySubcategory, byTier, loading, error }
 *     = useMerchData(["summary","styles","by-brand","by-subcategory","by-tier"], localSubcat);
 */
// Build the exact query params useMerchData sends for the current hub filters
// (+ optional tab-local subcategory override). Exported so one-off fetches
// (e.g. the KPI CSV downloads) hit the API with identical scope.
export const useMerchParams = (localSubcat = null) => {
  const filters = useMerchFilters();
  const params = {};
  if (filters.from_date)    params.from_date    = filters.from_date;
  if (filters.to_date)      params.to_date      = filters.to_date;
  if (filters.country)      params.country      = filters.country;
  if (filters.pos_location) params.pos_location = filters.pos_location;
  if (filters.brand)        params.brand        = filters.brand;
  if (filters.tier)         params.tier         = filters.tier;
  // Local override wins; null = fall back to hub-level
  const effectiveSubcat = localSubcat !== null ? localSubcat : (filters.subcategory || "");
  if (effectiveSubcat)      params.subcategory  = effectiveSubcat;
  return params;
};

export const useMerchData = (endpoints = [], localSubcat = null, extraParams = null) => {
  const filters = useMerchFilters();
  const [state, setState] = useState({ loading: true, error: null });

  // extraParams: optional additional query params sent to every endpoint in
  // the list (FastAPI silently ignores params an endpoint doesn't declare) —
  // e.g. Overview passes { trend: 1 } so by-brand / by-subcategory include
  // prev-period trend fields without changing any other caller.
  const baseParams = useMerchParams(localSubcat);
  const params = extraParams ? { ...baseParams, ...extraParams } : baseParams;

  // Stable serialisation for the dep array
  const paramsKey = JSON.stringify(params) + filters.dataVersion;

  const load = useCallback(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.all(
      endpoints.map((ep) => api.get(`/merch/${ep}`, { params }))
    )
      .then((results) => {
        if (cancelled) return;
        const next = { loading: false, error: null };
        results.forEach((r, i) => {
          // key = endpoint with dashes removed, camelCased
          const key = endpoints[i].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          next[key] = r.data;
        });
        setState(next);
      })
      .catch((e) => {
        if (!cancelled) setState({ loading: false, error: e?.response?.data?.detail || e.message });
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  useEffect(() => load(), [load]);

  return state;
};

// ── Chart helpers ─────────────────────────────────────────────────────────────
export const ChartCard = ({ title, children, className = "" }) => (
  <div className={`bg-white rounded-xl shadow-sm p-4 sm:p-5 ${className}`}>
    <div className="text-[12px] font-semibold text-slate-500 mb-3">{title}</div>
    {children}
  </div>
);

export const SectionDivider = ({ title }) => (
  <div className="col-span-full border-t border-slate-100 pt-1">
    {title && <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</div>}
  </div>
);

// WOC colour
export const wocColor = (woc) => {
  const w = Number(woc);
  if (w <= 0) return C.red;
  if (w < 8)  return C.green;
  if (w < 16) return C.amber;
  return C.teal;
};

// SOR colour
export const sorColor = (sor) => {
  const s = Number(sor);
  if (s >= 60) return C.green;
  if (s >= 40) return C.amber;
  return C.red;
};
