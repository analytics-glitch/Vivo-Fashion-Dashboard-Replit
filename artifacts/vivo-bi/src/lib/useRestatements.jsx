// WS7 T702 — prior-period restatement markers.
//
// The nightly restatement check (sync_incremental hour==21 →
// POST /api/internal/restatement-check) snapshots closed-month KPI figures in
// kpi_month_snapshots and logs any drift beyond tolerance to kpi_restatements.
// This hook fetches the log entries whose MONTH overlaps a given window so a
// page can badge comparison bases with "restated on DATE" instead of silently
// showing a different figure than last week.
import React, { useEffect, useState } from "react";
import api from "@/lib/api";

export function useRestatements(dateFrom, dateTo, enabled = true) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!enabled || !dateFrom || !dateTo) { setRows([]); return; }
    let cancelled = false;
    api.get("/analytics/restatements", { params: { date_from: dateFrom, date_to: dateTo } })
      .then(({ data }) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setRows([]); }); // marker is best-effort, never blocks a page
    return () => { cancelled = true; };
  }, [dateFrom, dateTo, enabled]);
  return rows;
}

const fmtDay = (iso) => {
  if (!iso) return "";
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
  return isNaN(d) ? String(iso).slice(0, 10)
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const fmtMonth = (iso) => {
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00");
  return isNaN(d) ? String(iso).slice(0, 7)
    : d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
};

/** Amber pill: "May 2026 restated on 21 Jun 2026". Renders nothing when the
 *  restatement log is empty for the window. */
export function RestatedBadge({ restatements, className = "" }) {
  if (!restatements || restatements.length === 0) return null;
  // latest restatement per month, newest month last
  const byMonth = new Map();
  for (const r of restatements) byMonth.set(String(r.month).slice(0, 7), r);
  const items = [...byMonth.values()];
  const label = items.length === 1
    ? `${fmtMonth(items[0].month)} restated on ${fmtDay(items[0].restated_on)}`
    : `${items.length} months restated (latest ${fmtDay(items[items.length - 1].restated_on)})`;
  const title = items
    .map((r) => `${fmtMonth(r.month)}: restated on ${fmtDay(r.restated_on)} — Total Sales ${Number(r.old_total_sales).toLocaleString()} → ${Number(r.new_total_sales).toLocaleString()}`)
    .join("\n");
  return (
    <span
      data-testid="restated-badge"
      title={title}
      className={`inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 border border-amber-300 px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap ${className}`}
    >
      ⚠ {label}
    </span>
  );
}
