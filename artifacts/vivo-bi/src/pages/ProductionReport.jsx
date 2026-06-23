import React, { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import ProductionOrderModal from "@/components/ProductionOrderModal";
import {
  ArrowsClockwise,
  MagnifyingGlass,
  X,
  DownloadSimple,
  ArrowRight,
  CalendarBlank,
  Funnel,
} from "@phosphor-icons/react";

/**
 * Production Report — a flow cockpit over the Production Tracker. It answers:
 *   1. The line as a FLOW: a horizontal stage-flow diagram (units / #styles / %
 *      per stage with arrows). Click a stage to filter the order table to it.
 *   2. When is product landing: a weekly "expected drops" strip by Odoo
 *      expected_delivery_date (Overdue / this week / next weeks / Later). Click a
 *      week to filter the table to that drop window.
 *   3. Per order: colours, sizes and "what is where". Click a row to open the
 *      style's journey + SKU-level move modal.
 *   4. Cross-order roll-ups (order type, BO state, current stage) with % graphics.
 * Reads /api/production/summary + /flow + /expected-drops.
 */
function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v)
    ? v.toLocaleString()
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(d);
  }
}

function fmtDayShort(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return String(d);
  }
}

function titleize(s) {
  if (!s) return "—";
  return String(s)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const LIFECYCLE_STYLE = {
  New: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Replenishment: "bg-sky-50 text-sky-700 border-sky-200",
  "Re-order": "bg-violet-50 text-violet-700 border-violet-200",
};

function lifecycleBadge(label) {
  return LIFECYCLE_STYLE[label] || "bg-gray-50 text-gray-600 border-gray-200";
}

/** A labelled roll-up card: a small list of {label, orders, units} with % bars. */
function BreakdownCard({ title, rows, accent }) {
  const total = useMemo(
    () => (rows || []).reduce((s, r) => s + (Number(r.units) || 0), 0),
    [rows]
  );
  return (
    <div className="card-white p-4" data-testid={`breakdown-${title}`}>
      <div className="eyebrow mb-2">{title}</div>
      {(!rows || rows.length === 0) ? (
        <div className="text-[12px] text-muted italic">No data.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const pct = total > 0 ? (Number(r.units) / total) * 100 : 0;
            return (
              <div key={r.label || r.stage_key}>
                <div className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="font-semibold text-[#0f3d24] truncate">
                    {r.stage_name || titleize(r.label)}
                  </span>
                  <span className="text-muted whitespace-nowrap tabular-nums">
                    {fmtQty(r.units)} u · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-panel/70 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${accent || "bg-brand"}`}
                    style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * "By sewing line" roll-up — units currently sitting in the Sewing stage split
 * by the line each piece is on (most-recent line), plus distinct orders/styles
 * per line. Click a line chip to filter the order table to it. Pieces sewn
 * before a line was recorded fall under "Unspecified".
 */
function SewingLineRollup({ rows, active, onPick }) {
  const data = rows || [];
  const total = useMemo(
    () => data.reduce((s, r) => s + (Number(r.units) || 0), 0),
    [data]
  );
  if (data.length === 0) return null;
  return (
    <div className="card-white p-4" data-testid="production-by-sewing-line">
      <div className="eyebrow mb-3">By sewing line — load currently in Sewing</div>
      <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
        {data.map((r) => {
          const unspecified = r.label === "Unspecified";
          const isActive = !unspecified && r.label === active;
          const pct = total > 0 ? (Number(r.units) / total) * 100 : 0;
          return (
            <button
              key={r.label}
              type="button"
              disabled={unspecified}
              onClick={() => !unspecified && onPick(isActive ? "" : r.label)}
              className={`shrink-0 text-left rounded-lg border px-3 py-2.5 min-w-[120px] transition ${
                isActive
                  ? "border-amber-400 bg-amber-50 ring-1 ring-amber-400"
                  : unspecified
                  ? "border-line bg-white opacity-70 cursor-default"
                  : "border-line bg-white hover:border-amber-300 hover:bg-amber-50/40"
              }`}
              data-testid={`production-sewing-line-${r.label}`}
            >
              <div className="text-[11.5px] font-semibold text-[#0f3d24]">
                {unspecified ? "Unspecified" : `Line ${r.label}`}
              </div>
              <div className="text-[20px] font-extrabold text-brand leading-tight mt-0.5 tabular-nums">
                {fmtQty(r.units)}
              </div>
              <div className="text-[10.5px] text-muted">
                {fmtQty(r.styles)} style{Number(r.styles) === 1 ? "" : "s"} · {fmtQty(r.orders)} ord
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-panel/70 overflow-hidden">
                <div
                  className="h-full rounded-full bg-amber-500"
                  style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="card-white p-4">
      <div className="eyebrow">{label}</div>
      <div className="text-[24px] font-extrabold text-brand leading-tight mt-0.5">
        {value}
      </div>
      {sub && <div className="text-[11.5px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * The horizontal stage-flow diagram: a node per stage (units, #styles, % of all
 * in-progress units) connected by arrows in board order. Clicking a node filters
 * the order table to orders currently holding units in that stage.
 */
function FlowDiagram({ stages, activeStage, onPick }) {
  const flowing = useMemo(
    () => (stages || []).filter((s) => !s.is_terminal),
    [stages]
  );
  // Show every stage that either has units or sits on the active path; keep it
  // readable by always rendering the full ordered chain.
  const nodes = stages || [];
  if (nodes.length === 0) {
    return <Empty label="No stage flow available yet." />;
  }
  return (
    <div className="card-white p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="eyebrow">Stage flow — where units sit across the line</div>
        {activeStage && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0f3d24] bg-panel/60 border border-line rounded-full px-2 py-0.5 hover:bg-panel"
          >
            Clear stage filter <X size={11} />
          </button>
        )}
      </div>
      <div className="flex items-stretch gap-0 overflow-x-auto pb-1">
        {nodes.map((s, i) => {
          const isActive = s.stage_key === activeStage;
          const units = Number(s.units) || 0;
          const empty = units === 0;
          return (
            <React.Fragment key={s.stage_key}>
              <button
                type="button"
                onClick={() => onPick(isActive ? null : s.stage_key)}
                className={`shrink-0 text-left rounded-lg border px-3 py-2.5 min-w-[140px] transition ${
                  isActive
                    ? "border-[#1a5c38] bg-emerald-50 ring-1 ring-[#1a5c38]"
                    : empty
                    ? "border-line bg-white opacity-60 hover:opacity-100"
                    : "border-line bg-white hover:border-[#1a5c38]/50 hover:bg-panel/30"
                }`}
                data-testid={`prod-flow-stage-${s.stage_key}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11.5px] font-semibold text-[#0f3d24] truncate">
                    {s.stage_name}
                  </span>
                  {s.is_terminal && (
                    <span className="text-[9px] text-muted uppercase tracking-wide">end</span>
                  )}
                </div>
                <div className="text-[20px] font-extrabold text-brand leading-tight mt-0.5 tabular-nums">
                  {fmtQty(units)}
                </div>
                <div className="text-[10.5px] text-muted">
                  {fmtQty(s.styles)} style{Number(s.styles) === 1 ? "" : "s"} · {fmtQty(s.orders)} ord
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-panel/70 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#1a5c38]"
                    style={{ width: `${Math.max(Number(s.pct) || 0, (Number(s.pct) || 0) > 0 ? 3 : 0)}%` }}
                  />
                </div>
                <div className="text-[10px] text-muted mt-0.5 tabular-nums">
                  {(Number(s.pct) || 0).toFixed(1)}% of WIP
                </div>
              </button>
              {i < nodes.length - 1 && (
                <div className="shrink-0 flex items-center justify-center px-1.5">
                  <ArrowRight size={18} weight="bold" className="text-line" />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
      {flowing.length === 0 && (
        <div className="text-[11.5px] text-muted italic mt-2">All units have reached the final stage.</div>
      )}
    </div>
  );
}

/**
 * Weekly "expected drops" strip — when product is due to land, by Odoo
 * expected_delivery_date. Click a week to filter the table to that window.
 */
function DropStrip({ buckets, today, activeDrop, onPick }) {
  if (!buckets || buckets.length === 0) {
    return null;
  }
  const kindStyle = (b, isActive) => {
    if (isActive) return "border-[#1a5c38] bg-emerald-50 ring-1 ring-[#1a5c38]";
    if (b.kind === "overdue") return "border-rose-200 bg-rose-50 hover:bg-rose-100";
    if (b.kind === "later") return "border-line bg-white opacity-70 hover:opacity-100";
    return "border-line bg-white hover:border-[#1a5c38]/50 hover:bg-panel/30";
  };
  const isThisWeek = (b) => b.kind === "week" && b.week_start && b.week_start <= today && today <= b.week_end;
  return (
    <div className="card-white p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="eyebrow flex items-center gap-1.5">
          <CalendarBlank size={13} /> Expected drops — pending units by delivery week
        </div>
        {activeDrop && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0f3d24] bg-panel/60 border border-line rounded-full px-2 py-0.5 hover:bg-panel"
          >
            Clear week filter <X size={11} />
          </button>
        )}
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
        {buckets.map((b) => {
          const isActive = b.key === activeDrop;
          const label =
            b.kind === "week"
              ? `${fmtDayShort(b.week_start)}–${fmtDayShort(b.week_end)}`
              : b.label;
          const empty = Number(b.units) === 0;
          return (
            <button
              key={b.key}
              type="button"
              disabled={empty}
              onClick={() => onPick(isActive ? null : b.key)}
              className={`shrink-0 text-left rounded-lg border px-3 py-2 min-w-[110px] transition ${kindStyle(b, isActive)} ${empty ? "cursor-default" : ""}`}
              data-testid={`prod-drop-${b.key}`}
            >
              <div className="flex items-center gap-1 text-[11px] font-semibold text-[#0f3d24]">
                <span className="truncate">{label}</span>
                {isThisWeek(b) && (
                  <span className="text-[8.5px] uppercase tracking-wide text-[#1a5c38] bg-emerald-100 rounded px-1">now</span>
                )}
              </div>
              <div className={`text-[18px] font-extrabold leading-tight mt-0.5 tabular-nums ${b.kind === "overdue" ? "text-rose-700" : "text-brand"}`}>
                {fmtQty(b.units)}
              </div>
              <div className="text-[10px] text-muted">
                {fmtQty(b.styles)} style{Number(b.styles) === 1 ? "" : "s"}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const SEWING_LINE_OPTS = ["A", "B", "C", "D", "E"];

/**
 * Bulk-advance toolbar for the active order table. The operator picks a FROM
 * stage (only stages the selected orders actually hold units in), a destination
 * (the from-stage's allowed next), and — when moving into Sewing from anywhere
 * other than Repairs — a single sewing line A–E applied to the whole batch.
 * Repairs → Sewing auto-routes each piece back to its original line.
 */
function ReportBulkToolbar({ fromStages, flowStages, count, busy, msg, onMove, onClear }) {
  const [fromStage, setFromStage] = useState("");
  const [toStage, setToStage] = useState("");
  const [sewingLine, setSewingLine] = useState("");
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const fromKeys = fromStages.map((s) => s.stage_key).join(",");
  useEffect(() => {
    if (!fromStages.some((s) => s.stage_key === fromStage)) {
      setFromStage(fromStages[0]?.stage_key || "");
    }
  }, [fromKeys, fromStage, fromStages]);

  const allowed = useMemo(() => {
    const s = flowStages.find((x) => x.stage_key === fromStage);
    return (s?.allowed_next || []);
  }, [flowStages, fromStage]);

  useEffect(() => {
    if (!allowed.includes(toStage)) setToStage(allowed[0] || "");
  }, [allowed, toStage]);

  const stageName = (key) => flowStages.find((s) => s.stage_key === key)?.stage_name || String(key).replace(/_/g, " ");
  const intoSewing = toStage === "sewing";
  const fromRepairs = fromStage === "repairs";
  // Repairs -> Sewing auto-routes each piece to its original line, so no line is
  // required — but pieces with no line on record need a fallback, so still offer
  // an OPTIONAL picker. Any other move into Sewing needs one chosen line.
  const needLine = intoSewing && !fromRepairs;
  const offerFallback = intoSewing && fromRepairs;

  const submit = () => {
    setErr(null);
    if (!fromStage) { setErr("Pick a current stage."); return; }
    if (!toStage) { setErr("Pick a destination."); return; }
    if (needLine && !sewingLine) { setErr("Pick a sewing line (A–E)."); return; }
    setConfirm({ fromStage, toStage, sewingLine: intoSewing ? (sewingLine || undefined) : undefined });
  };

  if (confirm) {
    return (
      <div className="mb-3 rounded-lg border border-[#1a5c38]/30 bg-brand/5 px-3 py-2.5" data-testid="production-report-bulkbar">
        <div className="text-[12px] font-bold text-[#0f3d24] mb-1">Confirm move</div>
        <div className="text-[12px] text-[#0f3d24] mb-2.5" data-testid="production-report-bulk-confirm-summary">
          Move <span className="font-bold">{count}</span> order{count === 1 ? "" : "s"} from{" "}
          <span className="font-semibold">{stageName(confirm.fromStage)}</span> to{" "}
          <span className="font-semibold">{stageName(confirm.toStage)}</span>
          {confirm.sewingLine ? <> · sewing line <span className="font-semibold">{confirm.sewingLine}</span></> : null}?
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { const c = confirm; setConfirm(null); onMove(c); }}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-1.5 rounded-md disabled:opacity-50"
            data-testid="production-report-bulk-confirm"
          >
            {busy ? "Moving…" : "Confirm move"}
          </button>
          <button
            type="button"
            onClick={() => setConfirm(null)}
            disabled={busy}
            className="text-[12px] font-semibold text-[#0f3d24] border border-[#1a5c38]/30 hover:bg-white px-3 py-1.5 rounded-md disabled:opacity-50"
            data-testid="production-report-bulk-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-[#1a5c38]/30 bg-brand/5 px-3 py-2.5" data-testid="production-report-bulkbar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-bold text-[#0f3d24]">{count} selected</span>
        <span className="text-muted text-[12px]">Advance from</span>
        <select
          value={fromStage}
          onChange={(e) => setFromStage(e.target.value)}
          className="input-pill text-[12px]"
          data-testid="production-report-bulk-from"
        >
          {fromStages.length === 0 && <option value="">—</option>}
          {fromStages.map((s) => (
            <option key={s.stage_key} value={s.stage_key}>{s.stage_name}</option>
          ))}
        </select>
        <span className="text-muted text-[12px]">to</span>
        <select
          value={toStage}
          onChange={(e) => setToStage(e.target.value)}
          className="input-pill text-[12px]"
          data-testid="production-report-bulk-to"
        >
          {allowed.length === 0 && <option value="">—</option>}
          {allowed.map((k) => (
            <option key={k} value={k}>{stageName(k)}</option>
          ))}
        </select>
        {(needLine || offerFallback) && (
          <select
            value={sewingLine}
            onChange={(e) => setSewingLine(e.target.value)}
            className="input-pill text-[12px]"
            data-testid="production-report-bulk-line"
          >
            <option value="">{offerFallback ? "Fallback line…" : "Sewing line…"}</option>
            {SEWING_LINE_OPTS.map((l) => (
              <option key={l} value={l}>Line {l}</option>
            ))}
          </select>
        )}
        {offerFallback && (
          <span className="text-[11px] text-muted italic">auto-routes to original line; fallback for unknowns</span>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-1.5 rounded-md disabled:opacity-50"
          data-testid="production-report-bulk-move"
        >
          {busy ? "Moving…" : "Advance selected"}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="text-[11.5px] text-muted hover:text-[#0f3d24] underline"
          data-testid="production-report-bulk-clear"
        >
          Clear
        </button>
      </div>
      {err && <div className="mt-1.5 text-[11.5px] text-rose-700">{err}</div>}
      {msg && (
        <div
          className={`mt-1.5 rounded-md border px-2.5 py-1.5 text-[11.5px] ${
            msg.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-amber-50 border-amber-200 text-amber-800"
          }`}
          data-testid="production-report-bulk-result"
        >
          <span className="font-semibold">{msg.text}</span>
          {msg.failed && msg.failed.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {msg.failed.map((f) => (
                <li key={f.ref}>
                  <span className="font-mono font-semibold">{f.ref}</span>
                  {f.error ? <span className="text-amber-700"> — {f.error}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {msg.moved && msg.moved.length > 0 && (
            <div className="mt-1 opacity-80">
              Moved: <span className="font-mono">{msg.moved.join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProductionReport() {
  const [data, setData] = useState(null);
  const [flow, setFlow] = useState(null);
  const [drops, setDrops] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [sewingLineFilter, setSewingLineFilter] = useState("");
  const [stageFilter, setStageFilter] = useState(null);
  const [dropFilter, setDropFilter] = useState(null);
  const [openOrder, setOpenOrder] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  // Multi-BO bulk advance (active table only).
  const [selRefs, setSelRefs] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const opts = force ? { forceFresh: true } : {};
    try {
      const [summaryRes, flowRes, dropsRes] = await Promise.all([
        api.get("/production/summary", opts),
        api.get("/production/flow", opts),
        api.get("/production/expected-drops", opts),
      ]);
      setData(summaryRes.data);
      setFlow(flowRes.data);
      setDrops(dropsRes.data);
    } catch (err) {
      setError(
        err?.response?.data?.detail ||
          err.message ||
          "Failed to load the production report"
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const toggleSelect = useCallback((ref) => {
    setBulkMsg(null);
    setSelRefs((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref); else next.add(ref);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelRefs(new Set());
    setBulkMsg(null);
  }, []);

  const bulkAdvance = useCallback(async ({ fromStage, toStage, sewingLine, refs }) => {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const { data } = await api.post("/production/bulk-move", {
        order_refs: refs,
        from_stage: fromStage,
        to_stage: toStage,
        sewing_line: sewingLine || undefined,
      });
      const results = data?.results || [];
      const moved = data?.moved_count || 0;
      const failed = data?.failed_count || 0;
      const movedRefs = results.filter((r) => r.ok !== false).map((r) => r.order_ref).filter(Boolean);
      const failedRows = results.filter((r) => r.ok === false);
      if (failed > 0) {
        setBulkMsg({
          kind: "warn",
          text: `Moved ${moved} order${moved === 1 ? "" : "s"}, ${failed} failed`,
          moved: movedRefs,
          failed: failedRows.map((r) => ({ ref: r.order_ref, error: r.error })),
        });
        // Keep only the still-failing orders selected so the operator can retry.
        setSelRefs(new Set(failedRows.map((r) => r.order_ref)));
      } else {
        setBulkMsg({ kind: "ok", text: `Moved ${moved} order${moved === 1 ? "" : "s"}`, moved: movedRefs, failed: [] });
        setSelRefs(new Set());
      }
      await load(true);
    } catch (err) {
      setBulkMsg({ kind: "warn", text: err?.response?.data?.detail || err.message || "Bulk move failed" });
    } finally {
      setBulkBusy(false);
    }
  }, [load]);

  const totals = data?.totals || { orders: 0, units: 0, styles: 0 };
  const byStage = data?.by_stage || [];
  const orders = data?.orders || [];
  const flowStages = flow?.stages || [];

  const stageCols = useMemo(
    () => byStage.map((s) => ({ key: s.stage_key, name: s.stage_name })),
    [byStage]
  );

  const inProgressUnits = useMemo(
    () => byStage.reduce((s, r) => s + (Number(r.units) || 0), 0),
    [byStage]
  );

  // Order refs in the currently-selected drop bucket (for the table filter).
  const dropOrderRefs = useMemo(() => {
    if (!dropFilter) return null;
    const b = (drops?.buckets || []).find((x) => x.key === dropFilter);
    if (!b) return null;
    return new Set((b.orders || []).map((o) => o.order_ref));
  }, [dropFilter, drops]);

  const activeStageName = useMemo(
    () => flowStages.find((s) => s.stage_key === stageFilter)?.stage_name || "",
    [flowStages, stageFilter]
  );

  // Terminal (warehouse) stage keys — an order is "complete" once ALL of its
  // units have arrived there and none remain in any earlier stage.
  const terminalKeys = useMemo(
    () => new Set(flowStages.filter((s) => s.is_terminal).map((s) => s.stage_key)),
    [flowStages]
  );
  const isComplete = useCallback(
    (o) => {
      const sq = o.stage_qty || {};
      let term = 0;
      let nonTerm = 0;
      for (const [k, v] of Object.entries(sq)) {
        const n = Number(v) || 0;
        if (terminalKeys.has(k)) term += n;
        else nonTerm += n;
      }
      return term > 0 && nonTerm === 0;
    },
    [terminalKeys]
  );

  const matchesText = useCallback(
    (o) => {
      const q = query.trim().toLowerCase();
      if (lifecycleFilter && (o.lifecycle_type || "") !== lifecycleFilter)
        return false;
      if (sewingLineFilter && !(o.sewing_lines || []).includes(sewingLineFilter))
        return false;
      if (!q) return true;
      return [o.order_ref, o.style_number, o.style_name, o.product_name, o.buyer]
        .some((v) => String(v || "").toLowerCase().includes(q));
    },
    [query, lifecycleFilter, sewingLineFilter]
  );

  // Active orders honour every filter (incl. stage-flow + drop window); completed
  // orders have all arrived, so the WIP-oriented stage/drop filters don't apply to
  // them — only the text + lifecycle filters do.
  const filtered = useMemo(() => {
    return orders.filter((o) => {
      if (isComplete(o)) return false;
      if (!matchesText(o)) return false;
      if (stageFilter && !(Number((o.stage_qty || {})[stageFilter]) > 0))
        return false;
      if (dropOrderRefs && !dropOrderRefs.has(o.order_ref)) return false;
      return true;
    });
  }, [orders, matchesText, isComplete, stageFilter, dropOrderRefs]);

  const completedOrders = useMemo(
    () => orders.filter((o) => isComplete(o) && matchesText(o)),
    [orders, isComplete, matchesText]
  );

  // Selection is scoped to the currently-visible active rows.
  const selectedOrders = useMemo(
    () => filtered.filter((o) => selRefs.has(o.order_ref)),
    [filtered, selRefs]
  );
  const allActiveSelected = filtered.length > 0 && filtered.every((o) => selRefs.has(o.order_ref));
  const someActiveSelected = selectedOrders.length > 0;
  const toggleSelectAllActive = useCallback(() => {
    setBulkMsg(null);
    setSelRefs((prev) => {
      const everySel = filtered.length > 0 && filtered.every((o) => prev.has(o.order_ref));
      if (everySel) return new Set();
      return new Set(filtered.map((o) => o.order_ref));
    });
  }, [filtered]);

  // Stages that at least one selected order currently holds units in — these are
  // the valid "from" stages for a bulk advance (one move per from-stage).
  const selectableFromStages = useMemo(() => {
    const keys = new Set();
    for (const o of selectedOrders) {
      for (const [k, v] of Object.entries(o.stage_qty || {})) {
        if (Number(v) > 0 && !terminalKeys.has(k)) keys.add(k);
      }
    }
    return flowStages.filter((s) => keys.has(s.stage_key));
  }, [selectedOrders, flowStages, terminalKeys]);

  const lifecycleOptions = useMemo(
    () =>
      (data?.by_lifecycle || [])
        .map((r) => r.label)
        .filter((l) => l && l !== "Unspecified"),
    [data]
  );

  // Every sewing line that appears on any order (so the filter only offers lines
  // that actually ran), sorted A→E.
  const sewingLineOptions = useMemo(() => {
    const s = new Set();
    for (const o of orders) for (const l of o.sewing_lines || []) if (l) s.add(l);
    return Array.from(s).sort();
  }, [orders]);

  const exportCsv = useCallback(() => {
    const cols = [
      "Order",
      "BO created",
      "Style number",
      "Style name",
      "Buyer",
      "Lifecycle",
      "Production type",
      "BO state",
      "Colours",
      "Sizes",
      "Variants",
      "Order qty",
      "In progress",
      "Sewing line(s)",
      "Expected delivery",
      ...stageCols.map((s) => s.name),
    ];
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    // Export the WHOLE order report the user is looking at: active orders that
    // match every filter PLUS the completed (fully-landed) orders shown below.
    // Otherwise completed orders silently drop out of the CSV.
    for (const o of [...filtered, ...completedOrders]) {
      const sq = o.stage_qty || {};
      const row = [
        o.order_ref,
        o.date_ordered ? String(o.date_ordered).slice(0, 10) : "",
        o.style_number,
        o.style_name,
        o.buyer,
        o.lifecycle_type,
        o.production_type,
        titleize(o.bo_state),
        o.colours,
        o.sizes,
        o.variants,
        o.order_qty,
        o.units_in_progress,
        (o.sewing_lines || []).join(" / "),
        o.expected_delivery_date ? String(o.expected_delivery_date).slice(0, 10) : "",
        ...stageCols.map((s) => sq[s.key] || 0),
      ];
      lines.push(row.map(esc).join(","));
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `production-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, completedOrders, stageCols]);

  if (loading) return <Loading label="Loading the production report…" />;
  if (error) return <ErrorBox message={error} />;

  const hasTableFilter = stageFilter || dropFilter || lifecycleFilter || query;

  return (
    <div className="space-y-5" data-testid="production-report">
      <SectionTitle
        title="Production Report"
        subtitle="The line as a flow — where every buying order's units sit across the stages, when product is due to land, and the colour/size detail behind each style."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#0f3d24] bg-white border border-line hover:bg-panel/60 px-3 py-2 rounded-md"
              data-testid="production-report-csv"
            >
              <DownloadSimple size={14} weight="bold" /> CSV
            </button>
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-2 rounded-md disabled:opacity-50"
              data-testid="production-report-refresh"
            >
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={refreshing ? "animate-spin" : ""}
              />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        }
      />

      {/* KPI row */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi label="Buying orders" value={fmtQty(totals.orders)} />
        <Kpi label="Ordered units" value={fmtQty(totals.units)} />
        <Kpi label="Distinct styles" value={fmtQty(totals.styles)} />
        <Kpi
          label="Units in progress"
          value={fmtQty(inProgressUnits)}
          sub="Across all active stages"
        />
      </div>

      {/* Stage flow diagram */}
      <FlowDiagram
        stages={flowStages}
        activeStage={stageFilter}
        onPick={setStageFilter}
      />

      {/* Expected drops strip */}
      <DropStrip
        buckets={drops?.buckets}
        today={drops?.today}
        activeDrop={dropFilter}
        onPick={setDropFilter}
      />

      {/* Breakdowns */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <BreakdownCard
          title="By order type"
          rows={data?.by_lifecycle}
          accent="bg-emerald-500"
        />
        <BreakdownCard
          title="By buying-order state"
          rows={data?.by_state}
          accent="bg-amber-500"
        />
        <BreakdownCard
          title="What is where (current stage)"
          rows={(byStage || []).filter((s) => Number(s.units) > 0)}
          accent="bg-violet-500"
        />
      </div>

      {/* By sewing line — load currently sitting in Sewing, split by line */}
      <SewingLineRollup
        rows={data?.by_sewing_line}
        active={sewingLineFilter}
        onPick={setSewingLineFilter}
      />

      {/* Per-order table */}
      <div className="card-white p-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="eyebrow">
            Orders ({fmtQty(filtered.length)}
            {filtered.length !== orders.length ? ` of ${fmtQty(orders.length)}` : ""})
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={lifecycleFilter}
              onChange={(e) => setLifecycleFilter(e.target.value)}
              className="input-pill text-[12px]"
              data-testid="production-report-lifecycle"
            >
              <option value="">All order types</option>
              {lifecycleOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            {sewingLineOptions.length > 0 && (
              <select
                value={sewingLineFilter}
                onChange={(e) => setSewingLineFilter(e.target.value)}
                className="input-pill text-[12px]"
                data-testid="production-report-sewing-line"
              >
                <option value="">All sewing lines</option>
                {sewingLineOptions.map((l) => (
                  <option key={l} value={l}>
                    Line {l}
                  </option>
                ))}
              </select>
            )}
            <div className="relative">
              <MagnifyingGlass
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search order, style, buyer…"
                className="input-pill text-[12px] pl-8 pr-7 w-56"
                data-testid="production-report-search"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Active filter chips */}
        {hasTableFilter && (
          <div className="flex items-center gap-1.5 flex-wrap mb-3 text-[11.5px]">
            <span className="text-muted inline-flex items-center gap-1">
              <Funnel size={12} /> Filtered by:
            </span>
            {stageFilter && (
              <button
                type="button"
                onClick={() => setStageFilter(null)}
                className="inline-flex items-center gap-1 font-semibold text-[#0f3d24] bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5"
              >
                Stage: {activeStageName} <X size={11} />
              </button>
            )}
            {dropFilter && (
              <button
                type="button"
                onClick={() => setDropFilter(null)}
                className="inline-flex items-center gap-1 font-semibold text-[#0f3d24] bg-sky-50 border border-sky-200 rounded-full px-2 py-0.5"
              >
                Drop window <X size={11} />
              </button>
            )}
            {lifecycleFilter && (
              <button
                type="button"
                onClick={() => setLifecycleFilter("")}
                className="inline-flex items-center gap-1 font-semibold text-[#0f3d24] bg-violet-50 border border-violet-200 rounded-full px-2 py-0.5"
              >
                {lifecycleFilter} <X size={11} />
              </button>
            )}
            {sewingLineFilter && (
              <button
                type="button"
                onClick={() => setSewingLineFilter("")}
                className="inline-flex items-center gap-1 font-semibold text-[#0f3d24] bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5"
              >
                Line {sewingLineFilter} <X size={11} />
              </button>
            )}
          </div>
        )}

        {someActiveSelected && (
          <ReportBulkToolbar
            fromStages={selectableFromStages}
            flowStages={flowStages}
            count={selectedOrders.length}
            busy={bulkBusy}
            msg={bulkMsg}
            onClear={clearSelection}
            onMove={({ fromStage, toStage, sewingLine }) =>
              bulkAdvance({
                fromStage,
                toStage,
                sewingLine,
                refs: selectedOrders.map((o) => o.order_ref),
              })
            }
          />
        )}

        {filtered.length === 0 ? (
          <Empty label="No orders match the current search / filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-panel/60 text-muted">
                <tr>
                  <th className="px-2 py-2 w-8">
                    <input
                      type="checkbox"
                      className="accent-[#1a5c38] cursor-pointer"
                      aria-label="Select all visible orders"
                      checked={allActiveSelected}
                      ref={(el) => { if (el) el.indeterminate = someActiveSelected && !allActiveSelected; }}
                      onChange={toggleSelectAllActive}
                      data-testid="production-report-select-all"
                    />
                  </th>
                  <th className="text-left font-semibold px-3 py-2">Order</th>
                  <th className="text-left font-semibold px-3 py-2">BO created</th>
                  <th className="text-left font-semibold px-3 py-2">Style</th>
                  <th className="text-left font-semibold px-3 py-2">Buyer</th>
                  <th className="text-left font-semibold px-3 py-2">Type</th>
                  <th className="text-right font-semibold px-2.5 py-2">Colours</th>
                  <th className="text-right font-semibold px-2.5 py-2">Sizes</th>
                  <th className="text-right font-semibold px-2.5 py-2">Order qty</th>
                  <th className="text-left font-semibold px-3 py-2">Sewing line</th>
                  <th className="text-left font-semibold px-3 py-2">What is where</th>
                  <th className="text-left font-semibold px-3 py-2">Expected</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const sq = o.stage_qty || {};
                  const active = stageCols.filter((s) => Number(sq[s.key]) > 0);
                  return (
                    <tr
                      key={o.order_ref}
                      className={`border-t border-line hover:bg-panel/40 cursor-pointer ${selRefs.has(o.order_ref) ? "bg-emerald-50/60" : ""}`}
                      onClick={() => setOpenOrder(o.order_ref)}
                      data-testid={`production-report-row-${o.order_ref}`}
                    >
                      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="accent-[#1a5c38] cursor-pointer"
                          checked={selRefs.has(o.order_ref)}
                          onChange={() => toggleSelect(o.order_ref)}
                          aria-label={`Select order ${o.order_ref}`}
                          data-testid={`production-report-select-${o.order_ref}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-semibold text-brand whitespace-nowrap">
                        {o.order_ref}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">
                        {fmtDate(o.date_ordered)}
                      </td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <div className="font-semibold text-[#0f3d24] truncate">
                          {o.style_name || o.product_name || o.style_number || "—"}
                        </div>
                        {o.style_number && (
                          <div className="text-[10.5px] text-muted truncate">
                            {o.style_number}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap max-w-[120px] truncate">
                        {o.buyer || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {o.lifecycle_type ? (
                          <span
                            className={`inline-block text-[10.5px] font-semibold px-1.5 py-0.5 rounded border ${lifecycleBadge(
                              o.lifecycle_type
                            )}`}
                          >
                            {o.lifecycle_type}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums">
                        {fmtQty(o.colours)}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums">
                        {fmtQty(o.sizes)}
                      </td>
                      <td className="px-2.5 py-2 text-right font-semibold tabular-nums">
                        {fmtQty(o.order_qty)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {(o.sewing_lines || []).length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {o.sewing_lines.map((l) => (
                              <span
                                key={l}
                                className={`inline-flex items-center text-[10.5px] font-semibold border rounded-full px-1.5 py-0.5 ${
                                  l === sewingLineFilter
                                    ? "bg-amber-100 border-amber-300 text-amber-800"
                                    : "bg-amber-50 border-amber-200 text-amber-700"
                                }`}
                              >
                                {l}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {active.length === 0 ? (
                          <span className="text-muted italic text-[11px]">
                            Not started / done
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {active.map((s) => (
                              <span
                                key={s.key}
                                className={`inline-flex items-center gap-1 text-[10.5px] border rounded-full px-1.5 py-0.5 whitespace-nowrap ${
                                  s.key === stageFilter
                                    ? "bg-emerald-50 border-emerald-300"
                                    : "bg-panel/70 border-line"
                                }`}
                                title={s.name}
                              >
                                <span className="text-[#0f3d24]">{s.name}</span>
                                <span className="font-semibold tabular-nums">
                                  {fmtQty(sq[s.key])}
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">
                        {fmtDate(o.expected_delivery_date)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Completed orders — everything that has fully landed in the warehouse. */}
      <div className="card-white p-4" data-testid="production-completed">
        <button
          type="button"
          onClick={() => setShowCompleted((v) => !v)}
          className="w-full flex items-center justify-between gap-3"
        >
          <span className="eyebrow flex items-center gap-1.5">
            <ArrowRight size={13} weight="bold" className="text-[#1a5c38]" />
            Completed orders — fully in warehouse ({fmtQty(completedOrders.length)})
          </span>
          <span className="text-[11.5px] font-semibold text-[#0f3d24] bg-panel/60 border border-line rounded-full px-2 py-0.5">
            {showCompleted ? "Hide" : "Show"}
          </span>
        </button>

        {showCompleted &&
          (completedOrders.length === 0 ? (
            <div className="mt-3">
              <Empty label="No orders have fully reached the warehouse yet." />
            </div>
          ) : (
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-[12px] border-collapse">
                <thead className="bg-panel/60 text-muted">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Order</th>
                    <th className="text-left font-semibold px-3 py-2">BO created</th>
                    <th className="text-left font-semibold px-3 py-2">Style</th>
                    <th className="text-left font-semibold px-3 py-2">Buyer</th>
                    <th className="text-left font-semibold px-3 py-2">Type</th>
                    <th className="text-right font-semibold px-2.5 py-2">Colours</th>
                    <th className="text-right font-semibold px-2.5 py-2">Sizes</th>
                    <th className="text-right font-semibold px-2.5 py-2">Order qty</th>
                    <th className="text-right font-semibold px-2.5 py-2">In warehouse</th>
                    <th className="text-left font-semibold px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {completedOrders.map((o) => {
                    const sq = o.stage_qty || {};
                    const inWh = Object.entries(sq).reduce(
                      (s, [k, v]) => (terminalKeys.has(k) ? s + (Number(v) || 0) : s),
                      0
                    );
                    return (
                      <tr
                        key={o.order_ref}
                        className="border-t border-line hover:bg-panel/40 cursor-pointer"
                        onClick={() => setOpenOrder(o.order_ref)}
                        data-testid={`production-completed-row-${o.order_ref}`}
                      >
                        <td className="px-3 py-2 font-semibold text-brand whitespace-nowrap">
                          {o.order_ref}
                        </td>
                        <td className="px-3 py-2 text-muted whitespace-nowrap">
                          {fmtDate(o.date_ordered)}
                        </td>
                        <td className="px-3 py-2 max-w-[200px]">
                          <div className="font-semibold text-[#0f3d24] truncate">
                            {o.style_name || o.product_name || o.style_number || "—"}
                          </div>
                          {o.style_number && (
                            <div className="text-[10.5px] text-muted truncate">
                              {o.style_number}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted whitespace-nowrap max-w-[120px] truncate">
                          {o.buyer || "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {o.lifecycle_type ? (
                            <span
                              className={`inline-block text-[10.5px] font-semibold px-1.5 py-0.5 rounded border ${lifecycleBadge(
                                o.lifecycle_type
                              )}`}
                            >
                              {o.lifecycle_type}
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="px-2.5 py-2 text-right tabular-nums">
                          {fmtQty(o.colours)}
                        </td>
                        <td className="px-2.5 py-2 text-right tabular-nums">
                          {fmtQty(o.sizes)}
                        </td>
                        <td className="px-2.5 py-2 text-right font-semibold tabular-nums">
                          {fmtQty(o.order_qty)}
                        </td>
                        <td className="px-2.5 py-2 text-right font-semibold tabular-nums">
                          {fmtQty(inWh)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                            Arrived
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      {openOrder && (
        <ProductionOrderModal
          orderRef={openOrder}
          onClose={() => setOpenOrder(null)}
          onChanged={() => load(true)}
        />
      )}
    </div>
  );
}
