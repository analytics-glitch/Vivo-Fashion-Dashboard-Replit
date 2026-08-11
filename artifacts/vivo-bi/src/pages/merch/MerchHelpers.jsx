/**
 * Shared helpers for all Merchandising Hub tab components.
 * Formatting helpers, the MerchKPICard wrapper, and the useMerchData hook.
 */
import React, { useEffect, useState, useCallback } from "react";
import { useMerchFilters } from "@/pages/MerchandisingHub";
import { api } from "@/lib/api";

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

export const fmtNum = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "0";
  return Math.round(Number(n)).toLocaleString("en-US");
};

export const fmtAxisM = (n) => {
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(0) + "M";
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(0) + "K";
  return String(Math.round(v));
};

// ── MerchKPICard ─────────────────────────────────────────────────────────────
/**
 * KPI card with a 4px left accent bar.
 * accentColor: any CSS colour string, defaults to blue.
 */
export const MerchKPICard = ({
  label,
  value,
  sub,
  sub2,
  accentColor = C.blue,
  testId,
}) => (
  <div
    className="bg-white rounded-xl shadow-sm overflow-hidden flex"
    data-testid={testId}
    style={{ minHeight: 120 }}
  >
    {/* left accent bar */}
    <div className="w-1 shrink-0" style={{ backgroundColor: accentColor }} />
    <div className="flex-1 p-4 sm:p-5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className="mt-2 text-[22px] sm:text-[28px] font-extrabold leading-none tabular-nums"
        style={{ color: accentColor }}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-2 text-[11px] text-slate-400">{sub}</div>
      )}
      {sub2 && (
        <div className="mt-0.5 text-[11px] font-semibold text-slate-500">{sub2}</div>
      )}
    </div>
  </div>
);

// ── useMerchData ─────────────────────────────────────────────────────────────
/**
 * Hook that fetches one or more /api/merch/* endpoints with the current
 * hub filters. Returns { data, loading, error } for each URL keyed by
 * the last path segment.
 *
 * Usage:
 *   const { summary, styles, byBrand, bySubcategory, byTier, loading, error }
 *     = useMerchData(["summary","styles","by-brand","by-subcategory","by-tier"]);
 */
export const useMerchData = (endpoints = []) => {
  const filters = useMerchFilters();
  const [state, setState] = useState({ loading: true, error: null });

  const params = {};
  if (filters.from_date)    params.from_date    = filters.from_date;
  if (filters.to_date)      params.to_date      = filters.to_date;
  if (filters.country)      params.country      = filters.country;
  if (filters.pos_location) params.pos_location = filters.pos_location;

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
