import React, { useEffect, useState, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import * as XLSX from "xlsx";
import { PieChart, Pie, Cell, Tooltip } from "recharts";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import {
  ClipboardText, Package, Sparkle, ArrowsClockwise, Repeat,
  Truck, WarningCircle, CalendarCheck, X, DownloadSimple,
} from "@phosphor-icons/react";

// ─── Utilities ────────────────────────────────────────────────────────────────
function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return String(d); }
}
function titleize(s) {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const isoDaysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return toISO(d);
};
const weekStartOf = (d) => {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1));
  return r;
};
function lightenHex(hex, factor) {
  const rr = parseInt(hex.slice(1, 3), 16);
  const gg = parseInt(hex.slice(3, 5), 16);
  const bb = parseInt(hex.slice(5, 7), 16);
  const f = Math.max(0, Math.min(1, factor));
  const nr = Math.round(rr + (255 - rr) * f);
  const ng = Math.round(gg + (255 - gg) * f);
  const nb = Math.round(bb + (255 - bb) * f);
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`;
}

// ─── Color maps ───────────────────────────────────────────────────────────────
const CATEGORY_COLORS = {
  Tops: "#0ea5e9",
  Dresses: "#8b5cf6",
  Bottoms: "#f59e0b",
  Outerwear: "#ec4899",
  Skirts: "#14b8a6",
  Accessories: "#f97316",
  "Two-Piece Sets": "#6366f1",
  Sale: "#94a3b8",
  "Gift Vouchers": "#cbd5e1",
  Unspecified: "#9ca3af",
};

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
  ready: "#06b6d4",
};

// ─── RAG ──────────────────────────────────────────────────────────────────────
const RAG = {
  green:  { bg: "bg-emerald-50", border: "border-emerald-300", dot: "bg-emerald-500", text: "text-emerald-700", label: "On Track" },
  yellow: { bg: "bg-amber-50",   border: "border-amber-300",   dot: "bg-amber-400",   text: "text-amber-700",  label: ">80% of Target" },
  red:    { bg: "bg-red-50",     border: "border-red-300",     dot: "bg-red-500",     text: "text-red-700",    label: "Off Track" },
};
function ragOf(actual, greenMin, yellowMin) {
  const y = yellowMin !== undefined ? yellowMin : greenMin * 0.8;
  if (actual >= greenMin) return "green";
  if (actual >= y) return "yellow";
  return "red";
}

// ─── Components ───────────────────────────────────────────────────────────────

function TargetCard({ label, value, targetLabel, status, detail, onClick }) {
  const c = RAG[status] || RAG.red;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`rounded-xl border ${c.border} ${c.bg} p-3 flex flex-col gap-1 ${onClick ? "cursor-pointer transition-shadow hover:shadow-md" : ""}`}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="text-[12.5px] font-semibold text-[#0f3d24] leading-tight">{label}</span>
        <span className={`shrink-0 mt-0.5 w-2.5 h-2.5 rounded-full ${c.dot}`} title={c.label} />
      </div>
      <div className={`text-[24px] font-extrabold tabular-nums leading-none ${status === "green" ? "text-emerald-700" : "text-red-600"}`}>{value}</div>
      <div className="text-[11px] text-muted">Target: {targetLabel}</div>
      {detail && <div className="text-[11px] text-slate-500">{detail}</div>}
    </div>
  );
}

function MetricCard({ label, value, pctText, pctLabel, accent, onClick, testId }) {
  return (
    <div
      role="button" tabIndex={0}
      className={`rounded-xl border p-3.5 cursor-pointer transition-shadow hover:shadow-md ${accent ? "bg-[#1a5c38] border-[#0f3d24]" : "bg-white border-line"}`}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); }}
      data-testid={testId}
    >
      <div className={`text-[12px] font-semibold mb-1.5 ${accent ? "text-emerald-200" : "text-muted"}`}>{label}</div>
      <div className="flex items-baseline justify-between gap-2">
        <div className={`text-[28px] font-extrabold tabular-nums leading-none ${accent ? "text-white" : "text-[#0f3d24]"}`}>{value}</div>
        {pctText && (
          <div className={`text-[22px] font-bold tabular-nums leading-none ${accent ? "text-emerald-200" : "text-slate-400"}`}>{pctText}</div>
        )}
      </div>
      {pctLabel && <div className={`text-[11px] mt-1 ${accent ? "text-emerald-300" : "text-muted"}`}>{pctLabel}</div>}
    </div>
  );
}

function BreakdownBar({ title, rows, colorFor, metric = "orders", fullLabels = false, onRowClick, testId }) {
  const data = (rows || [])
    .filter((r) => Number(r[metric]) > 0)
    .sort((a, b) => Number(b[metric]) - Number(a[metric]));
  const total = data.reduce((s, r) => s + (Number(r[metric]) || 0), 0);
  const maxVal = data.length > 0 ? Number(data[0][metric]) : 1;
  return (
    <div className="card-white p-4 flex flex-col" data-testid={testId}>
      <div className="text-[13px] font-bold text-[#0f3d24] mb-3">{title}</div>
      {total === 0 ? (
        <div className="text-[13px] text-muted italic">No data for this period.</div>
      ) : (
        <div className="flex flex-col flex-1 justify-between gap-1.5">
          {data.map((r) => {
            const val = Number(r[metric]);
            const pct = (val / total) * 100;
            const barW = maxVal > 0 ? (val / maxVal) * 100 : 0;
            const displayLabel = fullLabels ? (r.label || "—") : titleize(r.label || "—");
            const color = colorFor(r);
            return (
              <div
                key={r.label}
                className={`flex items-center gap-2 text-[13px] rounded-md transition-colors ${onRowClick ? "cursor-pointer hover:bg-[#f5f0eb]/80 -mx-1 px-1" : ""}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") onRowClick(r); } : undefined}
              >
                <div
                  className={`shrink-0 font-medium text-[#0f3d24] ${fullLabels ? "text-left" : "text-right"}`}
                  style={{
                    width: fullLabels ? "130px" : "80px",
                    minWidth: fullLabels ? "130px" : undefined,
                    whiteSpace: fullLabels ? "normal" : "nowrap",
                    overflow: fullLabels ? undefined : "hidden",
                    textOverflow: fullLabels ? undefined : "ellipsis",
                    lineHeight: "1.25",
                  }}
                  title={displayLabel}
                >
                  {displayLabel}
                </div>
                <div className="flex-1 h-8 bg-[#f5f0eb] rounded overflow-hidden">
                  <div
                    className="h-full rounded transition-all"
                    style={{ width: `${barW}%`, backgroundColor: color }}
                  />
                </div>
                <div className="w-[68px] shrink-0 text-right tabular-nums text-muted text-[12px]">
                  {fmtQty(val)} · {pct.toFixed(0)}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PieMix({ title, rows, colorFor, metric = "units", testId }) {
  const data = (rows || [])
    .filter((r) => Number(r[metric]) > 0)
    .sort((a, b) => Number(b[metric]) - Number(a[metric]));
  const total = data.reduce((s, r) => s + (Number(r[metric]) || 0), 0);
  const pieData = data.map((r) => ({
    name: r.label || "—",
    value: Number(r[metric]),
    color: colorFor(r),
    pct: total > 0 ? ((Number(r[metric]) / total) * 100).toFixed(0) : "0",
  }));

  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, index }) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.55;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    const entry = pieData[index];
    if (!entry || Number(entry.pct) < 5) return null;
    return (
      <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: 13, fontWeight: 700, pointerEvents: "none" }}>
        {entry.pct}%
      </text>
    );
  };

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0];
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-[12.5px]">
        <div className="font-semibold text-[#0f3d24]">{d.name}</div>
        <div className="text-muted">{fmtQty(d.value)} units · {total > 0 ? ((d.value / total) * 100).toFixed(0) : 0}%</div>
      </div>
    );
  };

  const renderLegend = () => (
    <div className="flex flex-col gap-2 justify-center">
      {pieData.map((d) => (
        <div key={d.name} className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
          <span className="text-[12.5px] font-medium text-[#0f3d24]">{d.name}</span>
          <span className="ml-auto text-[12.5px] tabular-nums text-muted">
            {fmtQty(d.value)} · <span className="font-semibold text-[#0f3d24]">{d.pct}%</span>
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="card-white p-4" data-testid={testId}>
      <div className="text-[13px] font-bold text-[#0f3d24] mb-3">{title}</div>
      {total === 0 ? (
        <div className="text-[13px] text-muted italic">No data for this period.</div>
      ) : (
        <div className="flex items-center gap-4">
          <div style={{ flexShrink: 0 }}>
            <PieChart width={200} height={200}>
              <Pie
                data={pieData}
                cx={100}
                cy={100}
                outerRadius={90}
                innerRadius={38}
                dataKey="value"
                labelLine={false}
                label={renderCustomLabel}
                stroke="none"
              >
                {pieData.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </div>
          <div className="flex-1 min-w-0">
            {renderLegend()}
          </div>
        </div>
      )}
    </div>
  );
}

function StageSnapshot({ byStage, terminalKeys }) {
  const rows = (byStage || []).filter(
    (s) => !terminalKeys.has(s.stage_key) && Number(s.units) > 0
  );
  const total = rows.reduce((s, r) => s + (Number(r.units) || 0), 0);
  return (
    <div className="card-white p-4" data-testid="prod-ov-stage-snapshot">
      <div className="text-[13px] font-bold text-[#0f3d24] mb-3">Where the work is (units in progress)</div>
      {rows.length === 0 ? (
        <div className="text-[13px] text-muted italic">Nothing currently in progress.</div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((r) => {
            const pct = total > 0 ? (Number(r.units) / total) * 100 : 0;
            return (
              <div key={r.stage_key}>
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="font-semibold text-[#0f3d24]">
                    {r.stage_name}
                    {r.live && <span className="ml-1.5 text-[11px] font-medium text-emerald-600">live</span>}
                  </span>
                  <span className="text-muted whitespace-nowrap tabular-nums text-[12.5px]">
                    {fmtQty(r.units)} u · {fmtQty(r.orders)} orders · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-panel/70 overflow-hidden">
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

function DeliveryOutlook({ overdue, dueSoon, onOpenReport, onDrillLanding }) {
  const Section = ({ icon: Icon, tone, title, rows, emptyText, testId }) => (
    <div data-testid={testId}>
      <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${tone} mb-1.5`}>
        <Icon size={14} weight="bold" />{title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[13px] text-muted italic">{emptyText}</div>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 6).map((o) => (
            <div key={o.order_ref} className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="truncate">
                <span className="font-semibold text-[#0f3d24]">{o.order_ref}</span>
                <span className="text-muted"> · {o.style_name || o.product_name || o.style_number || "—"}</span>
                {o.style_number && (o.style_name || o.product_name) &&
                  <span className="text-muted text-[11px]"> ({o.style_number})</span>}
              </span>
              <span className="text-muted whitespace-nowrap tabular-nums">
                {fmtQty(o.order_qty)} u · {fmtDate(o.expected_delivery_date)}
              </span>
            </div>
          ))}
          {rows.length > 6 && (
            typeof onOpenReport === "function"
              ? <button type="button" onClick={onOpenReport} className="text-[12px] font-semibold text-brand hover:underline">+{rows.length - 6} more in the Production Report</button>
              : <div className="text-[12px] text-muted">+{rows.length - 6} more</div>
          )}
        </div>
      )}
    </div>
  );
  return (
    <div className="card-white p-4 space-y-4" data-testid="prod-ov-delivery">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-bold text-[#0f3d24]">Delivery outlook (active orders)</div>
        {(overdue.length + dueSoon.length) > 0 && (
          <button type="button" onClick={onDrillLanding} className="text-[12px] font-semibold text-brand hover:underline">
            View all & export
          </button>
        )}
      </div>
      <Section icon={WarningCircle} tone="text-rose-600" title={`Overdue (${overdue.length})`} rows={overdue} emptyText="Nothing overdue." testId="prod-ov-overdue" />
      <Section icon={CalendarCheck} tone="text-emerald-700" title={`Due in the next 14 days (${dueSoon.length})`} rows={dueSoon} emptyText="Nothing due in the next two weeks." testId="prod-ov-due-soon" />
    </div>
  );
}

function DrillModal({ title, subtitle, rows, columns, onClose }) {
  const exportExcel = () => {
    const data = rows.map((r) => {
      const row = {};
      for (const c of columns) { row[c.label] = c.csv ? c.csv(r) : (r[c.key] ?? ""); }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    XLSX.writeFile(wb, `${title.replace(/\s+/g, "-").toLowerCase()}.xlsx`);
  };
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" data-testid="drill-modal">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-200">
          <div>
            <div className="text-[15px] font-bold text-[#0f3d24]">{title}</div>
            {subtitle && <div className="text-[12.5px] text-muted mt-0.5">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={exportExcel} disabled={rows.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#1a5c38] text-white text-[12.5px] font-semibold px-3 py-1.5 hover:bg-[#0f3d24] disabled:opacity-40"
              data-testid="drill-export-excel">
              <DownloadSimple size={14} weight="bold" />Export Excel
            </button>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100" data-testid="drill-close">
              <X size={16} weight="bold" />
            </button>
          </div>
        </div>
        <div className="overflow-auto flex-1 px-6 py-3">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-muted italic">No orders in this selection.</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  {columns.map((c) => (
                    <th key={c.key} className={`py-2 pr-4 ${c.numeric ? "text-right" : ""} whitespace-nowrap`}>{c.label}</th>
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
        <div className="px-6 py-3 border-t border-slate-200 text-[12px] text-muted">
          {rows.length} row{rows.length !== 1 ? "s" : ""}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ProductionOverview({ onOpenReport }) {
  const [data, setData] = useState(null);
  const [flow, setFlow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drill, setDrill] = useState(null);

  // Date filter — default to Last Week (Mon-Sun)
  const [dateFrom, setDateFrom] = useState(() => {
    const ws = weekStartOf(new Date());
    const start = new Date(ws); start.setDate(ws.getDate() - 7);
    return toISO(start);
  });
  const [dateTo, setDateTo] = useState(() => {
    const ws = weekStartOf(new Date());
    const end = new Date(ws); end.setDate(ws.getDate() - 1);
    return toISO(end);
  });
  const [activePreset, setActivePreset] = useState("thisWeek");

  const applyPreset = useCallback((preset) => {
    const today = new Date();
    const ws = weekStartOf(today);
    setActivePreset(preset);
    if (preset === "lastWeek") {
      const start = new Date(ws); start.setDate(ws.getDate() - 7);
      const end = new Date(ws); end.setDate(ws.getDate() - 1);
      setDateFrom(toISO(start)); setDateTo(toISO(end));
    } else if (preset === "thisWeek") {
      setDateFrom(toISO(ws)); setDateTo(toISO(today));
    } else if (preset === "thisMonth") {
      setDateFrom(toISO(new Date(today.getFullYear(), today.getMonth(), 1)));
      setDateTo(toISO(today));
    }
  }, []);

  const onDateChange = (from, to) => {
    setActivePreset("custom");
    if (from !== undefined) setDateFrom(from);
    if (to !== undefined) setDateTo(to);
  };

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true); else setLoading(true);
    setError(null);
    const opts = force ? { forceFresh: true } : {};
    try {
      const [sr, fr] = await Promise.all([
        api.get("/production/summary", opts),
        api.get("/production/flow", opts),
      ]);
      setData(sr.data);
      setFlow(fr.data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to load");
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const orders = data?.orders || [];
  const terminalKeys = useMemo(
    () => new Set((flow?.stages || []).filter((s) => s.is_terminal).map((s) => s.stage_key)),
    [flow]
  );

  const isComplete = useCallback((o) => {
    const sq = o.stage_qty || {};
    let term = 0, nonTerm = 0;
    for (const [k, v] of Object.entries(sq)) {
      const n = Number(v) || 0;
      if (terminalKeys.has(k)) term += n; else nonTerm += n;
    }
    return term > 0 && nonTerm === 0;
  }, [terminalKeys]);

  const activeOrders = useMemo(() => orders.filter((o) => !isComplete(o)), [orders, isComplete]);

  const { overdue, dueSoon } = useMemo(() => {
    const toLocalISO = (d) => toISO(d);
    const now = new Date();
    const todayStr = toLocalISO(now);
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + 14);
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
    od.sort(byDate); ds.sort(byDate);
    return { overdue: od, dueSoon: ds };
  }, [activeOrders]);

  // All orders placed within the selected date window
  const rangeOrders = useMemo(() => {
    return orders.filter((o) => {
      if (!o.date_ordered) return false;
      const d = String(o.date_ordered).slice(0, 10);
      return d >= dateFrom && d <= dateTo;
    });
  }, [orders, dateFrom, dateTo]);

  // Full aggregation over rangeOrders — powers ALL visuals
  const rt = useMemo(() => {
    const byLc = {}, byCat = {}, bySub = {}, byState = {};
    const styleSet = new Set(), newStyleSet = new Set();
    let units = 0, printUnits = 0, knitUnits = 0, dressUnits = 0;

    for (const o of rangeOrders) {
      const qty = Number(o.order_qty) || 0;
      units += qty;

      const lc = o.lifecycle || "Unspecified";
      if (!byLc[lc]) byLc[lc] = { orders: 0, units: 0, label: lc, styleSet: new Set() };
      byLc[lc].orders++;
      byLc[lc].units += qty;
      if (o.style_name) byLc[lc].styleSet.add(o.style_name);

      const cat = o.category || "Unspecified";
      if (!byCat[cat]) byCat[cat] = { label: cat, orders: 0, units: 0 };
      byCat[cat].orders++; byCat[cat].units += qty;

      const sub = o.product_type || "Unspecified";
      if (!bySub[sub]) bySub[sub] = { label: sub, category: cat, orders: 0, units: 0 };
      bySub[sub].orders++; bySub[sub].units += qty;

      const state = o.state || "Unspecified";
      if (!byState[state]) byState[state] = { label: state, orders: 0, units: 0 };
      byState[state].orders++; byState[state].units += qty;

      if (o.style_name) styleSet.add(o.style_name);
      if (lc === "New" && o.style_name) newStyleSet.add(o.style_name);

      // Print: use backend print_plain field when available; fall back to
      // style_number / style_name keyword heuristics for orders not yet in
      // the product master.
      const isPrint = o.print_plain
        ? o.print_plain === "Print"
        : /PR\d*$/i.test(o.style_number || "") || /\bprint\b/i.test(o.style_name || "");
      if (isPrint) printUnits += qty;

      // Knit: use backend fabric_construction when available; fall back to
      // style_name keyword heuristics for styles missing from product master.
      const isKnit = o.fabric_construction
        ? o.fabric_construction === "Knit"
        : /\b(jersey|ponte|rib\b|ribbed|sweater|knit|spandex|lycra|fleece)\b/i.test(o.style_name || "");
      if (isKnit) knitUnits += qty;

      // Dresses
      const isDress = cat === "Dresses" || /dress/i.test(sub);
      if (isDress) dressUnits += qty;
    }

    // Build sub-cat → color map: shade = function of rank within category
    const catSubs = {};
    for (const [sub, d] of Object.entries(bySub)) {
      if (!catSubs[d.category]) catSubs[d.category] = [];
      catSubs[d.category].push({ sub, units: d.units });
    }
    const subColorMap = {};
    const shadeFactors = [0, 0.22, 0.40, 0.54, 0.63, 0.70, 0.76, 0.80];
    for (const [cat, subs] of Object.entries(catSubs)) {
      subs.sort((a, b) => b.units - a.units);
      const base = CATEGORY_COLORS[cat] || "#9ca3af";
      subs.forEach(({ sub }, i) => {
        subColorMap[sub] = lightenHex(base, shadeFactors[Math.min(i, shadeFactors.length - 1)]);
      });
    }

    return {
      orders: rangeOrders.length,
      units,
      styles: styleSet.size,
      printUnits,
      knitUnits,
      dressUnits,
      newStyles: newStyleSet.size,
      byLc,
      byCat: Object.values(byCat).sort((a, b) => b.units - a.units),
      bySub: Object.values(bySub).sort((a, b) => b.units - a.units),
      byState: Object.values(byState).sort((a, b) => b.orders - a.orders),
      subColorMap,
    };
  }, [rangeOrders]);

  const inProgressUnits = useMemo(
    () => (data?.by_stage || []).reduce((s, r) => (terminalKeys.has(r.stage_key) ? s : s + (Number(r.units) || 0)), 0),
    [data, terminalKeys]
  );

  const windowLabel = `${dateFrom} → ${dateTo}`;

  // ─── Derived stats for KPI cards ──────────────────────────────────────────
  const lcNew    = rt.byLc["New"]           || { orders: 0, units: 0 };
  const lcRep    = rt.byLc["Replenishment"] || { orders: 0, units: 0 };
  const lcReo    = rt.byLc["Re-order"]      || { orders: 0, units: 0 };
  const totalOrders = rt.orders;
  const totalUnits  = rt.units;
  const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—";

  // ─── Targets (per-week) ───────────────────────────────────────────────────
  const printPct   = totalUnits > 0 ? (rt.printUnits / totalUnits) * 100 : 0;
  const knitPct    = totalUnits > 0 ? (rt.knitUnits  / totalUnits) * 100 : 0;
  const dressPct   = totalUnits > 0 ? (rt.dressUnits / totalUnits) * 100 : 0;
  const newUnitPct = totalUnits > 0 ? ((lcNew.units) / totalUnits) * 100 : 0;

  const targets = [
    {
      label: "Print Units",
      value: `${fmtQty(rt.printUnits)}  (${printPct.toFixed(0)}%)`,
      targetLabel: "2,400–3,200 · 30–40%",
      status: ragOf(rt.printUnits, 2400, 1920),
      detail: printPct >= 30 && printPct <= 40 ? "% in range" : `% ${printPct.toFixed(0)}% (target 30–40%)`,
      drillFilter: (rows) => rows.filter((o) => o.print_plain
        ? o.print_plain === "Print"
        : /PR\d*$/i.test(o.style_number || "") || /\bprint\b/i.test(o.style_name || "")),
    },
    {
      label: "Knit Units",
      value: `${fmtQty(rt.knitUnits)}  (${knitPct.toFixed(0)}%)`,
      targetLabel: ">35% of total",
      status: ragOf(knitPct, 35, 28),
      drillFilter: (rows) => rows.filter((o) => o.fabric_construction
        ? o.fabric_construction === "Knit"
        : /\b(jersey|ponte|rib\b|ribbed|sweater|knit|spandex|lycra|fleece)\b/i.test(o.style_name || "")),
    },
    {
      label: "Dress Units",
      value: `${fmtQty(rt.dressUnits)}  (${dressPct.toFixed(0)}%)`,
      targetLabel: "≥2,800 units · >35%",
      status: rt.dressUnits >= 2800 ? "green" : rt.dressUnits >= 2240 ? "yellow" : "red",
      detail: dressPct >= 35 ? "% on track" : `% ${dressPct.toFixed(0)}% (target >35%)`,
      drillFilter: (rows) => rows.filter((o) => (o.category || "Unspecified") === "Dresses" || /dress/i.test(o.product_type || "")),
    },
    {
      label: "New Units %",
      value: `${fmtQty(lcNew.units)}  (${newUnitPct.toFixed(0)}%)`,
      targetLabel: ">35% of total",
      status: ragOf(newUnitPct, 35, 28),
      drillFilter: (rows) => rows.filter((o) => o.lifecycle === "New"),
    },
    {
      label: "New Styles",
      value: fmtQty(rt.newStyles),
      targetLabel: ">6 styles",
      status: ragOf(rt.newStyles, 6, 5),
      drillFilter: (rows) => rows.filter((o) => o.lifecycle === "New"),
    },
    {
      label: "Replenishment Units",
      value: fmtQty(lcRep.units),
      targetLabel: ">3,000 units",
      status: ragOf(lcRep.units, 3000, 2400),
      drillFilter: (rows) => rows.filter((o) => o.lifecycle === "Replenishment"),
    },
    {
      label: "Re-order Units",
      value: fmtQty(lcReo.units),
      targetLabel: ">1,000 units",
      status: ragOf(lcReo.units, 1000, 800),
      drillFilter: (rows) => rows.filter((o) => o.lifecycle === "Re-order"),
    },
    {
      label: "Total In-house Units",
      value: fmtQty(totalUnits),
      targetLabel: ">8,000 units",
      status: ragOf(totalUnits, 8000, 6400),
      drillFilter: (rows) => rows,
    },
  ];

  // ─── Drill columns ─────────────────────────────────────────────────────────
  const ORDER_COLS = [
    { key: "order_ref", label: "Order Ref", render: (r) => <span className="font-semibold">{r.order_ref || "—"}</span> },
    {
      key: "style_name", label: "Style",
      render: (r) => <span className="font-medium">{r.style_name || r.product_name || "—"}</span>,
      csv: (r) => r.style_name || r.product_name || "",
    },
    { key: "style_number", label: "Style No.", render: (r) => <span className="font-mono text-[12px] text-muted">{r.style_number || "—"}</span>, csv: (r) => r.style_number || "" },
    { key: "lifecycle", label: "Type", render: (r) => r.lifecycle || "—" },
    { key: "category", label: "Category", render: (r) => r.category || "Unspecified" },
    { key: "product_type", label: "Subcategory", render: (r) => r.product_type || "Unspecified" },
    { key: "fabric_construction", label: "Knit/Woven", render: (r) => r.fabric_construction || "—" },
    { key: "print_plain", label: "Print/Plain", render: (r) => r.print_plain || "—" },
    { key: "order_qty", label: "Qty", numeric: true, render: (r) => fmtQty(r.order_qty), csv: (r) => r.order_qty },
    { key: "date_ordered", label: "Date Ordered", render: (r) => fmtDate(r.date_ordered), csv: (r) => r.date_ordered || "" },
    { key: "expected_delivery_date", label: "Expected Delivery", render: (r) => fmtDate(r.expected_delivery_date), csv: (r) => r.expected_delivery_date || "" },
    { key: "state", label: "State", render: (r) => titleize(r.state || "—") },
  ];

  const DELIVERY_COLS = [
    { key: "order_ref", label: "Order Ref", render: (r) => <span className="font-semibold">{r.order_ref || "—"}</span> },
    {
      key: "style_name", label: "Style",
      render: (r) => <span className="font-medium">{r.style_name || r.product_name || "—"}</span>,
      csv: (r) => r.style_name || r.product_name || "",
    },
    { key: "style_number", label: "Style No.", render: (r) => <span className="font-mono text-[12px] text-muted">{r.style_number || "—"}</span>, csv: (r) => r.style_number || "" },
    { key: "lifecycle", label: "Type", render: (r) => r.lifecycle || "—" },
    { key: "order_qty", label: "Qty", numeric: true, render: (r) => fmtQty(r.order_qty), csv: (r) => r.order_qty },
    {
      key: "expected_delivery_date", label: "Expected Delivery",
      render: (r) => {
        const d = String(r.expected_delivery_date || "").slice(0, 10);
        const today = isoDaysAgo(0);
        return <span className={d < today ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold"}>{fmtDate(r.expected_delivery_date)}</span>;
      },
      csv: (r) => r.expected_delivery_date || "",
    },
    {
      key: "_ds", label: "Status",
      render: (r) => {
        const d = String(r.expected_delivery_date || "").slice(0, 10);
        const today = isoDaysAgo(0);
        return d < today
          ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700">Overdue</span>
          : <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700">Due soon</span>;
      },
      csv: (r) => (String(r.expected_delivery_date || "").slice(0, 10) < isoDaysAgo(0) ? "Overdue" : "Due soon"),
    },
    { key: "state", label: "State", render: (r) => titleize(r.state || "—") },
  ];

  const openDrill = (title, rows, columns, subtitle) =>
    setDrill({ title, subtitle: subtitle || `${rows.length} orders · ${windowLabel}`, rows, columns });

  const completedCount = orders.length - activeOrders.length;

  if (loading) return <Loading label="Loading buying overview…" />;
  if (error) return <ErrorBox message={error} />;

  const PRESETS = [
    { key: "lastWeek", label: "Last Week" },
    { key: "thisWeek", label: "This Week" },
    { key: "thisMonth", label: "This Month" },
  ];

  return (
    <div className="space-y-3" data-testid="production-overview">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle
          title="Buying Orders at a Glance"
          subtitle={`Whole order book · ${fmtQty(completedCount)} completed, ${fmtQty(activeOrders.length)} active · ${fmtQty(rangeOrders.length)} orders placed ${dateFrom} → ${dateTo} (${fmtQty(rt.units)} units)`}
        />
        <button
          type="button" onClick={() => load(true)} disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-2 rounded-md disabled:opacity-50 shrink-0"
          data-testid="prod-ov-refresh"
        >
          <ArrowsClockwise size={14} weight="bold" className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* ── Date filter ── */}
      <div className="card-white px-3 py-2.5 flex flex-wrap items-center gap-2" data-testid="prod-ov-date-range">
        <span className="text-[13px] font-semibold text-[#0f3d24]">Date ordered</span>
        <div className="flex items-center gap-1">
          {PRESETS.map(({ key, label }) => (
            <button key={key} type="button"
              onClick={() => applyPreset(key)}
              className={`rounded-md border px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                activePreset === key
                  ? "border-[#1a5c38] bg-[#1a5c38] text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              }`}
              data-testid={`prod-ov-preset-${key}`}
            >{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-1">
          <span className="text-[12px] text-slate-500">From</span>
          <input type="date"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[12px]"
            value={dateFrom} max={dateTo}
            onChange={(e) => onDateChange(e.target.value, undefined)}
            data-testid="prod-ov-date-from"
          />
          <span className="text-[12px] text-slate-500">To</span>
          <input type="date"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[12px]"
            value={dateTo} min={dateFrom}
            onChange={(e) => onDateChange(undefined, e.target.value)}
            data-testid="prod-ov-date-to"
          />
        </div>
      </div>

      {/* ── Styles KPI row ── */}
      <div>
        <div className="text-[12px] font-semibold text-muted uppercase tracking-wide mb-1.5 px-0.5">Styles</div>
        <div className="grid gap-2 grid-cols-1 lg:grid-cols-3">
          <MetricCard
            testId="prod-ov-kpi-styles-total"
            accent
            label="Total Styles"
            value={fmtQty(rt.styles)}
            sub={`${fmtQty(totalOrders)} buying orders`}
            onClick={() => openDrill("Buying Orders", rangeOrders, ORDER_COLS)}
          />
          <MetricCard
            testId="prod-ov-kpi-styles-replen"
            label="Replenishment Styles"
            value={fmtQty(lcRep.orders)}
            pctText={pct(lcRep.orders, totalOrders)}
            pctLabel="of orders"
            onClick={() => openDrill("Replenishment Orders", rangeOrders.filter((o) => o.lifecycle === "Replenishment"), ORDER_COLS)}
          />
          <MetricCard
            testId="prod-ov-kpi-styles-reorder"
            label="Re-order Styles"
            value={fmtQty(lcReo.orders)}
            pctText={pct(lcReo.orders, totalOrders)}
            pctLabel="of orders"
            onClick={() => openDrill("Re-order Orders", rangeOrders.filter((o) => o.lifecycle === "Re-order"), ORDER_COLS)}
          />
        </div>
      </div>

      {/* ── Units KPI row ── */}
      <div>
        <div className="text-[12px] font-semibold text-muted uppercase tracking-wide mb-1.5 px-0.5">Units</div>
        <div className="grid gap-2 grid-cols-1">
          <MetricCard
            testId="prod-ov-kpi-units-total"
            accent
            label="Total Units"
            value={fmtQty(totalUnits)}
            onClick={() => openDrill("Units Ordered", [...rangeOrders].sort((a, b) => (Number(b.order_qty) || 0) - (Number(a.order_qty) || 0)), ORDER_COLS)}
          />
        </div>
      </div>

      {/* ── Weekly target tracker ── */}
      <div>
        <div className="text-[12px] font-semibold text-muted uppercase tracking-wide mb-1.5 px-0.5">
          Weekly Targets
          <span className="ml-2 font-normal normal-case text-[11px]">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1" />On Track
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1 ml-2" />&gt;80%
            <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1 ml-2" />Off Track
          </span>
        </div>
        <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
          {targets.map((t) => (
            <TargetCard
              key={t.label}
              {...t}
              onClick={t.drillFilter
                ? () => openDrill(t.label, t.drillFilter(rangeOrders), ORDER_COLS, windowLabel)
                : undefined}
            />
          ))}
        </div>
      </div>

      {/* ── Order type mix + state ── */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <PieMix
          title="Order type mix (by units)"
          rows={Object.values(rt.byLc)}
          metric="units"
          colorFor={(r) => LIFECYCLE_HEX[r.label] || "#9ca3af"}
          testId="prod-ov-lifecycle-mix"
        />
        <PieMix
          title="Buying-order state (by orders)"
          rows={rt.byState}
          metric="orders"
          colorFor={(r) => STATE_HEX[r.label] || "#9ca3af"}
          testId="prod-ov-state-mix"
        />
      </div>

      {/* ── Category + sub-category breakdown ── */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        <BreakdownBar
          title="Category breakdown (by units)"
          rows={rt.byCat}
          metric="units"
          colorFor={(r) => CATEGORY_COLORS[r.label] || "#9ca3af"}
          onRowClick={(r) => openDrill(
            `Category: ${titleize(r.label)}`,
            rangeOrders.filter((o) => (o.category || "Unspecified") === r.label),
            ORDER_COLS,
            `${fmtQty(r.units)} units · ${dateFrom} → ${dateTo}`
          )}
          testId="prod-ov-category-mix"
        />
        <BreakdownBar
          title="Product Sub Category breakdown (by units)"
          rows={rt.bySub}
          metric="units"
          colorFor={(r) => rt.subColorMap[r.label] || "#9ca3af"}
          fullLabels
          onRowClick={(r) => openDrill(
            `Subcategory: ${r.label}`,
            rangeOrders.filter((o) => (o.product_type || "Unspecified") === r.label),
            ORDER_COLS,
            `${fmtQty(r.units)} units · ${dateFrom} → ${dateTo}`
          )}
          testId="prod-ov-sub-category-mix"
        />
      </div>

      {/* ── Stage snapshot + delivery outlook ── */}
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

      {/* Drill modal */}
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
