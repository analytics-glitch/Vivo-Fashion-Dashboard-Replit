import React, { useEffect, useState, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import * as XLSX from "xlsx";
import { api } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import {
  ClipboardText,
  Package,
  Sparkle,
  ArrowsClockwise,
  Repeat,
  Truck,
  WarningCircle,
  CalendarCheck,
  X,
  DownloadSimple,
} from "@phosphor-icons/react";

function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v)
    ? v.toLocaleString()
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return String(d); }
}

function titleize(s) {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const LIFECYCLE_META = {
  New: { icon: Sparkle, color: "#059669", bg: "bg-emerald-500" },
  Replenishment: { icon: ArrowsClockwise, color: "#0284c7", bg: "bg-sky-500" },
  "Re-order": { icon: Repeat, color: "#7c3aed", bg: "bg-violet-500" },
};


const CAT_PALETTE_HEX = [
  "#0ea5e9", "#7c3aed", "#f59e0b", "#fb7185",
  "#14b8a6", "#f97316", "#818cf8", "#f472b6",
  "#84cc16", "#06b6d4", "#e879f9", "#eab308",
];
const _catHexMap = {};
let _catHexIdx = 0;
function catHexFor(label) {
  if (!_catHexMap[label]) {
    _catHexMap[label] = CAT_PALETTE_HEX[_catHexIdx % CAT_PALETTE_HEX.length];
    _catHexIdx++;
  }
  return _catHexMap[label];
}

const LIFECYCLE_HEX = {
  New: "#059669",
  Replenishment: "#0284c7",
  "Re-order": "#7c3aed",
  Unspecified: "#9ca3af",
};

const STATE_HEX = {
  fully_planned: "#10b981",
  partially_planned: "#f59e0b",
  draft: "#9ca3af",
  bom_pending: "#fb7185",
};

/** Horizontal bar chart — one bar per row, sorted desc */
function BreakdownBar({ title, rows, colorFor, metric = "orders", unitLabel = "units", maxRows = 10, testId }) {
  const data = (rows || [])
    .filter((r) => Number(r[metric]) > 0)
    .sort((a, b) => Number(b[metric]) - Number(a[metric]));
  const total = data.reduce((s, r) => s + (Number(r[metric]) || 0), 0);
  const visible = data.slice(0, maxRows);
  const maxVal = visible.length > 0 ? Number(visible[0][metric]) : 1;

  return (
    <div className="card-white p-4" data-testid={testId}>
      <div className="eyebrow mb-3">{title}</div>
      {total === 0 ? (
        <div className="text-[12px] text-muted italic">No data.</div>
      ) : (
        <div className="space-y-1.5">
          {visible.map((r) => {
            const val = Number(r[metric]);
            const pct = (val / total) * 100;
            const barW = maxVal > 0 ? (val / maxVal) * 100 : 0;
            return (
              <div key={r.label} className="flex items-center gap-2 text-[12px]">
                <div className="w-[120px] shrink-0 truncate text-right font-medium text-[#0f3d24]" title={titleize(r.label)}>
                  {titleize(r.label)}
                </div>
                <div className="flex-1 h-3.5 bg-[#f5f0eb] rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm transition-all"
                    style={{ width: `${barW}%`, backgroundColor: colorFor(r.label) }}
                  />
                </div>
                <div className="w-[72px] shrink-0 text-right tabular-nums text-muted">
                  {fmtQty(val)} · {pct.toFixed(0)}%
                </div>
              </div>
            );
          })}
          {data.length > maxRows && (
            <div className="text-[11px] text-muted italic pl-[128px]">
              +{data.length - maxRows} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Stage snapshot */
function StageSnapshot({ byStage, terminalKeys }) {
  const rows = (byStage || []).filter(
    (s) => !terminalKeys.has(s.stage_key) && Number(s.units) > 0
  );
  const total = rows.reduce((s, r) => s + (Number(r.units) || 0), 0);
  return (
    <div className="card-white p-4" data-testid="prod-ov-stage-snapshot">
      <div className="eyebrow mb-2">Where the work is (units in progress)</div>
      {rows.length === 0 ? (
        <div className="text-[12px] text-muted italic">Nothing currently in progress.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const pct = total > 0 ? (Number(r.units) / total) * 100 : 0;
            return (
              <div key={r.stage_key}>
                <div className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="font-semibold text-[#0f3d24] truncate">
                    {r.stage_name}
                    {r.live && <span className="ml-1.5 text-[10px] font-medium text-emerald-600 align-middle">live</span>}
                  </span>
                  <span className="text-muted whitespace-nowrap tabular-nums">
                    {fmtQty(r.units)} u · {fmtQty(r.orders)} orders · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-panel/70 overflow-hidden">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Delivery outlook */
function DeliveryOutlook({ overdue, dueSoon, onOpenReport, onDrillLanding }) {
  const Section = ({ icon: Icon, tone, title, rows, emptyText, testId }) => (
    <div data-testid={testId}>
      <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${tone} mb-1.5`}>
        <Icon size={14} weight="bold" />
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[12px] text-muted italic">{emptyText}</div>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 6).map((o) => (
            <div key={o.order_ref} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate">
                <span className="font-semibold text-[#0f3d24]">{o.order_ref}</span>
                <span className="text-muted"> · {o.style_name || o.product_name || o.style_number || "—"}</span>
              </span>
              <span className="text-muted whitespace-nowrap tabular-nums">
                {fmtQty(o.order_qty)} u · {fmtDate(o.expected_delivery_date)}
              </span>
            </div>
          ))}
          {rows.length > 6 &&
            (typeof onOpenReport === "function" ? (
              <button type="button" onClick={onOpenReport} className="text-[11.5px] font-semibold text-brand hover:underline">
                +{rows.length - 6} more in the Production Report
              </button>
            ) : (
              <div className="text-[11.5px] text-muted">+{rows.length - 6} more</div>
            ))}
        </div>
      )}
    </div>
  );
  return (
    <div className="card-white p-4 space-y-4" data-testid="prod-ov-delivery">
      <div className="flex items-center justify-between">
        <div className="eyebrow">Delivery outlook (active orders)</div>
        {(overdue.length + dueSoon.length) > 0 && (
          <button
            type="button"
            onClick={onDrillLanding}
            className="text-[11px] font-semibold text-brand hover:underline"
          >
            View all & export
          </button>
        )}
      </div>
      <Section icon={WarningCircle} tone="text-rose-600" title={`Overdue (${overdue.length})`} rows={overdue} emptyText="Nothing overdue." testId="prod-ov-overdue" />
      <Section icon={CalendarCheck} tone="text-emerald-700" title={`Due in the next 14 days (${dueSoon.length})`} rows={dueSoon} emptyText="Nothing due in the next two weeks." testId="prod-ov-due-soon" />
    </div>
  );
}

/** Drill-down modal — shown when a KPI card is clicked. */
function DrillModal({ title, subtitle, rows, columns, onClose }) {
  const exportExcel = () => {
    const data = rows.map((r) => {
      const row = {};
      for (const c of columns) {
        row[c.label] = c.csv ? c.csv(r) : (r[c.key] ?? "");
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    XLSX.writeFile(wb, `${title.replace(/\s+/g, "-").toLowerCase()}.xlsx`);
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      data-testid="drill-modal"
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-200">
          <div>
            <div className="text-[15px] font-bold text-[#0f3d24]">{title}</div>
            {subtitle && <div className="text-[12px] text-muted mt-0.5">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={exportExcel}
              disabled={rows.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#1a5c38] text-white text-[12px] font-semibold px-3 py-1.5 hover:bg-[#0f3d24] disabled:opacity-40"
              data-testid="drill-export-excel"
            >
              <DownloadSimple size={14} weight="bold" />
              Export Excel
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
              data-testid="drill-close"
            >
              <X size={16} weight="bold" />
            </button>
          </div>
        </div>
        {/* Body */}
        <div className="overflow-auto flex-1 px-6 py-3">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-muted italic">No orders in this selection.</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  {columns.map((c) => (
                    <th key={c.key} className={`py-2 pr-4 ${c.numeric ? "text-right" : ""} whitespace-nowrap`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.order_ref || i} className="border-b border-slate-100 hover:bg-slate-50">
                    {columns.map((c) => (
                      <td key={c.key} className={`py-1.5 pr-4 ${c.numeric ? "text-right tabular-nums" : ""}`}>
                        {c.render ? c.render(r) : (r[c.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 text-[11.5px] text-muted">
          {rows.length} row{rows.length !== 1 ? "s" : ""}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Clickable wrapper around KPICard */
function ClickableCard({ onClick, children }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
      className="cursor-pointer rounded-xl ring-2 ring-transparent hover:ring-[#1a5c38]/30 transition-shadow focus:outline-none focus:ring-[#1a5c38]/50"
      title="Click to see detail"
    >
      {children}
    </div>
  );
}

export default function ProductionOverview({ onOpenReport }) {
  const [data, setData] = useState(null);
  const [flow, setFlow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Date range — default last 30 days
  const [dateFrom, setDateFrom] = useState(() => isoDaysAgo(30));
  const [dateTo, setDateTo] = useState(() => isoDaysAgo(0));

  // Drill modal state
  const [drill, setDrill] = useState(null); // { title, subtitle, rows, columns }

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const opts = force ? { forceFresh: true } : {};
    try {
      const [summaryRes, flowRes] = await Promise.all([
        api.get("/production/summary", opts),
        api.get("/production/flow", opts),
      ]);
      setData(summaryRes.data);
      setFlow(flowRes.data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to load the production overview");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const totals = data?.totals || { orders: 0, units: 0, styles: 0 };
  const byLifecycle = data?.by_lifecycle || [];
  const orders = data?.orders || [];

  const terminalKeys = useMemo(
    () => new Set((flow?.stages || []).filter((s) => s.is_terminal).map((s) => s.stage_key)),
    [flow]
  );

  const isComplete = useCallback(
    (o) => {
      const sq = o.stage_qty || {};
      let term = 0, nonTerm = 0;
      for (const [k, v] of Object.entries(sq)) {
        const n = Number(v) || 0;
        if (terminalKeys.has(k)) term += n;
        else nonTerm += n;
      }
      return term > 0 && nonTerm === 0;
    },
    [terminalKeys]
  );

  const activeOrders = useMemo(() => orders.filter((o) => !isComplete(o)), [orders, isComplete]);
  const completedCount = orders.length - activeOrders.length;

  const inProgressUnits = useMemo(
    () => (data?.by_stage || []).reduce((s, r) => (terminalKeys.has(r.stage_key) ? s : s + (Number(r.units) || 0)), 0),
    [data, terminalKeys]
  );

  // Orders placed within the selected date range (used for KPI cards + drill).
  const rangeOrders = useMemo(() => {
    return orders.filter((o) => {
      if (!o.date_ordered) return false;
      const d = String(o.date_ordered).slice(0, 10);
      return d >= dateFrom && d <= dateTo;
    });
  }, [orders, dateFrom, dateTo]);

  // Delivery outlook — always based on active book, not date range.
  const { overdue, dueSoon } = useMemo(() => {
    const toLocalISO = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const todayStr = toLocalISO(now);
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 14);
    const horizonStr = toLocalISO(horizon);
    const od = [], ds = [];
    for (const o of activeOrders) {
      const raw = o.expected_delivery_date;
      if (!raw) continue;
      const dateStr = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (dateStr < todayStr) od.push(o);
      else if (dateStr <= horizonStr) ds.push(o);
    }
    const byDate = (a, b) => String(a.expected_delivery_date).localeCompare(String(b.expected_delivery_date));
    od.sort(byDate);
    ds.sort(byDate);
    return { overdue: od, dueSoon: ds };
  }, [activeOrders]);

  const lc = useCallback(
    (label) => byLifecycle.find((r) => r.label === label) || { orders: 0, units: 0 },
    [byLifecycle]
  );
  const share = useCallback(
    (n, denom) => {
      const d = denom ?? totals.orders;
      return d > 0 ? `${((Number(n) / d) * 100).toFixed(0)}% of orders` : undefined;
    },
    [totals.orders]
  );

  // Range-window stats shown in KPI cards
  const rangeTotals = useMemo(() => {
    const byLc = {}, byCategory = {}, byProductType = {};
    let units = 0;
    for (const o of rangeOrders) {
      units += Number(o.order_qty) || 0;
      const lbl = o.lifecycle || "—";
      if (!byLc[lbl]) byLc[lbl] = { orders: 0, units: 0 };
      byLc[lbl].orders += 1;
      byLc[lbl].units += Number(o.order_qty) || 0;
      const cat = o.category || "Unspecified";
      if (!byCategory[cat]) byCategory[cat] = { orders: 0, units: 0 };
      byCategory[cat].orders += 1;
      byCategory[cat].units += Number(o.order_qty) || 0;
      const pt = o.product_type || "Unspecified";
      if (!byProductType[pt]) byProductType[pt] = { orders: 0, units: 0 };
      byProductType[pt].orders += 1;
      byProductType[pt].units += Number(o.order_qty) || 0;
    }
    return {
      orders: rangeOrders.length, units, byLc, byCategory, byProductType,
      styles: new Set(rangeOrders.map((o) => o.style_name).filter(Boolean)).size,
    };
  }, [rangeOrders]);

  // Date window label for subtitle/modal
  const windowLabel = `${dateFrom} → ${dateTo}`;

  // ─── Drill columns ────────────────────────────────────────────────────────
  const ORDER_COLS = [
    { key: "order_ref", label: "Order Ref", render: (r) => <span className="font-semibold">{r.order_ref || "—"}</span> },
    { key: "style_name", label: "Style", render: (r) => r.style_name || r.product_name || r.style_number || "—" },
    { key: "lifecycle", label: "Type", render: (r) => r.lifecycle || "—" },
    { key: "category", label: "Category" },
    { key: "product_type", label: "Product Type" },
    { key: "order_qty", label: "Qty", numeric: true, render: (r) => fmtQty(r.order_qty), csv: (r) => r.order_qty },
    { key: "date_ordered", label: "Date Ordered", render: (r) => fmtDate(r.date_ordered), csv: (r) => r.date_ordered || "" },
    { key: "expected_delivery_date", label: "Expected Delivery", render: (r) => fmtDate(r.expected_delivery_date), csv: (r) => r.expected_delivery_date || "" },
    { key: "state", label: "State", render: (r) => titleize(r.state || "—") },
  ];

  const DELIVERY_COLS = [
    { key: "order_ref", label: "Order Ref", render: (r) => <span className="font-semibold">{r.order_ref || "—"}</span> },
    { key: "style_name", label: "Style", render: (r) => r.style_name || r.product_name || r.style_number || "—" },
    { key: "lifecycle", label: "Type", render: (r) => r.lifecycle || "—" },
    { key: "order_qty", label: "Qty", numeric: true, render: (r) => fmtQty(r.order_qty), csv: (r) => r.order_qty },
    {
      key: "expected_delivery_date", label: "Expected Delivery",
      render: (r) => {
        const d = String(r.expected_delivery_date || "").slice(0, 10);
        const today = isoDaysAgo(0);
        const cls = d < today ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold";
        return <span className={cls}>{fmtDate(r.expected_delivery_date)}</span>;
      },
      csv: (r) => r.expected_delivery_date || "",
    },
    { key: "_delivery_status", label: "Status", render: (r) => {
      const d = String(r.expected_delivery_date || "").slice(0, 10);
      const today = isoDaysAgo(0);
      return d < today
        ? <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700">Overdue</span>
        : <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700">Due soon</span>;
    }, csv: (r) => { const d = String(r.expected_delivery_date || "").slice(0, 10); return d < isoDaysAgo(0) ? "Overdue" : "Due soon"; } },
    { key: "state", label: "State", render: (r) => titleize(r.state || "—") },
  ];

  const openDrill = (title, rows, columns, subtitle) =>
    setDrill({ title, subtitle: subtitle || `${rows.length} orders · ${windowLabel}`, rows, columns });

  if (loading) return <Loading label="Loading production overview…" />;
  if (error) return <ErrorBox message={error} />;

  const lcNew = lc("New");
  const lcRep = lc("Replenishment");
  const lcReo = lc("Re-order");

  return (
    <div className="space-y-4" data-testid="production-overview">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle
          title="Buying Orders at a Glance"
          subtitle={`Whole order book · ${fmtQty(completedCount)} completed, ${fmtQty(activeOrders.length)} active · ${fmtQty(rangeOrders.length)} orders placed ${dateFrom} → ${dateTo} (${fmtQty(rangeTotals.units)} units)`}
        />
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-2 rounded-md disabled:opacity-50 shrink-0"
          data-testid="prod-ov-refresh"
        >
          <ArrowsClockwise size={14} weight="bold" className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* ── Date range picker ── */}
      <div className="card-white p-3 flex flex-wrap items-center gap-3" data-testid="prod-ov-date-range">
        <span className="text-[12px] font-semibold text-[#0f3d24]">Date ordered</span>
        <label className="text-[12px] text-slate-600 flex items-center gap-1">
          From
          <input
            type="date"
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[12px]"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="prod-ov-date-from"
          />
        </label>
        <label className="text-[12px] text-slate-600 flex items-center gap-1">
          To
          <input
            type="date"
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[12px]"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="prod-ov-date-to"
          />
        </label>
        <div className="flex items-center gap-1">
          {[
            { label: "7D", days: 7 },
            { label: "30D", days: 30 },
            { label: "90D", days: 90 },
            { label: "All time", days: 3650 },
          ].map(({ label, days }) => {
            const from = isoDaysAgo(days);
            const active = dateFrom === from && dateTo === isoDaysAgo(0);
            return (
              <button
                key={label}
                type="button"
                onClick={() => { setDateFrom(from); setDateTo(isoDaysAgo(0)); }}
                className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? "border-[#1a5c38] bg-[#1a5c38] text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                }`}
                data-testid={`prod-ov-preset-${label}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Hero KPI row ── clicking any card opens the drill-down modal ── */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <ClickableCard onClick={() => openDrill("Buying Orders", rangeOrders, ORDER_COLS)}>
          <KPICard
            testId="prod-ov-kpi-orders"
            accent
            label="Buying Orders"
            value={fmtQty(rangeTotals.orders)}
            icon={ClipboardText}
            sub={`${fmtQty(rangeTotals.styles)} distinct styles`}
            formula={`Orders placed ${windowLabel}. Click to see the full list.`}
            showDelta={false}
          />
        </ClickableCard>
        <ClickableCard onClick={() => openDrill("Units Ordered", [...rangeOrders].sort((a, b) => (Number(b.order_qty) || 0) - (Number(a.order_qty) || 0)), ORDER_COLS)}>
          <KPICard
            testId="prod-ov-kpi-units"
            label="Units Ordered"
            value={fmtQty(rangeTotals.units)}
            icon={Package}
            sub={`${fmtQty(inProgressUnits)} still in progress`}
            formula={`Total ordered quantity for orders placed ${windowLabel}.`}
            showDelta={false}
          />
        </ClickableCard>
        <ClickableCard onClick={() => openDrill("New Styles", rangeOrders.filter((o) => o.lifecycle === "New"), ORDER_COLS)}>
          <KPICard
            testId="prod-ov-kpi-new"
            label="New Styles"
            value={fmtQty(rangeTotals.byLc["New"]?.orders || 0)}
            icon={Sparkle}
            sub={`${fmtQty(rangeTotals.byLc["New"]?.units || 0)} units · ${share(rangeTotals.byLc["New"]?.orders || 0, rangeTotals.orders) || "—"}`}
            formula="Buying orders introducing a NEW style to the range."
            showDelta={false}
          />
        </ClickableCard>
        <ClickableCard onClick={() => openDrill("Replenishments", rangeOrders.filter((o) => o.lifecycle === "Replenishment"), ORDER_COLS)}>
          <KPICard
            testId="prod-ov-kpi-replen"
            label="Replenishments"
            value={fmtQty(rangeTotals.byLc["Replenishment"]?.orders || 0)}
            icon={ArrowsClockwise}
            sub={`${fmtQty(rangeTotals.byLc["Replenishment"]?.units || 0)} units · ${share(rangeTotals.byLc["Replenishment"]?.orders || 0, rangeTotals.orders) || "—"}`}
            formula="Buying orders topping up styles already selling."
            showDelta={false}
          />
        </ClickableCard>
        <ClickableCard onClick={() => openDrill("Re-orders", rangeOrders.filter((o) => o.lifecycle === "Re-order"), ORDER_COLS)}>
          <KPICard
            testId="prod-ov-kpi-reorder"
            label="Re-orders"
            value={fmtQty(rangeTotals.byLc["Re-order"]?.orders || 0)}
            icon={Repeat}
            sub={`${fmtQty(rangeTotals.byLc["Re-order"]?.units || 0)} units · ${share(rangeTotals.byLc["Re-order"]?.orders || 0, rangeTotals.orders) || "—"}`}
            formula="Repeat buying orders of proven styles."
            showDelta={false}
          />
        </ClickableCard>
        <ClickableCard onClick={() => openDrill(
          "Landing & Late",
          [...overdue.map((o) => ({ ...o, _ds: "overdue" })), ...dueSoon.map((o) => ({ ...o, _ds: "due-soon" }))],
          DELIVERY_COLS,
          `${overdue.length} overdue · ${dueSoon.length} due in next 14 days`
        )}>
          <KPICard
            testId="prod-ov-kpi-landing"
            label="Landing / Late"
            value={`${fmtQty(dueSoon.length)} / ${fmtQty(overdue.length)}`}
            icon={Truck}
            sub="due ≤ 14 days / overdue"
            formula="Active orders by expected delivery date."
            showDelta={false}
          />
        </ClickableCard>
      </div>

      {/* Mix bars */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <BreakdownBar
          title="Order type mix (by units)"
          rows={byLifecycle}
          metric="units"
          unitLabel="units"
          colorFor={(label) => LIFECYCLE_HEX[label] || "#9ca3af"}
          testId="prod-ov-lifecycle-mix"
        />
        <BreakdownBar
          title="Buying-order state (by orders)"
          rows={data?.by_state}
          metric="orders"
          unitLabel="orders"
          colorFor={(label) => STATE_HEX[label] || "#9ca3af"}
          testId="prod-ov-state-mix"
        />
      </div>

      {/* Category & product-type breakdown */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <BreakdownBar
          title="Category breakdown (by units)"
          rows={data?.by_category}
          metric="units"
          unitLabel="units"
          colorFor={catHexFor}
          testId="prod-ov-category-mix"
        />
        <BreakdownBar
          title="Product type breakdown (by units)"
          rows={data?.by_product_type}
          metric="units"
          unitLabel="units"
          colorFor={catHexFor}
          maxRows={12}
          testId="prod-ov-product-type-mix"
        />
      </div>

      {/* Stage snapshot + delivery outlook */}
      <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
        <StageSnapshot byStage={data?.by_stage} terminalKeys={terminalKeys} />
        <DeliveryOutlook
          overdue={overdue}
          dueSoon={dueSoon}
          onOpenReport={onOpenReport}
          onDrillLanding={() => openDrill(
            "Landing & Late",
            [...overdue.map((o) => ({ ...o, _ds: "overdue" })), ...dueSoon.map((o) => ({ ...o, _ds: "due-soon" }))],
            DELIVERY_COLS,
            `${overdue.length} overdue · ${dueSoon.length} due in next 14 days`
          )}
        />
      </div>

      {/* Drill-down modal */}
      {drill && (
        <DrillModal
          title={drill.title}
          subtitle={drill.subtitle}
          rows={drill.rows}
          columns={drill.columns}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
