import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import {
  ArrowsClockwise,
  Archive,
  ArrowCounterClockwise,
  CalendarBlank,
  CheckCircle,
  Circle,
  ClockClockwise,
  Plus,
  Table,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";

/**
 * Weekly Style Tracker — a manually-maintained kanban of production styles by
 * launch ISO week. Always shows the current week + the next 4; older weeks
 * that still hold not-completed styles surface on the left as amber "Overdue"
 * columns. Cards drag between week columns (HTML5 DnD) with optimistic
 * persistence; status is edited inline; past weeks archive their COMPLETED
 * styles; an Archived view lists + restores archived styles.
 * Reads GET /api/style-tracker/board + /archived; writes via
 * POST /api/style-tracker/*. No Odoo/Production-Tracker linkage by design.
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

const weekKey = (w) => `${w.iso_year}-${w.iso_week}`;

/** % of a week's UNITS already completed (= delivered to the warehouse). */
const weekPct = (w) =>
  w.total_units > 0 ? Math.round((100 * (w.completed_units || 0)) / w.total_units) : null;

const pctTone = (pct) =>
  pct === null ? "text-muted" : pct >= 100 ? "text-emerald-700" : pct >= 50 ? "text-amber-700" : "text-rose-700";

const barTone = (pct) =>
  pct >= 100 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-400";

/** Compact per-week stats strip: qty, styles, % in warehouse + progress bar. */
function WeekStats({ week, compact = false }) {
  const pct = weekPct(week);
  return (
    <div className={compact ? "" : "mt-1.5"} data-testid={`week-stats-${weekKey(week)}`}>
      <div className="flex items-center justify-between gap-2 text-[10.5px] font-semibold text-[#0f3d24]">
        <span>{fmtUnits(week.total_units)} pcs · {week.count} style{week.count === 1 ? "" : "s"}</span>
        <span className={`font-bold ${pctTone(pct)}`}>
          {pct === null ? "—" : `${pct}%`} <span className="font-medium text-muted">in WH</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-line/70 overflow-hidden" title={`${fmtUnits(week.completed_units || 0)} of ${fmtUnits(week.total_units)} pcs completed (in warehouse) · ${week.completed_count || 0}/${week.count} styles`}>
        <div
          className={`h-full rounded-full transition-all ${pct === null ? "bg-line" : barTone(pct)}`}
          style={{ width: `${Math.min(pct || 0, 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Table view: one section per week with a stats header row, style rows
 *  (status + completed editable inline, same handlers as the board), and a
 *  grand-total footer across all visible weeks. */
function WeekTable({ weeks, today, statuses, busyIds, onUpdate }) {
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
            <th className={thCls}>Category</th>
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
                <tr className={`border-y border-line ${week.overdue ? "bg-amber-50" : week.is_current ? "bg-brand/5" : "bg-panel/60"}`} data-testid={`table-week-row-${wk}`}>
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
                  return (
                    <tr key={s.id} className={`border-b border-line/60 hover:bg-panel/40 ${late ? "bg-rose-50/50" : ""}`} data-testid={`table-style-row-${s.id}`}>
                      <td className="px-3 py-2 font-semibold text-[#0f3d24]">
                        {s.style_name}
                        {late && (
                          <span className="ml-2 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-800 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5">
                            <Warning size={9} weight="fill" /> Late
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${BRAND_BADGE[s.brand] || "bg-panel text-muted border-line"}`}>{s.brand}</span>
                      </td>
                      <td className="px-3 py-2 text-muted">{s.category}</td>
                      <td className="px-3 py-2 text-right font-semibold">{fmtUnits(s.quantity)}</td>
                      <td className="px-3 py-2">
                        <select
                          value={s.status}
                          onChange={(e) => onUpdate(s, { status: e.target.value })}
                          disabled={busy}
                          className="text-[11px] font-medium text-[#0f3d24] bg-white border border-line rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
                          data-testid={`table-style-status-${s.id}`}
                        >
                          {statuses.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      </td>
                      <td className={`px-3 py-2 whitespace-nowrap ${late ? "font-semibold text-rose-700" : "text-muted"}`}>
                        {s.deliver_by ? fmtShortDate(s.deliver_by) : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => onUpdate(s, { completed: !s.completed })}
                          disabled={busy}
                          title={s.completed ? "Mark as not completed" : "Mark as completed (in warehouse)"}
                          className="disabled:opacity-50"
                          data-testid={`table-style-complete-${s.id}`}
                        >
                          {s.completed ? (
                            <CheckCircle size={17} weight="fill" className="text-emerald-600" />
                          ) : (
                            <Circle size={17} className="text-muted/60 hover:text-emerald-600" />
                          )}
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
          <tr className="border-t-2 border-line bg-panel/70 font-bold text-[#0f3d24]" data-testid="table-grand-total">
            <td className="px-3 py-2.5" colSpan={3}>
              All weeks · {totals.count} style{totals.count === 1 ? "" : "s"} ({totals.cCount} in WH)
            </td>
            <td className="px-3 py-2.5 text-right">{fmtUnits(totals.units)}</td>
            <td className="px-3 py-2.5 text-[11px] text-muted font-semibold" colSpan={2}>
              {fmtUnits(totals.cUnits)} pcs in WH
            </td>
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

/** True when a style's deliver-by date has passed (vs the board's EAT today)
 *  and it isn't completed yet. Both are YYYY-MM-DD strings, so a plain
 *  lexicographic compare is a correct date compare. */
const isLateStyle = (style, today) =>
  !!(style?.deliver_by && today && !style.completed && style.deliver_by < today);

/** One draggable style card. */
function StyleCard({ style, statuses, busy, late, onUpdate, onDelete, onDragStart, onDragEnd }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = !!style.completed;
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
        <div className="font-semibold text-[12.5px] text-[#0f3d24] leading-snug min-w-0">
          {style.style_name}
        </div>
        <button
          type="button"
          onClick={() => onUpdate(style, { completed: !done })}
          disabled={busy}
          title={done ? "Mark as not completed" : "Mark as completed"}
          className="shrink-0 mt-[1px] disabled:opacity-50"
          data-testid={`style-card-complete-${style.id}`}
        >
          {done ? (
            <CheckCircle size={18} weight="fill" className="text-emerald-600" />
          ) : (
            <Circle size={18} className="text-muted/60 hover:text-emerald-600" />
          )}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 mt-1.5">
        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${BRAND_BADGE[style.brand] || "bg-panel text-muted border-line"}`}>
          {style.brand}
        </span>
        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${CATEGORY_BADGE[style.category] || "bg-panel text-muted border-line"}`}>
          {style.category}
        </span>
        <span className="text-[10.5px] font-semibold text-[#0f3d24] bg-panel border border-line rounded-full px-1.5 py-0.5">
          {fmtUnits(style.quantity)} pcs
        </span>
        {late && (
          <span
            className="flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-800 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5"
            title="Deliver-by date has passed and this style isn't completed"
            data-testid={`style-card-late-${style.id}`}
          >
            <Warning size={9} weight="fill" /> Late
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 mt-2">
        <select
          value={style.status}
          onChange={(e) => onUpdate(style, { status: e.target.value })}
          disabled={busy}
          className="flex-1 min-w-0 text-[11px] font-medium text-[#0f3d24] bg-white border border-line rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-50"
          data-testid={`style-card-status-${style.id}`}
        >
          {statuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {confirmDelete ? (
          <span className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => { setConfirmDelete(false); onDelete(style); }}
              disabled={busy}
              className="text-[10px] font-bold text-white bg-rose-600 hover:bg-rose-700 rounded px-1.5 py-1 disabled:opacity-50"
              data-testid={`style-card-delete-confirm-${style.id}`}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-muted hover:text-[#0f3d24]"
              aria-label="Cancel delete"
            >
              <X size={13} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            title="Delete style"
            className="shrink-0 text-muted/50 hover:text-rose-600 disabled:opacity-50"
            data-testid={`style-card-delete-${style.id}`}
          >
            <Trash size={14} />
          </button>
        )}
      </div>

      <div className={`flex items-center gap-1 mt-1.5 text-[10.5px] ${late ? "text-rose-700" : "text-muted"}`}>
        <CalendarBlank size={12} className="shrink-0" />
        {style.deliver_by ? (
          <span>
            Deliver to WH/FIN by{" "}
            <span className={`font-semibold ${late ? "text-rose-700" : "text-[#0f3d24]"}`}>{fmtShortDate(style.deliver_by)}</span>
            {late && <span className="font-bold"> — past due</span>}
          </span>
        ) : (
          <span>No deliver-by date</span>
        )}
      </div>
    </div>
  );
}

/** Inline "+ Add style" form for one week column. */
function AddStyleForm({ week, statuses, brands, categories, onCreate, onCancel }) {
  const [form, setForm] = useState({
    style_name: "",
    brand: brands[0] || "VIVO",
    category: categories[0] || "WOVEN",
    quantity: "",
    order_date: "",
    status: statuses[0] || "Cutting",
    deliver_by: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

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
        order_date: form.order_date || null,
        status: form.status,
        deliver_by: form.deliver_by || null,
        iso_year: week.iso_year,
        iso_week: week.iso_week,
      });
    } catch (e2) {
      setErr(e2?.response?.data?.detail || e2.message || "Failed to add style");
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  const inputCls = "w-full text-[11.5px] text-[#0f3d24] bg-white border border-line rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand/40";
  const labelCls = "text-[10px] font-bold uppercase tracking-wide text-muted";

  return (
    <form onSubmit={submit} className="rounded-lg border border-brand/30 bg-brand/5 p-2.5 space-y-2" data-testid={`add-style-form-${weekKey(week)}`}>
      <div className="text-[11px] font-bold text-[#0f3d24]">New style — WK {week.iso_week}</div>
      <div>
        <label className={labelCls}>Style name</label>
        <input className={inputCls} value={form.style_name} onChange={set("style_name")} placeholder="e.g. Vivo Wrap Dress in Satin" autoFocus data-testid="add-style-name" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Brand</label>
          <select className={inputCls} value={form.brand} onChange={set("brand")} data-testid="add-style-brand">
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Category</label>
          <select className={inputCls} value={form.category} onChange={set("category")} data-testid="add-style-category">
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Quantity</label>
          <input className={inputCls} type="number" min="0" value={form.quantity} onChange={set("quantity")} placeholder="0" data-testid="add-style-qty" />
        </div>
        <div>
          <label className={labelCls}>Status</label>
          <select className={inputCls} value={form.status} onChange={set("status")} data-testid="add-style-status">
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Order date</label>
          <input className={inputCls} type="date" value={form.order_date} onChange={set("order_date")} data-testid="add-style-order-date" />
        </div>
        <div>
          <label className={labelCls}>Deliver by</label>
          <input className={inputCls} type="date" value={form.deliver_by} onChange={set("deliver_by")} data-testid="add-style-deliver-by" />
        </div>
      </div>
      {err && <div className="text-[11px] text-rose-700">{err}</div>}
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={saving}
          className="text-[11px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-2.5 py-1.5 rounded-md disabled:opacity-50"
          data-testid="add-style-submit"
        >
          {saving ? "Adding…" : "Add style"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="text-[11px] font-semibold text-[#0f3d24] border border-line hover:bg-white px-2.5 py-1.5 rounded-md disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const StyleTracker = () => {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState("board"); // board | archived
  const [archived, setArchived] = useState(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [addingWeek, setAddingWeek] = useState(null); // weekKey being added to
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [archivingWeek, setArchivingWeek] = useState(null);
  const [dragOverWeek, setDragOverWeek] = useState(null);
  const dragStyleRef = useRef(null);

  const loadBoard = (forceFresh = false, silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    return api
      .get("/style-tracker/board", { forceFresh })
      .then(({ data }) => setBoard(data))
      .catch((e) => setError(e?.response?.data?.detail || e.message || "Failed to load board"))
      .finally(() => { if (!silent) setLoading(false); });
  };

  const loadArchived = (forceFresh = true) => {
    setArchivedLoading(true);
    return api
      .get("/style-tracker/archived", { forceFresh })
      .then(({ data }) => setArchived(data))
      .catch((e) => toast.error(e?.response?.data?.detail || e.message || "Failed to load archived styles"))
      .finally(() => setArchivedLoading(false));
  };

  useEffect(() => { loadBoard(); }, []);
  useEffect(() => { if (view === "archived") loadArchived(); }, [view]);

  const statuses = board?.statuses || [];
  const brands = board?.brands || ["VIVO", "SBV", "STUDIO"];
  const categories = board?.categories || ["WOVEN", "KNIT"];

  const markBusy = (id, on) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  /** Optimistically patch one style in the board state. */
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
        w.completed_units = w.styles.reduce(
          (a, s) => a + (s.completed ? Number(s.quantity) || 0 : 0), 0);
      }
      return { ...b, weeks };
    });
  };

  const updateStyle = async (style, patch, moveTo = null) => {
    markBusy(style.id, true);
    patchLocal(style.id, patch, moveTo);
    try {
      await api.post(`/style-tracker/styles/${style.id}`, { ...patch, ...(moveTo || {}) });
      // Silent refresh keeps overdue-column visibility + footers server-true.
      await loadBoard(true, true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message || "Failed to save change");
      await loadBoard(true, true); // roll back optimistic state
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

  // ── Drag & drop between week columns ────────────────────────────────────
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
    () =>
      (board?.weeks || []).reduce(
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
      <SectionTitle
        title="Weekly Style Tracker"
        subtitle={`Styles by launch week — drag cards between weeks to re-plan. Today: ${fmtShortDate(board.today)} (WK ${board.current?.iso_week})`}
        action={
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-line overflow-hidden">
              <button
                type="button"
                onClick={() => setView("board")}
                className={`text-[11.5px] font-semibold px-3 py-1.5 ${view === "board" ? "bg-[#1a5c38] text-white" : "bg-white text-[#0f3d24] hover:bg-panel"}`}
                data-testid="style-tracker-view-board"
              >
                Board
              </button>
              <button
                type="button"
                onClick={() => setView("table")}
                className={`text-[11.5px] font-semibold px-3 py-1.5 border-l border-line ${view === "table" ? "bg-[#1a5c38] text-white" : "bg-white text-[#0f3d24] hover:bg-panel"}`}
                data-testid="style-tracker-view-table"
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setView("archived")}
                className={`text-[11.5px] font-semibold px-3 py-1.5 border-l border-line ${view === "archived" ? "bg-[#1a5c38] text-white" : "bg-white text-[#0f3d24] hover:bg-panel"}`}
                data-testid="style-tracker-view-archived"
              >
                Archived{archived ? ` (${archived.count})` : ""}
              </button>
            </div>
            <button
              type="button"
              onClick={() => (view === "archived" ? loadArchived() : loadBoard(true))}
              className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#0f3d24] border border-line hover:bg-panel px-2.5 py-1.5 rounded-lg"
              data-testid="style-tracker-refresh"
            >
              <ArrowsClockwise size={13} /> Refresh
            </button>
          </div>
        }
      />

      {view === "board" ? (
        <>
          {overdueCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900" data-testid="style-tracker-overdue-banner">
              <Warning size={15} weight="fill" className="shrink-0 text-amber-600" />
              <span>
                <span className="font-bold">{overdueCount} overdue week{overdueCount === 1 ? "" : "s"}</span> with incomplete styles — complete or re-plan them, then archive the week.
              </span>
            </div>
          )}

          {lateCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-900" data-testid="style-tracker-late-banner">
              <Warning size={15} weight="fill" className="shrink-0 text-rose-600" />
              <span>
                <span className="font-bold">{lateCount} late style{lateCount === 1 ? "" : "s"}</span> past the deliver-by date and not completed — look for the red <span className="font-bold">Late</span> cards.
              </span>
            </div>
          )}

          <div className="overflow-x-auto pb-2">
            <div className="flex gap-3 min-w-max items-start">
              {board.weeks.map((week) => {
                const wk = weekKey(week);
                const isDragTarget = dragOverWeek === wk;
                return (
                  <div
                    key={wk}
                    onDragOver={(e) => onColDragOver(e, week)}
                    onDragLeave={() => setDragOverWeek((c) => (c === wk ? null : c))}
                    onDrop={(e) => onColDrop(e, week)}
                    className={`w-[262px] shrink-0 rounded-xl border flex flex-col transition ${
                      week.overdue
                        ? "bg-amber-50/70 border-amber-300"
                        : week.is_current
                          ? "bg-brand/5 border-brand/40"
                          : "bg-panel/50 border-line"
                    } ${isDragTarget ? "ring-2 ring-brand/60" : ""}`}
                    data-testid={`style-tracker-col-${wk}`}
                  >
                    <div className={`px-3 py-2.5 border-b ${week.overdue ? "border-amber-200" : "border-line"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="font-bold text-[13px] text-[#0f3d24] truncate">{week.label}</div>
                          {week.overdue && (
                            <span className="text-[9px] font-bold uppercase tracking-wide text-amber-800 bg-amber-200/80 border border-amber-300 rounded-full px-1.5 py-0.5 shrink-0">
                              Overdue
                            </span>
                          )}
                          {week.is_current && (
                            <span className="text-[9px] font-bold uppercase tracking-wide text-white bg-[#1a5c38] rounded-full px-1.5 py-0.5 shrink-0">
                              This week
                            </span>
                          )}
                        </div>
                      </div>
                      <WeekStats week={week} />
                      {week.is_past && (
                        <button
                          type="button"
                          onClick={() => archiveWeek(week)}
                          disabled={archivingWeek === wk || !week.styles.some((s) => s.completed)}
                          title={
                            week.styles.some((s) => s.completed)
                              ? "Archive all COMPLETED styles in this week — incomplete styles stay visible as overdue"
                              : "No completed styles to archive in this week"
                          }
                          className="mt-1.5 flex items-center gap-1 text-[10.5px] font-semibold text-amber-900 bg-white border border-amber-300 hover:bg-amber-100 rounded-md px-2 py-1 disabled:opacity-45 disabled:cursor-not-allowed"
                          data-testid={`style-tracker-archive-week-${wk}`}
                        >
                          <Archive size={12} />
                          {archivingWeek === wk ? "Archiving…" : "Archive week"}
                        </button>
                      )}
                    </div>

                    <div className="p-2 space-y-2 flex-1 min-h-[80px]">
                      {week.styles.length === 0 && addingWeek !== wk && (
                        <div className="text-[11px] text-muted/70 italic text-center py-4">
                          No styles — drop a card here or add one
                        </div>
                      )}
                      {week.styles.map((s) => (
                        <StyleCard
                          key={s.id}
                          style={s}
                          statuses={statuses}
                          busy={busyIds.has(s.id)}
                          late={isLateStyle(s, board.today)}
                          onUpdate={updateStyle}
                          onDelete={deleteStyle}
                          onDragStart={onCardDragStart}
                          onDragEnd={onCardDragEnd}
                        />
                      ))}
                      {addingWeek === wk ? (
                        <AddStyleForm
                          week={week}
                          statuses={statuses}
                          brands={brands}
                          categories={categories}
                          onCreate={createStyle}
                          onCancel={() => setAddingWeek(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAddingWeek(wk)}
                          className="w-full flex items-center justify-center gap-1 text-[11.5px] font-semibold text-[#1a5c38] border border-dashed border-[#1a5c38]/40 hover:bg-brand/5 rounded-lg px-2 py-1.5"
                          data-testid={`style-tracker-add-${wk}`}
                        >
                          <Plus size={13} weight="bold" /> Add style
                        </button>
                      )}
                    </div>

                    <div className={`px-3 py-2 border-t text-[11px] font-semibold text-[#0f3d24] flex items-center justify-between ${week.overdue ? "border-amber-200" : "border-line"}`} data-testid={`style-tracker-footer-${wk}`}>
                      <span>{week.completed_count || 0}/{week.count} in WH</span>
                      <span>{fmtUnits(week.completed_units || 0)}/{fmtUnits(week.total_units)} pcs</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : view === "table" ? (
        <WeekTable
          weeks={board.weeks}
          today={board.today}
          statuses={statuses}
          busyIds={busyIds}
          onUpdate={updateStyle}
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
                    <th className="px-3 py-2.5 font-bold">Category</th>
                    <th className="px-3 py-2.5 font-bold text-right">Qty</th>
                    <th className="px-3 py-2.5 font-bold">Week</th>
                    <th className="px-3 py-2.5 font-bold">Status</th>
                    <th className="px-3 py-2.5 font-bold">Archived</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {archived.styles.map((s) => (
                    <tr key={s.id} className="border-b border-line/60 last:border-0 hover:bg-panel/40" data-testid={`archived-row-${s.id}`}>
                      <td className="px-3 py-2 font-semibold text-[#0f3d24]">{s.style_name}</td>
                      <td className="px-3 py-2">
                        <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-0.5 ${BRAND_BADGE[s.brand] || "bg-panel text-muted border-line"}`}>{s.brand}</span>
                      </td>
                      <td className="px-3 py-2 text-muted">{s.category}</td>
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
                          data-testid={`archived-restore-${s.id}`}
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
