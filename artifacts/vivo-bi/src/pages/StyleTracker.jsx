import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import {
  ArrowsClockwise,
  Archive,
  ArrowCounterClockwise,
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChatText,
  CheckCircle,
  Circle,
  ClockClockwise,
  PencilSimple,
  Plus,
  Table,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";

/**
 * Weekly Style Tracker — manually-maintained kanban of production styles by
 * launch ISO week. Current week + next 4; older weeks with incomplete styles
 * surface as "Overdue". Cards drag between week columns (HTML5 DnD).
 *
 * Enhancements in this version:
 * - Order Type badge (New / Re-Order / Replenishment), editable in form
 * - Per-style Notes panel (collapsible, append-only comments)
 * - Add / Delete gated to privileged users only
 * - Finishing-status options managed from DB (privileged users can add/rename)
 * - Auto deliver-by = order date + 14 days
 * - Warehouse transfer gate: status→Warehouse blocked unless ≥90% transferred
 * - Mark Done only enabled when status = Warehouse
 * - Clickable style name → fulfillment drill-down drawer
 */

const BRAND_BADGE = {
  VIVO: "bg-emerald-100 text-emerald-800 border-emerald-200",
  SBV: "bg-amber-100 text-amber-800 border-amber-200",
  STUDIO: "bg-violet-100 text-violet-800 border-violet-200",
};

const CATEGORY_BADGE = {
  WOVEN: "bg-sky-50 text-sky-700 border-sky-200",
  KNIT: "bg-pink-50 text-pink-700 border-pink-200",
};

const ORDER_TYPE_BADGE = {
  "New":          "bg-blue-100 text-blue-800 border-blue-200",
  "Re-Order":     "bg-amber-100 text-amber-800 border-amber-200",
  "Replenishment":"bg-teal-100 text-teal-800 border-teal-200",
};

const fmtUnits = (n) => (Number(n) || 0).toLocaleString();

const fmtShortDate = (iso) => {
  if (!iso) return null;
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return iso;
  }
};

const fmtRelTime = (iso) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)   return "just now";
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400)return `${Math.round(diff / 3600)}h ago`;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  } catch { return iso; }
};

const weekKey = (w) => `${w.iso_year}-${w.iso_week}`;

const weekPct = (w) =>
  w.total_units > 0 ? Math.round((100 * (w.completed_units || 0)) / w.total_units) : null;

const pctTone = (pct) =>
  pct === null ? "text-muted" : pct >= 100 ? "text-emerald-700" : pct >= 50 ? "text-amber-700" : "text-rose-700";

const barTone = (pct) =>
  pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-400";

const fulfillTone = (pct) => {
  if (pct === null || pct === undefined) return "text-muted";
  if (pct >= 90) return "text-emerald-700 font-semibold";
  if (pct >= 75) return "text-amber-700 font-semibold";
  return "text-rose-700 font-semibold";
};
const fulfillCellBg = (pct) => {
  if (pct === null || pct === undefined) return "";
  if (pct >= 90) return "bg-emerald-50";
  if (pct >= 75) return "bg-amber-50";
  return "bg-rose-50";
};

const isLateStyle = (style, today) =>
  !!(style?.deliver_by && today && !style.completed && style.deliver_by < today);

const ORDER_TYPE_COLORS = {
  "New":           { dot: "bg-blue-500",  text: "text-blue-800"  },
  "Re-Order":      { dot: "bg-amber-500", text: "text-amber-800" },
  "Replenishment": { dot: "bg-teal-500",  text: "text-teal-800"  },
};

function WeekStats({ week, compact = false }) {
  const pct = weekPct(week);
  const styles = week.styles || [];

  // Order type breakdown — by units
  const otUnits = {};
  let otTotal = 0;
  for (const s of styles) {
    const qty = parseInt(s.quantity || 0, 10);
    const key = s.order_type || "Unset";
    otUnits[key] = (otUnits[key] || 0) + qty;
    otTotal += qty;
  }
  const otEntries = Object.entries(otUnits).sort((a, b) => b[1] - a[1]);

  // Status breakdown — by style count
  const stCounts = {};
  for (const s of styles) {
    const key = s.status || "Unset";
    stCounts[key] = (stCounts[key] || 0) + 1;
  }
  const stEntries = Object.entries(stCounts).sort((a, b) => b[1] - a[1]);
  const stTotal = styles.length;

  return (
    <div className={compact ? "" : "mt-1.5"} data-testid={`week-stats-${weekKey(week)}`}>
      <div className="flex items-center justify-between gap-2 text-[10.5px] font-semibold text-[#0f3d24]">
        <span>{fmtUnits(week.total_units)} pcs · {week.count} style{week.count === 1 ? "" : "s"}</span>
        <span className={`font-bold ${pctTone(pct)}`}>
          {pct === null ? "—" : `${pct}%`} <span className="font-medium text-muted">in WH</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-line/70 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct === null ? "bg-line" : barTone(pct)}`}
          style={{ width: `${Math.min(pct || 0, 100)}%` }}
        />
      </div>
      {!compact && styles.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {/* Order type breakdown */}
          {otEntries.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {otEntries.map(([type, units]) => {
                const p = otTotal > 0 ? Math.round((units / otTotal) * 100) : 0;
                const col = ORDER_TYPE_COLORS[type];
                return (
                  <span key={type} className="flex items-center gap-1 text-[10px]">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${col?.dot || "bg-muted"}`} />
                    <span className={`font-semibold ${col?.text || "text-muted"}`}>{type}</span>
                    <span className="text-muted">{p}%</span>
                    <span className="text-muted/60">({fmtUnits(units)} pcs)</span>
                  </span>
                );
              })}
            </div>
          )}
          {/* Status breakdown */}
          {stEntries.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {stEntries.map(([status, count]) => {
                const p = stTotal > 0 ? Math.round((count / stTotal) * 100) : 0;
                return (
                  <span key={status} className="flex items-center gap-1 text-[10px]">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#1a5c38]/40 shrink-0" />
                    <span className="font-semibold text-[#0f3d24]">{status}</span>
                    <span className="text-muted">{p}%</span>
                    <span className="text-muted/60">({count})</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Table view */
function WeekTable({ weeks, today, finishingOptions, busyIds, onUpdate, isPrivileged }) {
  const statuses = finishingOptions.map((f) => f.label);
  const totals = weeks.reduce(
    (t, w) => ({
      count: t.count + w.count,
      units: t.units + (w.total_units || 0),
      cCount: t.cCount + (w.completed_count || 0),
      cUnits: t.cUnits + (w.completed_units || 0),
    }),
    { count: 0, units: 0, cCount: 0, cUnits: 0 }
  );
  const totPct = totals.units > 0 ? Math.round((100 * totals.cUnits) / totals.units) : null;
  const thCls = "px-3 py-2.5 font-bold";
  return (
    <div className="rounded-xl border border-line bg-white overflow-x-auto" data-testid="style-tracker-table-view">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted border-b border-line">
            <th className={thCls}>Style</th>
            <th className={thCls}>Brand</th>
            <th className={thCls}>Type</th>
            <th className={`${thCls} text-right`}>Qty</th>
            <th className={thCls}>Status</th>
            <th className={thCls}>Deliver by</th>
            <th className={`${thCls} text-center`}>In WH</th>
          </tr>
        </thead>
        <tbody>
          {weeks.filter((w) => w.count > 0).map((week) => {
            const wk = weekKey(week);
            const pct = weekPct(week);
            return (
              <React.Fragment key={wk}>
                <tr className={`border-y border-line ${week.overdue ? "bg-amber-50" : week.is_current ? "bg-brand/5" : "bg-panel/60"}`}>
                  <td className="px-3 py-2" colSpan={3}>
                    <span className="font-bold text-[12.5px] text-[#0f3d24]">{week.label}</span>
                    {week.is_current && <span className="ml-2 text-[9px] font-bold uppercase tracking-wide text-white bg-[#1a5c38] rounded-full px-1.5 py-0.5">This week</span>}
                    {week.overdue && <span className="ml-2 text-[9px] font-bold uppercase tracking-wide text-amber-800 bg-amber-200/80 border border-amber-300 rounded-full px-1.5 py-0.5">Overdue</span>}
                    <span className="ml-2 text-[11px] text-muted">{week.count} style{week.count === 1 ? "" : "s"}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-[#0f3d24]">{fmtUnits(week.total_units)}</td>
                  <td className="px-3 py-2 text-[11px] text-muted" colSpan={2}>
                    <div className="flex items-center gap-2 min-w-[160px]">
                      <div className="flex-1 h-1.5 rounded-full bg-line/70 overflow-hidden">
                        <div className={`h-full rounded-full ${pct === null ? "bg-line" : barTone(pct)}`} style={{ width: `${Math.min(pct || 0, 100)}%` }} />
                      </div>
                      <span className="whitespace-nowrap">{fmtUnits(week.completed_units || 0)} pcs in WH</span>
                    </div>
                  </td>
                  <td className={`px-3 py-2 text-center font-bold ${pctTone(pct)}`}>{pct === null ? "—" : `${pct}%`}</td>
                </tr>
                {week.styles.map((s) => {
                  const late = isLateStyle(s, today);
                  const busy = busyIds.has(s.id);
                  const canDone = s.status === "Warehouse";
                  return (
                    <tr key={s.id} className={`border-b border-line/60 hover:bg-panel/40 ${late ? "bg-rose-50/50" : ""}`}>
                      <td className="px-3 py-2 font-semibold text-[#0f3d24]">
                        {s.style_name}
                        {late && <span className="ml-2 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase text-rose-800 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5"><Warning size={9} weight="fill" /> Late</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${BRAND_BADGE[s.brand] || "bg-panel text-muted border-line"}`}>{s.brand}</span>
                      </td>
                      <td className="px-3 py-2">
                        {s.order_type && <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${ORDER_TYPE_BADGE[s.order_type] || "bg-panel text-muted border-line"}`}>{s.order_type}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">{fmtUnits(s.quantity)}</td>
                      <td className="px-3 py-2">
                        <StatusSelect style={s} statuses={statuses} busy={busy} onUpdate={onUpdate} />
                      </td>
                      <td className={`px-3 py-2 whitespace-nowrap ${late ? "font-semibold text-rose-700" : "text-muted"}`}>
                        {s.deliver_by ? fmtShortDate(s.deliver_by) : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => canDone && onUpdate(s, { completed: !s.completed })}
                          disabled={busy || (!s.completed && !canDone)}
                          title={!canDone && !s.completed ? "Style must be in Warehouse status before marking as done" : s.completed ? "Mark as not completed" : "Mark as completed"}
                          className="disabled:opacity-40"
                        >
                          {s.completed ? <CheckCircle size={17} weight="fill" className="text-emerald-600" /> : <Circle size={17} className={`${canDone ? "text-muted/60 hover:text-emerald-600" : "text-muted/30"}`} />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line bg-panel/70 font-bold text-[#0f3d24]">
            <td className="px-3 py-2.5" colSpan={3}>All weeks · {totals.count} style{totals.count === 1 ? "" : "s"} ({totals.cCount} in WH)</td>
            <td className="px-3 py-2.5 text-right">{fmtUnits(totals.units)}</td>
            <td className="px-3 py-2.5 text-[11px] text-muted font-semibold" colSpan={2}>{fmtUnits(totals.cUnits)} pcs in WH</td>
            <td className={`px-3 py-2.5 text-center ${pctTone(totPct)}`}>{totPct === null ? "—" : `${totPct}%`}</td>
          </tr>
        </tfoot>
      </table>
      {weeks.every((w) => w.count === 0) && (
        <div className="flex flex-col items-center gap-2 py-10 text-muted">
          <Table size={26} />
          <div className="text-[12.5px]">No styles on the board yet — add them from the Board view.</div>
        </div>
      )}
    </div>
  );
}

/** Single-week picker: dropdown + prev/next arrows */
function WeekPicker({ weeks, selectedKey, onSelect }) {
  const idx = weeks.findIndex((w) => weekKey(w) === selectedKey);
  const prev = idx > 0 ? weeks[idx - 1] : null;
  const next = idx < weeks.length - 1 ? weeks[idx + 1] : null;

  return (
    <div className="flex items-center gap-1.5" data-testid="week-picker">
      <button
        type="button"
        onClick={() => prev && onSelect(weekKey(prev))}
        disabled={!prev}
        title={prev ? `Go to ${prev.label}` : undefined}
        className="flex items-center justify-center w-7 h-7 rounded-lg border border-line bg-white text-muted hover:text-[#0f3d24] hover:bg-panel disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <CaretLeft size={13} weight="bold" />
      </button>

      <select
        value={selectedKey || ""}
        onChange={(e) => onSelect(e.target.value)}
        className="text-[12px] font-semibold text-[#0f3d24] bg-white border border-line rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand/40 min-w-[180px]"
        data-testid="week-picker-select"
      >
        {weeks.map((w) => {
          const wk = weekKey(w);
          const suffix = w.overdue ? " — Overdue" : w.is_current ? " — This week" : "";
          return (
            <option key={wk} value={wk}>
              {w.label}{suffix}
            </option>
          );
        })}
      </select>

      <button
        type="button"
        onClick={() => next && onSelect(weekKey(next))}
        disabled={!next}
        title={next ? `Go to ${next.label}` : undefined}
        className="flex items-center justify-center w-7 h-7 rounded-lg border border-line bg-white text-muted hover:text-[#0f3d24] hover:bg-panel disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <CaretRight size={13} weight="bold" />
      </button>
    </div>
  );
}

/** Board-level summary panel — compact chips for every week */
function WeekSummaryPanel({ weeks, selectedKey, onSelect }) {
  const [collapsed, setCollapsed] = useState(false);

  const nonEmptyWeeks = weeks.filter((w) => w.count > 0 || w.is_current);

  const allUnits = weeks.reduce((s, w) => s + (w.total_units || 0), 0);
  const allCompleted = weeks.reduce((s, w) => s + (w.completed_units || 0), 0);
  const allCount = weeks.reduce((s, w) => s + (w.count || 0), 0);
  const allPct = allUnits > 0 ? Math.round((100 * allCompleted) / allUnits) : null;

  return (
    <div className="rounded-xl border border-line bg-white overflow-hidden" data-testid="week-summary-panel">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11.5px] font-semibold text-[#0f3d24] hover:bg-panel/50 transition-colors"
        data-testid="week-summary-toggle"
      >
        <span className="flex items-center gap-2">
          <CalendarBlank size={13} weight="bold" />
          All-weeks overview
          <span className="font-normal text-muted">
            {allCount} style{allCount === 1 ? "" : "s"} · {fmtUnits(allUnits)} pcs · {allPct === null ? "—" : `${allPct}%`} in WH
          </span>
        </span>
        {collapsed ? <CaretDown size={12} weight="bold" /> : <CaretUp size={12} weight="bold" />}
      </button>

      {!collapsed && (
        <div className="border-t border-line px-3 py-2.5">
          {nonEmptyWeeks.length === 0 ? (
            <p className="text-[11.5px] text-muted italic">No styles on the board yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2" data-testid="week-summary-chips">
              {weeks.map((w) => {
                const wk = weekKey(w);
                const pct = weekPct(w);
                const isSelected = wk === selectedKey;
                const isEmpty = w.count === 0;

                let chipBg = "bg-panel/60 border-line";
                if (isSelected) chipBg = "bg-[#1a5c38] border-[#1a5c38]";
                else if (w.overdue) chipBg = "bg-amber-50 border-amber-300";
                else if (w.is_current) chipBg = "bg-brand/5 border-brand/40";

                const labelColor = isSelected ? "text-white" : "text-[#0f3d24]";
                const mutedColor = isSelected ? "text-white/70" : "text-muted";

                let barColor = "bg-line/60";
                if (!isEmpty && pct !== null) barColor = barTone(pct);

                const pctLabel = isEmpty ? "—" : pct === null ? "—" : `${pct}%`;

                return (
                  <button
                    key={wk}
                    type="button"
                    onClick={() => onSelect(wk)}
                    title={`${w.label}${w.overdue ? " — Overdue" : w.is_current ? " — This week" : ""}`}
                    className={`flex flex-col items-start rounded-lg border px-2.5 py-1.5 min-w-[108px] transition-all hover:shadow-sm ${chipBg} ${isSelected ? "shadow-sm" : ""} ${isEmpty ? "opacity-50" : ""}`}
                    data-testid={`week-chip-${wk}`}
                  >
                    <div className={`flex items-center gap-1.5 text-[11px] font-bold leading-tight ${labelColor}`}>
                      {w.label}
                      {w.is_current && !isSelected && (
                        <span className="text-[8px] font-bold uppercase tracking-wide text-white bg-[#1a5c38] rounded-full px-1 py-0.5 leading-none">Now</span>
                      )}
                      {w.overdue && !isSelected && (
                        <span className="text-[8px] font-bold uppercase tracking-wide text-amber-800 bg-amber-200 rounded-full px-1 py-0.5 leading-none">Late</span>
                      )}
                    </div>
                    <div className={`text-[10px] mt-0.5 ${mutedColor}`}>
                      {w.count} style{w.count === 1 ? "" : "s"} · {pctLabel} <span className={isSelected ? "text-white/60" : "text-muted/70"}>WH</span>
                    </div>
                    <div className="mt-1.5 w-full h-1 rounded-full bg-black/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isSelected ? "bg-white/80" : barColor}`}
                        style={{ width: `${Math.min(pct || 0, 100)}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline Order Type select on the style card */
function OrderTypeSelect({ style, orderTypes, busy, onUpdate }) {
  const handleChange = (e) => {
    const val = e.target.value || null;
    onUpdate(style, { order_type: val });
  };

  const badgeCls = style.order_type
    ? ORDER_TYPE_BADGE[style.order_type] || "bg-panel text-muted border-line"
    : "bg-white text-muted border-line";

  return (
    <select
      value={style.order_type || ""}
      onChange={handleChange}
      disabled={busy}
      className={`text-[11px] font-medium border rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50 w-full ${badgeCls}`}
      data-testid={`order-type-select-${style.id}`}
    >
      <option value="">— type —</option>
      {orderTypes.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}

/** Inline status select with warehouse-pct gate */
function StatusSelect({ style, statuses, busy, onUpdate, className = "" }) {
  const [checking, setChecking] = useState(false);
  const [whErr, setWhErr] = useState(null);

  const handleChange = async (e) => {
    const newStatus = e.target.value;
    setWhErr(null);
    if (newStatus === "Warehouse" && style.status !== "Warehouse") {
      setChecking(true);
      try {
        const { data } = await api.get(`/style-tracker/styles/${style.id}/warehouse-pct`, { forceFresh: true });
        if (!data.meets_threshold) {
          setWhErr(`Only ${data.pct}% transferred — need ≥90% to move to Warehouse`);
          setChecking(false);
          return;
        }
      } catch {
        // If check fails, let the server gate it
      }
      setChecking(false);
    }
    onUpdate(style, { status: newStatus });
  };

  return (
    <div>
      <select
        value={style.status}
        onChange={handleChange}
        disabled={busy || checking}
        className={`text-[11px] font-medium text-[#0f3d24] bg-white border border-line rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50 ${className}`}
      >
        {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {whErr && <div className="mt-1 text-[10px] text-rose-700">{whErr}</div>}
    </div>
  );
}

/** Finishing-options dropdown for privileged users: add + rename inline */
function FinishingOptionsSelect({ style, finishingOptions, busy, onUpdate, isPrivileged, onOptionsChange }) {
  const statuses = finishingOptions.map((f) => f.label);
  const [showAdd, setShowAdd] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [whErr, setWhErr] = useState(null);

  const handleChange = async (e) => {
    const newStatus = e.target.value;
    setWhErr(null);
    if (newStatus === "Warehouse" && style.status !== "Warehouse") {
      setChecking(true);
      try {
        const { data } = await api.get(`/style-tracker/styles/${style.id}/warehouse-pct`, { forceFresh: true });
        if (!data.meets_threshold) {
          setWhErr(`Only ${data.pct}% transferred to warehouse — need ≥90% to move to Warehouse`);
          setChecking(false);
          return;
        }
      } catch { /* fall through — server will gate it */ }
      setChecking(false);
    }
    onUpdate(style, { status: newStatus });
  };

  const addOption = async () => {
    const lbl = addLabel.trim();
    if (!lbl) return;
    setAddSaving(true);
    try {
      await api.post("/style-tracker/finishing-options", { label: lbl });
      setAddLabel("");
      setShowAdd(false);
      onOptionsChange();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to add option");
    } finally {
      setAddSaving(false);
    }
  };

  const startRename = (opt) => { setRenamingId(opt.id); setRenameLabel(opt.label); };

  const saveRename = async () => {
    const lbl = renameLabel.trim();
    if (!lbl || !renamingId) return;
    setRenameSaving(true);
    try {
      await api.post(`/style-tracker/finishing-options/${renamingId}`, { label: lbl });
      setRenamingId(null);
      onOptionsChange();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to rename option");
    } finally {
      setRenameSaving(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1">
        <select
          value={style.status}
          onChange={handleChange}
          disabled={busy || checking}
          className="flex-1 min-w-0 text-[11px] font-medium text-[#0f3d24] bg-white border border-line rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
        >
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          {!statuses.includes(style.status) && (
            <option value={style.status}>{style.status}</option>
          )}
        </select>
        {isPrivileged && (
          <>
            <button
              type="button"
              onClick={() => { setShowAdd((v) => !v); setShowManage(false); }}
              title="Add a new finishing option"
              className="shrink-0 text-muted/50 hover:text-brand p-1 rounded"
            >
              <Plus size={13} weight="bold" />
            </button>
            <button
              type="button"
              onClick={() => { setShowManage((v) => !v); setShowAdd(false); setRenamingId(null); }}
              title="Manage options (rename)"
              className={`shrink-0 p-1 rounded transition-colors ${showManage ? "text-brand" : "text-muted/40 hover:text-brand"}`}
            >
              <PencilSimple size={12} />
            </button>
          </>
        )}
      </div>
      {whErr && <div className="text-[10px] text-rose-700">{whErr}</div>}
      {isPrivileged && showAdd && (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addOption(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="New option label"
            className="flex-1 text-[11px] border border-line rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
          <button type="button" disabled={addSaving} onClick={addOption} className="text-[10px] font-semibold text-white bg-brand rounded px-1.5 py-1 disabled:opacity-50">Add</button>
          <button type="button" onClick={() => setShowAdd(false)} className="text-muted hover:text-danger"><X size={12} /></button>
        </div>
      )}
      {isPrivileged && showManage && renamingId === null && finishingOptions.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {finishingOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => startRename(opt)}
              title={`Rename "${opt.label}"`}
              className="flex items-center gap-0.5 text-[9px] text-muted/60 hover:text-brand border border-transparent hover:border-line rounded px-1 py-0.5"
            >
              <PencilSimple size={9} /> {opt.label}
            </button>
          ))}
        </div>
      )}
      {isPrivileged && renamingId !== null && (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={renameLabel}
            onChange={(e) => setRenameLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenamingId(null); }}
            className="flex-1 text-[11px] border border-line rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
          <button type="button" disabled={renameSaving} onClick={saveRename} className="text-[10px] font-semibold text-white bg-brand rounded px-1.5 py-1 disabled:opacity-50">Save</button>
          <button type="button" onClick={() => setRenamingId(null)} className="text-muted hover:text-danger"><X size={12} /></button>
        </div>
      )}
    </div>
  );
}

/** Notes panel for a style card */
function NotesPanel({ style, onNoteAdded }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const notes = style.notes || [];
  const count = notes.length;

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    try {
      const { data } = await api.post(`/style-tracker/styles/${style.id}/notes`, { text: t });
      setText("");
      onNoteAdded(style.id, data.note);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to add note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 border-t border-line/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[10.5px] font-semibold text-muted hover:text-[#0f3d24] w-full"
      >
        <ChatText size={13} className="shrink-0" />
        <span>Notes {count > 0 && <span className="inline-block min-w-[16px] text-center text-[9px] font-bold text-white bg-[#1a5c38] rounded-full px-1">{count}</span>}</span>
        {open ? <CaretUp size={10} className="ml-auto" /> : <CaretDown size={10} className="ml-auto" />}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {notes.length === 0 ? (
            <div className="text-[10.5px] text-muted/70 italic">No notes yet.</div>
          ) : (
            <div className="max-h-[120px] overflow-y-auto space-y-1.5 pr-0.5">
              {notes.map((n, i) => (
                <div key={i} className="text-[10.5px] text-[#0f3d24] leading-snug">
                  <span className="font-semibold">{n.author_email?.split("@")[0]}</span>
                  <span className="text-muted"> · {fmtRelTime(n.created_at)}</span>
                  <div className="mt-0.5 text-[10.5px]">{n.body}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-start gap-1">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
              placeholder="Add a note… (Ctrl+Enter to save)"
              rows={2}
              className="flex-1 text-[11px] bg-white border border-line rounded-md px-1.5 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-brand/40"
            />
            <button
              type="button"
              onClick={submit}
              disabled={saving || !text.trim()}
              className="text-[10px] font-semibold text-white bg-brand hover:bg-[#0f3d24] rounded-md px-2 py-1 disabled:opacity-50 shrink-0"
            >
              {saving ? "…" : "Add"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Fulfillment drill-down drawer (portal) */
function FulfillmentDrawer({ styleId, styleName, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    api.get(`/style-tracker/styles/${styleId}/fulfillment`, { forceFresh: true })
      .then(({ data: d }) => setData(d))
      .catch((e) => setErr(e?.response?.data?.detail || e.message || "Failed to load fulfillment data"))
      .finally(() => setLoading(false));
  }, [styleId]);

  const STAGE_ORDER = ["cutting","waiting_sewing","sewing","finishing","warehouse"];

  const activeStage = useMemo(() => {
    if (!data?.stages?.length) return null;
    const present = new Set(data.stages.map((s) => s.stage));
    for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
      if (present.has(STAGE_ORDER[i])) return STAGE_ORDER[i];
    }
    return null;
  }, [data]);

  const pivot = useMemo(() => {
    if (!data?.matrix?.length) return null;
    const SIZE_PREF = ["XXS","XS","S","M","L","XL","XXL","2XL","3XL","1X","2X","3X","4X",
                       "4","6","8","10","12","14","16","18","20","22","24","26"];
    const rank = (s) => {
      const i = SIZE_PREF.findIndex((p) => p === (s || "").toUpperCase());
      return i >= 0 ? i : 999;
    };
    const colours = [...new Set(data.matrix.map((r) => r.colour))].filter(Boolean).sort();
    const sizes   = [...new Set(data.matrix.map((r) => r.size))].filter(Boolean)
                      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

    const lookup = {};
    for (const row of data.matrix) {
      const total = (row.cutting_qty || 0) + (row.waiting_sewing_qty || 0) +
                    (row.sewing_qty  || 0) + (row.finishing_qty      || 0) +
                    (row.current_qty || 0);
      if (!lookup[row.colour]) lookup[row.colour] = {};
      lookup[row.colour][row.size] = (lookup[row.colour][row.size] || 0) + total;
    }

    const rows = colours.map((colour) => {
      const counts = sizes.map((sz) => lookup[colour]?.[sz] || 0);
      return { colour, counts, total: counts.reduce((a, b) => a + b, 0) };
    });
    const totCounts = sizes.map((_, si) => rows.reduce((s, r) => s + r.counts[si], 0));
    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    return { colours, sizes, rows, totCounts, grandTotal };
  }, [data]);

  const content = (
    <div
      className="fixed inset-0 z-50 flex"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-[700px] bg-white h-full shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line shrink-0">
          <div>
            <div className="font-bold text-[14px] text-[#0f3d24]">Fulfillment Drill-Down</div>
            <div className="text-[12px] text-muted mt-0.5">{styleName}</div>
          </div>
          <button type="button" onClick={onClose} className="text-muted hover:text-danger p-1"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {loading ? (
            <Loading label="Loading fulfillment data…" />
          ) : err ? (
            <ErrorBox message={err} />
          ) : !data?.has_data ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted">
              <div className="text-[13px]">No production data found for this style.</div>
            </div>
          ) : (
            <>
              {/* Journey Across the Line */}
              <div>
                <div className="text-[10.5px] font-bold text-[#0f3d24] uppercase tracking-widest mb-3">Journey Across the Line</div>
                <div className="flex items-start flex-wrap gap-y-3">
                  {STAGE_ORDER.map((sk, idx) => {
                    const stage = data.stages.find((s) => s.stage === sk);
                    if (!stage) return null;
                    const isActive = sk === activeStage;
                    const prevStageExists = idx > 0 && STAGE_ORDER.slice(0, idx).some(
                      (prev) => data.stages.find((s) => s.stage === prev)
                    );
                    return (
                      <div key={sk} className="flex items-start">
                        {prevStageExists && (
                          <div className="flex items-center mt-[22px] shrink-0">
                            <div className="w-4 h-px border-t border-dashed border-[#1a5c38]/30" />
                            <CaretRight size={12} className="text-[#1a5c38]/40 -ml-0.5" />
                          </div>
                        )}
                        <div className={`rounded-lg border-2 px-3.5 py-2.5 min-w-[118px] text-center shrink-0 ${
                          isActive
                            ? "border-[#1a5c38] bg-[#1a5c38]/5"
                            : "border-line bg-panel/40"
                        }`}>
                          <div className={`text-[9px] font-bold uppercase tracking-wide mb-1.5 ${isActive ? "text-[#1a5c38]" : "text-muted"}`}>
                            {stage.stage_name}
                          </div>
                          <div className={`text-[24px] font-bold leading-none ${isActive ? "text-[#1a5c38]" : "text-[#0f3d24]"}`}>
                            {stage.units.toLocaleString()}
                          </div>
                          <div className="text-[9px] text-muted mt-1">u entered</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Colours & Sizes pivot */}
              {pivot && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="text-[10.5px] font-bold text-[#0f3d24] uppercase tracking-widest">Colours &amp; Sizes</div>
                    <span className="rounded-full border border-[#1a5c38] text-[#1a5c38] text-[9.5px] font-bold px-2 py-0.5 leading-none">
                      {pivot.colours.length} COLOUR{pivot.colours.length !== 1 ? "S" : ""}
                    </span>
                    <span className="rounded-full border border-[#1a5c38] text-[#1a5c38] text-[9.5px] font-bold px-2 py-0.5 leading-none">
                      {pivot.sizes.length} SIZE{pivot.sizes.length !== 1 ? "S" : ""}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full text-[11.5px]">
                      <thead>
                        <tr className="bg-panel/60 border-b border-line">
                          <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-muted whitespace-nowrap">Colour</th>
                          {pivot.sizes.map((sz) => (
                            <th key={sz} className="px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wide text-muted">{sz}</th>
                          ))}
                          <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-muted">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pivot.rows.map((row, i) => (
                          <tr key={i} className="border-b border-line/50 hover:bg-panel/30">
                            <td className="px-3 py-1.5 whitespace-nowrap">{row.colour || "—"}</td>
                            {row.counts.map((n, si) => (
                              <td key={si} className="px-2 py-1.5 text-center text-muted">{n > 0 ? n : "—"}</td>
                            ))}
                            <td className="px-3 py-1.5 text-right font-bold text-[#0f3d24]">{row.total}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-line bg-panel/60">
                          <td className="px-3 py-2 font-bold text-[#0f3d24]">Total</td>
                          {pivot.totCounts.map((n, si) => (
                            <td key={si} className="px-2 py-2 text-center font-bold text-[#0f3d24]">{n > 0 ? n : "—"}</td>
                          ))}
                          <td className="px-3 py-2 text-right font-bold text-[#0f3d24]">{pivot.grandTotal}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

/** "Move to week" dropdown — lists every week except the one the card already lives in */
function MoveToWeekMenu({ style, weeks, busy, onUpdate }) {
  const [value, setValue] = useState("");

  const otherWeeks = weeks.filter(
    (w) => !(w.iso_year === style.iso_year && w.iso_week === style.iso_week)
  );

  if (otherWeeks.length === 0) return null;

  const handleChange = (e) => {
    const chosen = e.target.value;
    if (!chosen) return;
    setValue("");
    const [yr, wk] = chosen.split("-").map(Number);
    onUpdate(style, {}, { iso_year: yr, iso_week: wk });
  };

  return (
    <select
      value={value}
      onChange={handleChange}
      disabled={busy}
      title="Move this style to a different week"
      className="text-[11px] font-medium text-muted bg-white border border-line rounded-md px-1.5 py-1 w-full focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
      data-testid={`move-to-week-${style.id}`}
    >
      <option value="">Move to week…</option>
      {otherWeeks.map((w) => {
        const wk = weekKey(w);
        const suffix = w.overdue ? " — Overdue" : w.is_current ? " — This week" : "";
        return (
          <option key={wk} value={wk}>
            {w.label}{suffix}
          </option>
        );
      })}
    </select>
  );
}

/** One draggable style card */
function StyleCard({
  style, finishingOptions, orderTypes, busy, late, onUpdate, onDelete,
  onDragStart, onDragEnd, isPrivileged, onNoteAdded, onOpenFulfillment,
  onOptionsChange, weeks,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = !!style.completed;
  const canDone = style.status === "Warehouse";
  const statuses = finishingOptions.map((f) => f.label);

  const handleComplete = () => {
    if (!canDone && !done) return;
    onUpdate(style, { completed: !done });
  };

  return (
    <div
      draggable={!busy}
      onDragStart={(e) => onDragStart(e, style)}
      onDragEnd={onDragEnd}
      className={`rounded-lg border border-line border-l-4 bg-white p-2.5 transition hover:shadow-sm ${
        done ? "border-l-emerald-500 bg-emerald-50/40" : late ? "border-l-rose-500 bg-rose-50/40" : "border-l-[#1a5c38]/40"
      } ${busy ? "opacity-60" : "cursor-grab active:cursor-grabbing"}`}
      data-testid={`style-card-${style.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpenFulfillment(style)}
          className="font-semibold text-[12.5px] text-[#0f3d24] leading-snug text-left hover:underline underline-offset-2 min-w-0"
          title="Click to view fulfillment drill-down"
        >
          {style.style_name}
        </button>
        <button
          type="button"
          onClick={handleComplete}
          disabled={busy || (!done && !canDone)}
          title={
            !canDone && !done
              ? "Style must be in Warehouse status before marking as done"
              : done ? "Mark as not completed" : "Mark as completed"
          }
          className="shrink-0 mt-[1px] disabled:opacity-40"
          data-testid={`style-card-complete-${style.id}`}
        >
          {done ? (
            <CheckCircle size={18} weight="fill" className="text-emerald-600" />
          ) : (
            <Circle size={18} className={canDone ? "text-muted/60 hover:text-emerald-600" : "text-muted/25"} />
          )}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 mt-1.5">
        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${BRAND_BADGE[style.brand] || "bg-panel text-muted border-line"}`}>
          {style.brand}
        </span>
        {style.order_type && (
          <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${ORDER_TYPE_BADGE[style.order_type] || "bg-panel text-muted border-line"}`}>
            {style.order_type}
          </span>
        )}
        <span className="text-[10.5px] font-semibold text-[#0f3d24] bg-panel border border-line rounded-full px-1.5 py-0.5">
          {fmtUnits(style.quantity)} pcs
        </span>
        {late && (
          <span className="flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-800 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5">
            <Warning size={9} weight="fill" /> Late
          </span>
        )}
      </div>

      {/* Order Type inline select */}
      <div className="mt-1.5">
        <OrderTypeSelect style={style} orderTypes={orderTypes} busy={busy} onUpdate={onUpdate} />
      </div>

      {/* Status select with finishing-options management */}
      <div className="mt-1.5">
        {isPrivileged ? (
          <FinishingOptionsSelect
            style={style}
            finishingOptions={finishingOptions}
            busy={busy}
            onUpdate={onUpdate}
            isPrivileged={isPrivileged}
            onOptionsChange={onOptionsChange}
          />
        ) : (
          <StatusSelect style={style} statuses={statuses} busy={busy} onUpdate={onUpdate} className="w-full" />
        )}
      </div>

      {/* Delete (privileged only) */}
      {isPrivileged && (
        <div className="flex items-center justify-end mt-1.5">
          {confirmDelete ? (
            <span className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => { setConfirmDelete(false); onDelete(style); }}
                disabled={busy}
                className="text-[10px] font-bold text-white bg-rose-600 hover:bg-rose-700 rounded px-1.5 py-1 disabled:opacity-50"
              >Delete</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-muted hover:text-[#0f3d24]"><X size={13} /></button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              title="Delete style"
              className="text-muted/50 hover:text-rose-600 disabled:opacity-50"
            >
              <Trash size={13} />
            </button>
          )}
        </div>
      )}

      <div className={`flex items-center gap-1 mt-1.5 text-[10.5px] ${late ? "text-rose-700" : "text-muted"}`}>
        <CalendarBlank size={12} className="shrink-0" />
        {style.deliver_by ? (
          <span>
            Deliver by{" "}
            <span className={`font-semibold ${late ? "text-rose-700" : "text-[#0f3d24]"}`}>{fmtShortDate(style.deliver_by)}</span>
            {late && <span className="font-bold"> — past due</span>}
          </span>
        ) : (
          <span>No deliver-by date</span>
        )}
      </div>

      {/* Move to week */}
      {weeks && weeks.length > 1 && (
        <div className="mt-1.5">
          <MoveToWeekMenu style={style} weeks={weeks} busy={busy} onUpdate={onUpdate} />
        </div>
      )}

      {/* Notes panel */}
      <NotesPanel style={style} onNoteAdded={onNoteAdded} />
    </div>
  );
}

/** Inline "+ Add style" form */
function AddStyleForm({ week, finishingOptions, brands, categories, orderTypes, onCreate, onCancel }) {
  const statuses = finishingOptions.map((f) => f.label);
  const [form, setForm] = useState({
    style_name: "",
    brand: brands[0] || "VIVO",
    category: categories[0] || "WOVEN",
    quantity: "",
    order_type: orderTypes[0] || "New",
    order_date: "",
    status: statuses[0] || "Cutting",
    deliver_by: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const set = (k) => (e) => {
    const val = e.target.value;
    setForm((f) => {
      const next = { ...f, [k]: val };
      // Auto-fill deliver_by when order_date is set and deliver_by is not manually overridden
      if (k === "order_date" && val && !f._deliver_by_manual) {
        const od = new Date(`${val}T00:00:00`);
        if (!isNaN(od.getTime())) {
          od.setDate(od.getDate() + 14);
          const dd = od.toISOString().slice(0, 10);
          next.deliver_by = dd;
        }
      }
      if (k === "deliver_by") next._deliver_by_manual = true;
      return next;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!form.style_name.trim()) { setErr("Style name is required."); return; }
    setSaving(true);
    try {
      await onCreate(week, {
        style_name: form.style_name.trim(),
        brand: form.brand,
        category: form.category,
        quantity: Number(form.quantity) || 0,
        order_type: form.order_type || null,
        order_date: form.order_date || null,
        status: form.status,
        deliver_by: form.deliver_by || null,
        iso_year: week.iso_year,
        iso_week: week.iso_week,
      });
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2.message || "Failed to add style");
      setSaving(false);
    }
  };

  const inputCls = "w-full text-[11.5px] text-[#0f3d24] bg-white border border-line rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand/40";
  const labelCls = "text-[10px] font-bold uppercase tracking-wide text-muted";

  return (
    <form onSubmit={submit} className="rounded-lg border border-brand/30 bg-brand/5 p-2.5 space-y-2" data-testid={`add-style-form-${weekKey(week)}`}>
      <div className="text-[11px] font-bold text-[#0f3d24]">New style — WK {week.iso_week}</div>
      <div>
        <label className={labelCls}>Style name</label>
        <input className={inputCls} value={form.style_name} onChange={set("style_name")} placeholder="e.g. Vivo Wrap Dress in Satin" autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Brand</label>
          <select className={inputCls} value={form.brand} onChange={set("brand")}>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Category</label>
          <select className={inputCls} value={form.category} onChange={set("category")}>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Quantity</label>
          <input className={inputCls} type="number" min="0" value={form.quantity} onChange={set("quantity")} placeholder="0" />
        </div>
        <div>
          <label className={labelCls}>Order Type</label>
          <select className={inputCls} value={form.order_type} onChange={set("order_type")}>
            {orderTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={labelCls}>Status</label>
        <select className={inputCls} value={form.status} onChange={set("status")}>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Order date</label>
          <input className={inputCls} type="date" value={form.order_date} onChange={set("order_date")} />
        </div>
        <div>
          <label className={labelCls}>Deliver by</label>
          <input className={inputCls} type="date" value={form.deliver_by} onChange={set("deliver_by")} />
        </div>
      </div>
      {err && <div className="text-[11px] text-rose-700">{err}</div>}
      <div className="flex items-center gap-1.5">
        <button type="submit" disabled={saving} className="text-[11px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-2.5 py-1.5 rounded-md disabled:opacity-50">
          {saving ? "Adding…" : "Add style"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className="text-[11px] font-semibold text-[#0f3d24] border border-line hover:bg-white px-2.5 py-1.5 rounded-md disabled:opacity-50">
          Cancel
        </button>
      </div>
    </form>
  );
}

const StyleTracker = () => {
  const { user } = useAuth();
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState("board");
  const [archived, setArchived] = useState(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [addingWeek, setAddingWeek] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [archivingWeek, setArchivingWeek] = useState(null);
  const [dragOverWeek, setDragOverWeek] = useState(null);
  const [fulfillmentStyle, setFulfillmentStyle] = useState(null); // {id, style_name}
  const [selectedWeekKey, setSelectedWeekKey] = useState(null);
  const dragStyleRef = useRef(null);

  // Check if current user is privileged (admin or specific emails)
  const PRIVILEGED_EMAILS = ["marynyambura@vivofashiongroup.com", "maryann@vivofashiongroup.com"];
  const isPrivileged = useMemo(() => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return PRIVILEGED_EMAILS.includes((user.email || "").toLowerCase());
  }, [user]);

  const loadBoard = useCallback((forceFresh = false, silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    return api
      .get("/style-tracker/board", { forceFresh })
      .then(({ data }) => setBoard(data))
      .catch((e) => setError(e?.response?.data?.detail || e.message || "Failed to load board"))
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  const loadArchived = (forceFresh = true) => {
    setArchivedLoading(true);
    return api
      .get("/style-tracker/archived", { forceFresh })
      .then(({ data }) => setArchived(data))
      .catch((e) => toast.error(e?.response?.data?.detail || e.message || "Failed to load archived styles"))
      .finally(() => setArchivedLoading(false));
  };

  useEffect(() => { loadBoard(); }, [loadBoard]);
  useEffect(() => { if (view === "archived") loadArchived(); }, [view]);

  // Set the default selected week to the current week when the board first loads
  useEffect(() => {
    if (!board) return;
    setSelectedWeekKey((prev) => {
      // Keep the user's selection if it still exists in the board
      if (prev && board.weeks.some((w) => weekKey(w) === prev)) return prev;
      const cur = board.weeks.find((w) => w.is_current);
      return cur ? weekKey(cur) : (board.weeks[0] ? weekKey(board.weeks[0]) : null);
    });
  }, [board]);

  const finishingOptions = board?.finishing_options || [];
  const statuses = board?.statuses || [];
  const brands = board?.brands || ["VIVO", "SBV", "STUDIO"];
  const categories = board?.categories || ["WOVEN", "KNIT"];
  const orderTypes = board?.order_types || ["New", "Re-Order", "Replenishment"];

  const markBusy = (id, on) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  const patchLocal = (styleId, patch, moveTo = null) => {
    setBoard((b) => {
      if (!b) return b;
      const weeks = b.weeks.map((w) => ({ ...w, styles: [...w.styles] }));
      let moved = null;
      for (const w of weeks) {
        const i = w.styles.findIndex((s) => s.id === styleId);
        if (i >= 0) {
          const updated = { ...w.styles[i], ...patch };
          if (moveTo && (moveTo.iso_year !== w.iso_year || moveTo.iso_week !== w.iso_week)) {
            w.styles.splice(i, 1);
            moved = { ...updated, iso_year: moveTo.iso_year, iso_week: moveTo.iso_week };
          } else {
            w.styles[i] = updated;
          }
          break;
        }
      }
      if (moved) {
        const dest = weeks.find((w) => w.iso_year === moved.iso_year && w.iso_week === moved.iso_week);
        if (dest) dest.styles.push(moved);
      }
      for (const w of weeks) {
        w.count = w.styles.length;
        w.total_units = w.styles.reduce((a, s) => a + (Number(s.quantity) || 0), 0);
        w.completed_count = w.styles.filter((s) => s.completed).length;
        w.completed_units = w.styles.reduce((a, s) => a + (s.completed ? Number(s.quantity) || 0 : 0), 0);
      }
      return { ...b, weeks };
    });
  };

  const updateStyle = async (style, patch, moveTo = null) => {
    markBusy(style.id, true);
    patchLocal(style.id, patch, moveTo);
    try {
      await api.post(`/style-tracker/styles/${style.id}`, { ...patch, ...(moveTo || {}) });
      await loadBoard(true, true);
      // Re-apply the saved patch after the board reload so that any stale
      // server response (or a concurrent in-flight request that resolves late)
      // cannot overwrite the value the user just saved — covers order_type,
      // status, and every other field updated via this path.
      patchLocal(style.id, patch, moveTo);
    } catch (e) {
      const msg = e?.response?.data?.detail || e.message || "Failed to save change";
      toast.error(msg);
      await loadBoard(true, true);
    } finally {
      markBusy(style.id, false);
    }
  };

  const deleteStyle = async (style) => {
    markBusy(style.id, true);
    try {
      await api.post(`/style-tracker/styles/${style.id}/delete`);
      toast.success("Style deleted");
      await loadBoard(true, true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message || "Failed to delete style");
    } finally {
      markBusy(style.id, false);
    }
  };

  const createStyle = async (week, payload) => {
    await api.post("/style-tracker/styles", payload);
    toast.success(`Style added to WK ${week.iso_week}`);
    setAddingWeek(null);
    await loadBoard(true, true);
  };

  // Add a note optimistically to local state
  const handleNoteAdded = useCallback((styleId, note) => {
    setBoard((b) => {
      if (!b) return b;
      return {
        ...b,
        weeks: b.weeks.map((w) => ({
          ...w,
          styles: w.styles.map((s) =>
            s.id === styleId
              ? { ...s, notes: [...(s.notes || []), note] }
              : s
          ),
        })),
      };
    });
  }, []);

  const archiveWeek = async (week) => {
    const wk = weekKey(week);
    setArchivingWeek(wk);
    try {
      const { data } = await api.post("/style-tracker/archive-week", {
        iso_year: week.iso_year,
        iso_week: week.iso_week,
      });
      const n = data?.archived_count || 0;
      toast.success(
        n > 0
          ? `Archived ${n} completed style${n === 1 ? "" : "s"} from WK ${week.iso_week}`
          : `No completed styles to archive in WK ${week.iso_week}`
      );
      await loadBoard(true, true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message || "Failed to archive week");
    } finally {
      setArchivingWeek(null);
    }
  };

  const restoreStyle = async (style) => {
    markBusy(style.id, true);
    try {
      await api.post(`/style-tracker/styles/${style.id}/restore`);
      toast.success("Style restored to the board");
      await Promise.all([loadArchived(), loadBoard(true, true)]);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message || "Failed to restore style");
    } finally {
      markBusy(style.id, false);
    }
  };

  const onCardDragStart = (e, style) => {
    dragStyleRef.current = style;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(style.id)); } catch { /* IE */ }
  };
  const onCardDragEnd = () => { dragStyleRef.current = null; setDragOverWeek(null); };
  const onColDragOver = (e, week) => {
    if (!dragStyleRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverWeek(weekKey(week));
  };
  const onColDrop = (e, week) => {
    e.preventDefault();
    const style = dragStyleRef.current;
    dragStyleRef.current = null;
    setDragOverWeek(null);
    if (!style) return;
    if (style.iso_year === week.iso_year && style.iso_week === week.iso_week) return;
    updateStyle(style, {}, { iso_year: week.iso_year, iso_week: week.iso_week });
  };

  const overdueCount = useMemo(
    () => (board?.weeks || []).filter((w) => w.overdue).length,
    [board]
  );

  const lateCount = useMemo(
    () => (board?.weeks || []).reduce(
      (n, w) => n + w.styles.filter((s) => isLateStyle(s, board?.today)).length,
      0
    ),
    [board]
  );

  if (loading) return <Loading label="Loading style tracker…" />;
  if (error) return <ErrorBox message={error} />;
  if (!board) return null;

  return (
    <div className="space-y-4" data-testid="style-tracker-page">
      {fulfillmentStyle && (
        <FulfillmentDrawer
          styleId={fulfillmentStyle.id}
          styleName={fulfillmentStyle.style_name}
          onClose={() => setFulfillmentStyle(null)}
        />
      )}

      <SectionTitle
        title="Weekly Style Tracker"
        subtitle={`Styles by launch week — use "Move to week" on a card to re-plan. Today: ${fmtShortDate(board.today)} (WK ${board.current?.iso_week})`}
        action={
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-line overflow-hidden">
              <button type="button" onClick={() => setView("board")} className={`text-[11.5px] font-semibold px-3 py-1.5 ${view === "board" ? "bg-[#1a5c38] text-white" : "bg-white text-[#0f3d24] hover:bg-panel"}`} data-testid="style-tracker-view-board">Board</button>
              <button type="button" onClick={() => setView("table")} className={`text-[11.5px] font-semibold px-3 py-1.5 border-l border-line ${view === "table" ? "bg-[#1a5c38] text-white" : "bg-white text-[#0f3d24] hover:bg-panel"}`} data-testid="style-tracker-view-table">Table</button>
              <button type="button" onClick={() => setView("archived")} className={`text-[11.5px] font-semibold px-3 py-1.5 border-l border-line ${view === "archived" ? "bg-[#1a5c38] text-white" : "bg-white text-[#0f3d24] hover:bg-panel"}`} data-testid="style-tracker-view-archived">
                Archived{archived ? ` (${archived.count})` : ""}
              </button>
            </div>
            <button type="button" onClick={() => (view === "archived" ? loadArchived() : loadBoard(true))} className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#0f3d24] border border-line hover:bg-panel px-2.5 py-1.5 rounded-lg" data-testid="style-tracker-refresh">
              <ArrowsClockwise size={13} /> Refresh
            </button>
          </div>
        }
      />

      {view === "board" ? (
        <>
          {overdueCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              <Warning size={15} weight="fill" className="shrink-0 text-amber-600" />
              <span><span className="font-bold">{overdueCount} overdue week{overdueCount === 1 ? "" : "s"}</span> with incomplete styles — complete or re-plan them, then archive the week.</span>
            </div>
          )}
          {lateCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-900">
              <Warning size={15} weight="fill" className="shrink-0 text-rose-600" />
              <span><span className="font-bold">{lateCount} late style{lateCount === 1 ? "" : "s"}</span> past the deliver-by date and not completed — look for the red <span className="font-bold">Late</span> cards.</span>
            </div>
          )}

          {/* Board-level summary panel */}
          <WeekSummaryPanel
            weeks={board.weeks}
            selectedKey={selectedWeekKey}
            onSelect={setSelectedWeekKey}
          />

          {/* Week picker */}
          <div className="flex items-center gap-3">
            <WeekPicker
              weeks={board.weeks}
              selectedKey={selectedWeekKey}
              onSelect={setSelectedWeekKey}
            />
            {selectedWeekKey && (() => {
              const sw = board.weeks.find((w) => weekKey(w) === selectedWeekKey);
              if (!sw) return null;
              return (
                <span className="text-[11.5px] text-muted">
                  {sw.count} style{sw.count === 1 ? "" : "s"} · {fmtUnits(sw.total_units)} pcs
                </span>
              );
            })()}
          </div>

          {/* Single-week board column */}
          {(() => {
            const week = board.weeks.find((w) => weekKey(w) === selectedWeekKey);
            if (!week) return null;
            const wk = weekKey(week);
            const isDragTarget = dragOverWeek === wk;
            return (
              <div
                onDragOver={(e) => onColDragOver(e, week)}
                onDragLeave={() => setDragOverWeek((c) => (c === wk ? null : c))}
                onDrop={(e) => onColDrop(e, week)}
                className={`rounded-xl border flex flex-col transition ${
                  week.overdue ? "bg-amber-50/70 border-amber-300"
                    : week.is_current ? "bg-brand/5 border-brand/40"
                    : "bg-panel/50 border-line"
                } ${isDragTarget ? "ring-2 ring-brand/60" : ""}`}
                data-testid={`style-tracker-col-${wk}`}
              >
                <div className={`px-3 py-2.5 border-b ${week.overdue ? "border-amber-200" : "border-line"}`}>
                  <div className="flex items-center gap-1.5">
                    <div className="font-bold text-[13px] text-[#0f3d24]">{week.label}</div>
                    {week.overdue && <span className="text-[9px] font-bold uppercase tracking-wide text-amber-800 bg-amber-200/80 border border-amber-300 rounded-full px-1.5 py-0.5">Overdue</span>}
                    {week.is_current && <span className="text-[9px] font-bold uppercase tracking-wide text-white bg-[#1a5c38] rounded-full px-1.5 py-0.5">This week</span>}
                  </div>
                  <WeekStats week={week} />
                  {week.is_past && (
                    <button
                      type="button"
                      onClick={() => archiveWeek(week)}
                      disabled={archivingWeek === wk || !week.styles.some((s) => s.completed)}
                      className="mt-1.5 flex items-center gap-1 text-[10.5px] font-semibold text-amber-900 bg-white border border-amber-300 hover:bg-amber-100 rounded-md px-2 py-1 disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <Archive size={12} />
                      {archivingWeek === wk ? "Archiving…" : "Archive week"}
                    </button>
                  )}
                </div>

                <div className="p-3 space-y-2 flex-1 min-h-[80px]">
                  {week.styles.length === 0 && addingWeek !== wk && (
                    <div className="text-[11px] text-muted/70 italic text-center py-6">
                      No styles this week — add one below
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {week.styles.map((s) => (
                      <StyleCard
                        key={s.id}
                        style={s}
                        finishingOptions={finishingOptions}
                        orderTypes={orderTypes}
                        busy={busyIds.has(s.id)}
                        late={isLateStyle(s, board.today)}
                        onUpdate={updateStyle}
                        onDelete={deleteStyle}
                        onDragStart={onCardDragStart}
                        onDragEnd={onCardDragEnd}
                        isPrivileged={isPrivileged}
                        onNoteAdded={handleNoteAdded}
                        onOpenFulfillment={(style) => setFulfillmentStyle({ id: style.id, style_name: style.style_name })}
                        onOptionsChange={() => loadBoard(true, true)}
                        weeks={board.weeks}
                      />
                    ))}
                  </div>
                  {addingWeek === wk ? (
                    <AddStyleForm
                      week={week}
                      finishingOptions={finishingOptions}
                      brands={brands}
                      categories={categories}
                      orderTypes={orderTypes}
                      onCreate={createStyle}
                      onCancel={() => setAddingWeek(null)}
                    />
                  ) : isPrivileged ? (
                    <button
                      type="button"
                      onClick={() => setAddingWeek(wk)}
                      className="w-full flex items-center justify-center gap-1 text-[11.5px] font-semibold text-[#1a5c38] border border-dashed border-[#1a5c38]/40 hover:bg-brand/5 rounded-lg px-2 py-1.5"
                      data-testid={`style-tracker-add-${wk}`}
                    >
                      <Plus size={13} weight="bold" /> Add style
                    </button>
                  ) : null}
                </div>

                <div className={`px-3 py-2 border-t text-[11px] font-semibold text-[#0f3d24] flex items-center justify-between ${week.overdue ? "border-amber-200" : "border-line"}`}>
                  <span>{week.completed_count || 0}/{week.count} in WH</span>
                  <span>{fmtUnits(week.completed_units || 0)}/{fmtUnits(week.total_units)} pcs</span>
                </div>
              </div>
            );
          })()}
        </>
      ) : view === "table" ? (
        <WeekTable
          weeks={board.weeks}
          today={board.today}
          finishingOptions={finishingOptions}
          busyIds={busyIds}
          onUpdate={updateStyle}
          isPrivileged={isPrivileged}
        />
      ) : (
        <div className="rounded-xl border border-line bg-white" data-testid="style-tracker-archived-view">
          {archivedLoading ? (
            <Loading label="Loading archived styles…" />
          ) : !archived || archived.styles.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted">
              <ClockClockwise size={26} />
              <div className="text-[12.5px]">No archived styles yet — archive a past week from the board.</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted border-b border-line">
                    <th className="px-3 py-2.5 font-bold">Style</th>
                    <th className="px-3 py-2.5 font-bold">Brand</th>
                    <th className="px-3 py-2.5 font-bold">Type</th>
                    <th className="px-3 py-2.5 font-bold text-right">Qty</th>
                    <th className="px-3 py-2.5 font-bold">Week</th>
                    <th className="px-3 py-2.5 font-bold">Status</th>
                    <th className="px-3 py-2.5 font-bold">Archived</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {archived.styles.map((s) => (
                    <tr key={s.id} className="border-b border-line/60 last:border-0 hover:bg-panel/40">
                      <td className="px-3 py-2 font-semibold text-[#0f3d24]">{s.style_name}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${BRAND_BADGE[s.brand] || "bg-panel text-muted border-line"}`}>{s.brand}</span>
                      </td>
                      <td className="px-3 py-2">
                        {s.order_type && <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${ORDER_TYPE_BADGE[s.order_type] || "bg-panel text-muted border-line"}`}>{s.order_type}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">{fmtUnits(s.quantity)}</td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">{s.week_label}</td>
                      <td className="px-3 py-2 text-muted">{s.status}</td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">
                        {s.archived_at ? new Date(s.archived_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => restoreStyle(s)}
                          disabled={busyIds.has(s.id)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1a5c38] border border-[#1a5c38]/30 hover:bg-brand/5 rounded-md px-2 py-1 disabled:opacity-50"
                        >
                          <ArrowCounterClockwise size={12} /> Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StyleTracker;
