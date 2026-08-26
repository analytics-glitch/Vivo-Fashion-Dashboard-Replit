import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowClockwise, ArrowSquareOut, CalendarBlank, CaretRight, CheckCircle,
  ClockCounterClockwise, Factory, FileText, Flag, Package, Plus,
  ShieldWarning, Stack, WarningCircle, Wrench,
} from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { productionScopeParams, readProductionScope } from "@/lib/productionScope";
import ProductionWorkspaceShell from "@/components/ProductionWorkspaceShell";
import ProductionTrackerSheetPanel from "@/components/ProductionTrackerSheetPanel";
import ProductionTrackerTrendChart from "@/components/ProductionTrackerTrendChart";

const PlanningWorkspace = React.lazy(() => import("./ProductionWorkspace"));
const ExecutionCapture = React.lazy(() => import("./ProductionExecution"));
const ProductivityRecovery = React.lazy(() => import("./ProductionInsights"));

const MODULES = new Set([
  "workspace", "plan", "line-board", "work-orders", "execution", "quality",
  "machines", "productivity", "recovery", "huddle", "team", "resources", "settings",
]);
const LEGACY_TAB_MODULE = {
  dashboard: "workspace", workspace: "plan", capture: "execution", insights: "recovery",
};
const today = () => new Date().toISOString().slice(0, 10);
const number = (value) => value == null ? "Unavailable" : Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const percent = (value) => value == null ? "Unavailable" : `${Number(value).toFixed(1)}%`;
const text = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const safeControlledUrl = (value) => {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};

function EmptyModule({ title, children, action }) {
  return <div className="pw-panel">
    <div className="pw-empty-module">
      <strong>{title}</strong>
      <div>{children}</div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  </div>;
}

function PageIntro({ eyebrow, title, subtitle, action }) {
  return <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <div className="pw-eyebrow">{eyebrow}</div>
      <h1 className="pw-heading mt-1">{title}</h1>
      <p className="pw-subheading mt-2">{subtitle}</p>
    </div>
    {action}
  </div>;
}

function ControlRoom({ scope, onNavigate }) {
  const [data, setData] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = productionScopeParams(scope);
      const [command, queue] = await Promise.all([
        api.get("/production-workspace/command-centre", { params, forceFresh: true }),
        api.get("/production-workspace/recovery", { params, forceFresh: true }),
      ]);
      setData(command.data); setRecovery(queue.data);
    } catch (err) {
      setError(err?.response?.data?.detail || "The control-room sources could not be loaded.");
    } finally { setLoading(false); }
  }, [scope]);
  useEffect(() => { load(); }, [load]);
  const metrics = data?.metrics || {};
  const snapshots = [
    ["Current WIP", number(metrics.wip_units), "Verified tracker stage balances"],
    ["Today's plan", number(metrics.plan_qty), "Approved dated plan only"],
    ["Actual good output", number(metrics.good_qty), "Validated execution capture"],
    ["Line efficiency", percent(metrics.efficiency_pct), "Approved SAM + complete attendance"],
    ["Defects & rework", metrics.reject_qty == null && metrics.rework_qty == null ? "Unavailable" : `${number(metrics.reject_qty)} / ${number(metrics.rework_qty)}`, "Rejects / rework capture"],
    ["Downtime", metrics.downtime_minutes == null ? "Unavailable" : `${number(metrics.downtime_minutes)} min`, "Validated downtime events"],
  ];
  const commitments = data?.delivery_risk || [];
  const owned = (recovery?.actions || []).filter((item) => !["resolved", "closed"].includes(item.status));
  const freshness = Object.entries(data?.source_freshness || {});
  return <div className="pw-page space-y-5" data-testid="pw-workspace-home">
    <PageIntro
      eyebrow="Factory control room"
      title="Run today with clear evidence."
      subtitle="The factory view is deliberately separate from commercial BI filters. Every blank below means a source or approved denominator is missing — it is never treated as zero."
      action={<button className="pw-action" onClick={() => onNavigate("plan")} data-testid="pw-open-todays-plan"><CalendarBlank size={16} />Open today’s plan</button>}
    />
    {loading ? <div className="pw-panel p-8 text-center text-sm" style={{ color: "var(--pw-text-muted)" }}>Loading verified factory context…</div> : error ? <div className="pw-panel p-4 text-sm text-rose-800"><WarningCircle className="inline mr-2" />{error}<button className="ml-3 font-bold underline" onClick={load}>Retry</button></div> : <>
      <section className="pw-panel pw-panel--dark p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><div className="pw-eyebrow">Today’s operational snapshot</div><div className="mt-1 text-sm text-white/70">{data?.as_of ? `Source snapshot as of ${new Date(data.as_of).toLocaleString("en-GB", { timeZone: "Africa/Nairobi" })} EAT` : "Source timestamp unavailable — inspect source health below."}</div></div>
          {(data?.completeness?.state || "unknown") !== "complete" && <span className="pw-chip pw-chip--warning">Decision data {data?.completeness?.state || "incomplete"}</span>}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          {snapshots.map(([label, value, note]) => <div key={label} className="min-w-0"><div className="pw-metric-label">{label}</div><div className="pw-metric-value mt-1 truncate">{value}</div><div className="pw-metric-note mt-2">{note}</div></div>)}
        </div>
      </section>
      <div className="pw-module-grid">
        <section className="pw-panel col-span-12 xl:col-span-7">
          <div className="flex items-center justify-between border-b p-4" style={{ borderColor: "var(--pw-border-light)" }}><div><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Recent production activity</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Open recovery actions and delivery commitments in the selected factory scope.</div></div><button className="text-xs font-bold" style={{ color: "var(--pw-navy)" }} onClick={() => onNavigate("recovery")}>Recovery room <CaretRight className="inline" size={13} /></button></div>
          {!owned.length && !commitments.length ? <div className="pw-empty-module"><strong>No verified operational activity is available yet.</strong>Approve plans and capture execution events to build the factory activity trail.</div> :
            <div className="divide-y">{[...owned.slice(0, 3), ...commitments.slice(0, Math.max(0, 4 - owned.length))].map((row, index) => <div className="flex items-start justify-between gap-3 p-4" key={`${row.id || row.plan_version_id}-${index}`}><div className="min-w-0"><div className="text-sm font-bold" style={{ color: "var(--pw-navy)" }}>{row.title || row.style_number || row.external_ref || "Delivery commitment"}</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>{row.rationale?.[0] || row.reasons?.[0] || "Evidence is awaiting a captured operational explanation."}</div></div><span className="pw-chip">{text(row.status || row.priority_band || "open")}</span></div>)}</div>}
        </section>
        <section className="pw-panel col-span-12 xl:col-span-5 p-4">
          <div className="font-bold" style={{ color: "var(--pw-navy)" }}>Source freshness</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Every calculation keeps its own provenance.</div>
          <div className="mt-4 space-y-2">{freshness.length ? freshness.map(([key, item]) => <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2" key={key} style={{ borderColor: "var(--pw-border)" }}><div><div className="text-xs font-bold" style={{ color: "var(--pw-navy)" }}>{text(key)}</div><div className="text-[11px]" style={{ color: "var(--pw-text-muted)" }}>{item.as_of || "Timestamp unavailable"}</div></div><span className={`pw-chip ${["fresh", "ready", "complete"].includes(item.state) ? "pw-chip--ok" : "pw-chip--warning"}`}>{item.state || "unknown"}</span></div>) : <div className="text-sm" style={{ color: "var(--pw-text-muted)" }}>No source freshness record is available.</div>}</div>
        </section>
        <section className="pw-panel col-span-12 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Key dates & delivery commitments</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Only approved-plan commitments are listed here.</div></div><button className="pw-action pw-action--quiet" onClick={() => onNavigate("work-orders")}><Package size={15} />Open work orders</button></div>
          {!commitments.length ? <div className="pw-empty-module"><strong>No approved delivery commitments match this scope.</strong>There is nothing to schedule yet, rather than a zero-risk claim.</div> : <div className="pw-table-wrap mt-4"><table className="pw-table"><thead><tr><th>Commitment</th><th>Due</th><th>Line</th><th>Risk evidence</th></tr></thead><tbody>{commitments.slice(0, 8).map((row) => <tr key={row.plan_version_id}><td className="font-semibold">{row.style_number || row.external_ref || "Plan"}</td><td>{row.planned_end || "Due date unavailable"}</td><td>{row.factory_name || "Factory unavailable"} · {row.line_name || "Line unassigned"}</td><td>{(row.reasons || []).slice(0, 2).join(" ") || "Evidence unavailable"}</td></tr>)}</tbody></table></div>}
        </section>
        <div className="col-span-12"><ProductionTrackerTrendChart variant="monthly_output" /></div>
      </div>
    </>}
  </div>;
}

function LineBoard({ scope, onNavigate }) {
  const [plans, setPlans] = useState([]); const [loading, setLoading] = useState(true);
  useEffect(() => { let alive = true; setLoading(true); api.get("/production-workspace/plans", { params: productionScopeParams(scope), forceFresh: true }).then((res) => alive && setPlans(res.data?.plans || [])).catch(() => alive && setPlans([])).finally(() => alive && setLoading(false)); return () => { alive = false; }; }, [scope]);
  const groups = useMemo(() => plans.reduce((out, plan) => { const key = `${plan.factory_name || "Unallocated factory"} · ${plan.line_name || "Unallocated line"}`; (out[key] ||= []).push(plan); return out; }, {}), [plans]);
  return <div className="pw-page space-y-5" data-testid="pw-line-board"><PageIntro eyebrow="Day & week planning" title="Line board" subtitle="Read approved and draft line commitments together. Feasibility is only displayed when the approved capacity inputs are present." action={<button className="pw-action" onClick={() => onNavigate("plan")}><Plus size={16} />Create or review plan</button>} />
    {loading ? <div className="pw-panel p-8 text-center text-sm" style={{ color: "var(--pw-text-muted)" }}>Loading dated line commitments…</div> : !plans.length ? <EmptyModule title="No plans are scheduled in this factory scope.">Create a draft only after factories, lines, shifts, approved targets, SAMs and readiness inputs are set up.</EmptyModule> :
      <div className="space-y-4">{Object.entries(groups).map(([line, rows]) => <section className="pw-panel overflow-hidden" key={line}><div className="flex justify-between gap-3 border-b p-4" style={{ borderColor: "var(--pw-border-light)" }}><div><div className="font-bold" style={{ color: "var(--pw-navy)" }}>{line}</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>{rows.length} planned commitment{rows.length === 1 ? "" : "s"} · inspect feasibility before approval.</div></div><span className="pw-chip">{rows.filter((row) => row.status === "approved" || row.status === "frozen").length} released</span></div><div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((plan) => <button type="button" onClick={() => onNavigate("plan")} className="rounded-lg border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm" style={{ borderColor: "var(--pw-border)" }} key={plan.id}><div className="flex justify-between gap-2"><div className="min-w-0 truncate text-sm font-bold" style={{ color: "var(--pw-navy)" }}>{plan.style_number || plan.external_ref || "Work item"}</div><span className="pw-chip">{plan.status}</span></div><div className="mt-3 flex justify-between text-xs" style={{ color: "var(--pw-text-muted)" }}><span>{plan.planned_start} → {plan.planned_end}</span><span>{number(plan.planned_qty)} u</span></div><div className="mt-3"><div className="pw-progress"><span style={{ width: plan.load_pct == null ? "0%" : `${Math.min(100, Number(plan.load_pct))}%` }} /></div><div className="mt-1 text-[11px]" style={{ color: "var(--pw-text-muted)" }}>{plan.load_pct == null ? "Load unavailable — required / available minutes incomplete." : `${percent(plan.load_pct)} approved load`}</div></div></button>)}</div></section>)}</div>}
  </div>;
}

const WORK_ORDERS_PAGE_SIZE = 200;

function WorkOrders({ scope, onNavigate, onScopeChange }) {
  const [orders, setOrders] = useState([]); const [items, setItems] = useState([]); const [query, setQuery] = useState(scope.search || ""); const [loading, setLoading] = useState(true); const [error, setError] = useState(null); const [visibleCount, setVisibleCount] = useState(WORK_ORDERS_PAGE_SIZE);
  const plannedOnly = scope.intake_scope === "planned";
  useEffect(() => { let alive = true; setLoading(true); setError(null); setVisibleCount(WORK_ORDERS_PAGE_SIZE); const params = productionScopeParams(scope); Promise.all([api.get("/production-workspace/tracker-references", { params, forceFresh: true }), api.get("/production-workspace/work-items", { params, forceFresh: true })]).then(([tracker, work]) => { if (alive) { setOrders(tracker.data?.orders || []); setItems(work.data?.work_items || []); } }).catch((err) => alive && setError(err?.response?.data?.detail || "Work Order evidence is unavailable for this scope.")).finally(() => alive && setLoading(false)); return () => { alive = false; }; }, [scope]);
  useEffect(() => { setQuery(scope.search || ""); }, [scope.search]);
  const rows = orders;
  const unplannedCount = rows.filter((row) => !row.plan_version_id).length;
  const planned = new Set(items.map((item) => item.production_order_ref || item.external_ref));
  // Every authorized order must stay reachable — this only limits how many
  // rows render at once for DOM performance, never the underlying dataset.
  const visibleRows = rows.slice(0, visibleCount);
  const remaining = rows.length - visibleRows.length;
  return <div className="pw-page space-y-5" data-testid="pw-work-orders"><PageIntro eyebrow="Order to delivery queue" title="Work orders" subtitle="Every authorized tracker order stays in this intake queue, planned or not. A filter narrows what already has a plan — it never hides an order that simply hasn't been scheduled yet." action={<button className="pw-action" onClick={() => onNavigate("plan")}><Plus size={16} />Link tracker order</button>} />
    <div className="pw-panel flex flex-wrap items-center gap-3 p-3"><label className="sr-only" htmlFor="pw-work-order-search">Search work orders</label><input id="pw-work-order-search" className="min-w-[240px] flex-1 rounded-md border bg-white px-3 py-2 text-sm outline-none" style={{ borderColor: "var(--pw-border)" }} placeholder="Search order reference, style number or style…" value={query} onChange={(event) => { const value = event.target.value; setQuery(value); onScopeChange?.("search", value); }} />
      <label className="flex shrink-0 items-center gap-2 text-xs font-bold" style={{ color: "var(--pw-navy)" }} data-testid="pw-work-orders-planned-only"><input type="checkbox" checked={plannedOnly} onChange={(event) => onScopeChange?.("intakeScope", event.target.checked ? "planned" : "")} />Planned only</label>
    </div>
    {!loading && !error && !plannedOnly && unplannedCount > 0 && <div className="pw-panel p-3 text-xs" style={{ color: "var(--pw-text-muted)" }} data-testid="pw-work-orders-unplanned-note"><WarningCircle className="inline mr-1" size={13} />{unplannedCount} order{unplannedCount === 1 ? "" : "s"} in this scope has no plan yet — shown here so it stays actionable for planning. Check "Planned only" to hide it.</div>}
    {loading ? <div className="pw-panel p-8 text-center text-sm" style={{ color: "var(--pw-text-muted)" }}>Loading tracker order references…</div> : error ? <EmptyModule title="Work Order evidence is unavailable for this scope.">{error} No order or delivery-risk conclusion is inferred.</EmptyModule> : !rows.length ? <EmptyModule title="No tracker orders match this governed scope.">A missing row is not assumed closed or delivered. Refresh the Odoo-backed Production Pipeline for live stage movement.</EmptyModule> : <><div className="pw-table-wrap"><table className="pw-table"><thead><tr><th>Order / style</th><th>Quantity</th><th>Workspace stage</th><th>Delivery risk</th><th>Planning state</th><th /></tr></thead><tbody>{visibleRows.map((row) => { const isPlanned = Boolean(row.plan_version_id); return <tr key={row.order_ref}><td><div className="font-bold">{row.order_ref}</div><div style={{ color: "var(--pw-text-muted)" }}>{row.style_number || row.style_name || "Style unavailable"}</div></td><td>{number(row.order_qty)}</td><td>{text(row.workspace_stage || "unavailable")}</td><td>{!isPlanned ? "Unavailable — not yet planned" : row.delivery_risk ? <span className="pw-chip pw-chip--warning">{text(row.delivery_risk)}</span> : "Evidence unavailable"}</td><td><span className={`pw-chip ${planned.has(row.order_ref) ? "pw-chip--ok" : ""}`}>{planned.has(row.order_ref) ? "Linked to workspace" : "Not planned"}</span></td><td><button className="font-bold text-xs" style={{ color: "var(--pw-navy)" }} onClick={() => onNavigate("plan")}>{isPlanned ? "Open plan" : "Plan this order"} <ArrowSquareOut className="inline" size={12} /></button></td></tr>; })}</tbody></table></div>
    {remaining > 0 && <div className="flex justify-center"><button type="button" className="pw-action pw-action--quiet" data-testid="pw-work-orders-load-more" onClick={() => setVisibleCount((count) => count + WORK_ORDERS_PAGE_SIZE)}>Show {Math.min(remaining, WORK_ORDERS_PAGE_SIZE)} more order{Math.min(remaining, WORK_ORDERS_PAGE_SIZE) === 1 ? "" : "s"} ({remaining} not yet shown)</button></div>}</>}
  </div>;
}

function QualityRework({ scope, onNavigate }) {
  const [events, setEvents] = useState(null); const [error, setError] = useState(null); const [loading, setLoading] = useState(true);
  useEffect(() => { let alive = true; setLoading(true); setError(null); api.get("/production-workspace/execution/events", { params: productionScopeParams(scope), forceFresh: true }).then((res) => alive && setEvents(res.data?.events || [])).catch((err) => { if (alive) { setEvents(null); setError(err?.response?.data?.detail || "Quality capture sources could not be loaded."); } }).finally(() => alive && setLoading(false)); return () => { alive = false; }; }, [scope]);
  const defects = (events || []).filter((item) => item.event_type === "qc_defect"); const open = defects.filter((item) => !["resolved", "closed", "excused"].includes(item.status)); const hasCapture = defects.length > 0; const pareto = Object.entries(defects.reduce((acc, item) => { const key = item.defect_code_name || item.defect_code || item.cause || item.reason || "Unclassified"; acc[key] = (acc[key] || 0) + Number(item.quantity || 0); return acc; }, {})).sort((a, b) => b[1] - a[1]);
  const unavailable = "Unavailable";
  return <div className="pw-page space-y-5" data-testid="pw-quality-rework"><PageIntro eyebrow="Contain, correct, close" title="Quality & rework" subtitle="Defect and rework evidence stays tied to an approved assignment. Quality rate metrics stay unavailable until the backend supplies a verified inspection denominator." action={<button className="pw-action" onClick={() => onNavigate("execution")}><Plus size={16} />Capture quality event</button>} />
    {loading ? <div className="pw-panel p-8 text-center text-sm" style={{ color: "var(--pw-text-muted)" }}>Loading authorized quality context…</div> : error ? <EmptyModule title="Quality capture is unavailable for this scope.">{error} No quality outcome is inferred.</EmptyModule> : <><div className="grid gap-3 sm:grid-cols-3"><div className="pw-panel p-4"><div className="pw-metric-label">DHU</div><div className="pw-metric-value mt-2">{unavailable}</div><div className="pw-metric-note mt-2">The current event ledger does not certify complete quality-capture coverage.</div></div><div className="pw-panel p-4"><div className="pw-metric-label">First-pass yield</div><div className="pw-metric-value mt-2">{unavailable}</div><div className="pw-metric-note mt-2">Requires a verified inspection denominator, not an absent defect row.</div></div><div className="pw-panel p-4"><div className="pw-metric-label">Open rework / containment</div><div className="pw-metric-value mt-2">{hasCapture ? open.length : unavailable}</div><div className="pw-metric-note mt-2">{hasCapture ? "Unresolved captured quality events in scope" : "No quality-capture event is recorded in this scope."}</div></div></div>
      <div className="pw-module-grid"><section className="pw-panel col-span-12 lg:col-span-5 p-4"><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Defect Pareto</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Captured causes only; it is not a complete factory-quality statement.</div>{!pareto.length ? <div className="pw-empty-module"><strong>No quality-capture event is recorded in this scope.</strong>That is not interpreted as zero defects or a complete inspection.</div> : <div className="mt-4 space-y-3">{pareto.map(([label, value]) => <div key={label}><div className="flex justify-between gap-3 text-xs"><span className="truncate font-bold">{label}</span><span>{number(value)}</span></div><div className="pw-progress mt-1"><span style={{ width: `${Math.max(4, value / pareto[0][1] * 100)}%` }} /></div></div>)}</div>}</section>
      <section className="pw-panel col-span-12 lg:col-span-7"><div className="border-b p-4" style={{ borderColor: "var(--pw-border-light)" }}><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Containment & corrective actions</div><div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Owner, action, evidence and close-out remain in the audited execution timeline.</div></div>{!hasCapture ? <div className="pw-empty-module"><strong>No quality-capture event is recorded.</strong>This is not interpreted as zero defects or completed inspection.</div> : !open.length ? <div className="pw-empty-module"><strong>No captured quality event remains open.</strong>Inspection completeness is still not confirmed by this event ledger.</div> : <div className="pw-table-wrap m-4"><table className="pw-table"><thead><tr><th>Issue</th><th>Operation / line</th><th>Containment</th><th>Status</th></tr></thead><tbody>{open.map((item) => <tr key={item.id}><td><div className="font-bold">{item.defect_code_name || item.defect_code || item.reason}</div><div style={{ color: "var(--pw-text-muted)" }}>{item.defect_code ? `${item.defect_code} · ${item.reason}` : (item.cause || "Historical event without a controlled defect code")}</div></td><td>{item.operation_name || "Operation unavailable"}<div style={{ color: "var(--pw-text-muted)" }}>{item.line_name || "Line unavailable"}</div></td><td>{item.action || "Containment action not recorded"}</td><td><span className="pw-chip pw-chip--warning">{item.status}</span></td></tr>)}</tbody></table></div>}</section></div></>}
  </div>;
}

function Machines({ catalogues, onNavigate }) {
  const machines = catalogues?.machines || []; const capabilities = catalogues?.capabilities || [];
  return <div className="pw-page space-y-5" data-testid="pw-machines"><PageIntro eyebrow="Capability & reliability" title="Machines" subtitle="This register reflects maintained production master data. Availability, maintenance and breakdown metrics stay unavailable until they are captured with verified evidence." action={<button className="pw-action" onClick={() => onNavigate("settings")}><Wrench size={16} />Maintain register</button>} />
    {!machines.length ? <EmptyModule title="No machines are registered for the selected factory.">Start in Setup & Settings with the machine register and capabilities template. Do not infer availability from missing records.</EmptyModule> : <div className="pw-table-wrap"><table className="pw-table"><thead><tr><th>Machine</th><th>Factory / line</th><th>Capabilities</th><th>Availability</th><th>Maintenance</th></tr></thead><tbody>{machines.map((machine) => { const caps = capabilities.filter((cap) => String(cap.machine_id) === String(machine.id)); return <tr key={machine.id}><td><div className="font-bold">{machine.name}</div><div style={{ color: "var(--pw-text-muted)" }}>{machine.code}</div></td><td>{machine.factory_name || `Factory #${machine.factory_id}`}<div style={{ color: "var(--pw-text-muted)" }}>{machine.line_name || "Line unassigned"}</div></td><td>{caps.length ? caps.map((cap) => <span className="pw-chip mr-1" key={cap.id}>{cap.name || cap.capability_key}</span>) : "No capability recorded"}</td><td>Unavailable — no verified status feed</td><td>Unavailable — no maintenance schedule captured</td></tr>; })}</tbody></table></div>}
  </div>;
}

function OperatorProductivity({ scope }) {
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true);
  useEffect(() => { let alive = true; api.get("/production-workspace/productivity", { params: { ...productionScopeParams(scope), view: "line" }, forceFresh: true }).then((res) => alive && setData(res.data)).catch(() => alive && setData(null)).finally(() => alive && setLoading(false)); return () => { alive = false; }; }, [scope]);
  const rows = data?.rows || [];
  return <div className="pw-page space-y-5" data-testid="pw-productivity"><PageIntro eyebrow="Private coaching context" title="Operator productivity" subtitle="This is an assignment-scoped coaching view, never a default public ranking. Individual measures remain role-redacted by the server and stay unavailable where SAM, attendance or quality denominators are incomplete." />
    {loading ? <div className="pw-panel p-8 text-center text-sm" style={{ color: "var(--pw-text-muted)" }}>Loading authorized productivity context…</div> : !rows.length ? <EmptyModule title="No complete productivity context matches this scope.">Approved SAM, attendance, approved assignments and good output are all required before productivity is calculated.</EmptyModule> : <div className="pw-table-wrap"><table className="pw-table"><thead><tr><th>Authorized context</th><th>Plan / actual</th><th>Earned / attendance</th><th>Efficiency</th><th>Quality context</th><th>Coaching need</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.assignment_id || row.line_id || index}`}><td><div className="font-bold">{row.line_name || row.factory_name || "Authorized assignment"}</div><div style={{ color: "var(--pw-text-muted)" }}>{row.plan_count || 0} approved assignments</div></td><td>{number(row.target_qty)} / {number(row.actual_qty)}</td><td>{number(row.earned_minutes)} / {number(row.attended_minutes)} min</td><td>{percent(row.efficiency_pct)}</td><td>{number(row.good_qty)} good · {number(row.reject_qty)} reject · {number(row.rework_qty)} rework</td><td>{row.metric_unavailable_reason || "Use supervisor context to coach and unblock."}</td></tr>)}</tbody></table></div>}
    <ProductionTrackerTrendChart variant="process_productivity" />
    <ProductionTrackerTrendChart variant="quality_defects" />
  </div>;
}

const CADENCE_LABELS = { shift_huddle: "Shift huddle", l10: "Weekly L10" };
const CADENCE_CADENCE_NOTE = { shift_huddle: "daily, per shift or factory-wide", l10: "weekly, factory-wide" };
const ROCK_STATUS = ["on_track", "at_risk", "off_track", "done"];
const ACTION_STATUS = ["open", "in_progress", "blocked", "resolved", "closed"];

function ListField({ label, items, onChange, fields, addLabel = "Add row" }) {
  const rows = items || [];
  const update = (idx, key, value) => { const next = rows.slice(); next[idx] = { ...next[idx], [key]: value }; onChange(next); };
  const add = () => onChange([...rows, {}]);
  const remove = (idx) => onChange(rows.filter((_, i) => i !== idx));
  return <div>
    <div className="flex items-center justify-between"><strong className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--pw-text-muted)" }}>{label}</strong><button type="button" className="text-xs font-bold" style={{ color: "var(--pw-navy)" }} onClick={add}><Plus className="inline" size={12} /> {addLabel}</button></div>
    {!rows.length ? <div className="mt-2 text-xs" style={{ color: "var(--pw-text-muted)" }}>None recorded yet.</div> : <div className="mt-2 space-y-2">{rows.map((item, idx) => <div className="flex flex-wrap items-center gap-2" key={idx}>
      {fields.map((f) => f.type === "select"
        ? <select key={f.key} className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: "var(--pw-border)" }} value={item[f.key] || ""} onChange={(event) => update(idx, f.key, event.target.value)}><option value="">{f.label}</option>{f.options.map((option) => <option key={option} value={option}>{text(option)}</option>)}</select>
        : <input key={f.key} className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: "var(--pw-border)", minWidth: f.wide ? 180 : 100 }} placeholder={f.label} value={item[f.key] || ""} onChange={(event) => update(idx, f.key, event.target.value)} />)}
      <button type="button" className="text-xs font-bold" style={{ color: "#a8321d" }} onClick={() => remove(idx)}>Remove</button>
    </div>)}</div>}
  </div>;
}

function CadenceSectionEditor({ title, items, fields, onSave, addLabel }) {
  const [draft, setDraft] = useState(items || []);
  const [reason, setReason] = useState("");
  useEffect(() => { setDraft(items || []); }, [items]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(items || []);
  return <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); if (!reason.trim()) return; onSave(draft, reason); setReason(""); }}>
    <ListField label={title} items={draft} onChange={setDraft} fields={fields} addLabel={addLabel} />
    {dirty && <div className="flex flex-wrap items-center gap-2"><input required placeholder="Audit reason" className="min-w-[160px] flex-1 rounded-md border px-2 py-1 text-xs" style={{ borderColor: "var(--pw-border)" }} value={reason} onChange={(event) => setReason(event.target.value)} /><button className="pw-action pw-action--quiet" type="submit">Save {title.toLowerCase()}</button></div>}
  </form>;
}

function scorecardToRows(scorecard) {
  if (Array.isArray(scorecard)) return scorecard;
  if (scorecard && typeof scorecard === "object") {
    return Object.entries(scorecard).map(([name, value]) => (
      value && typeof value === "object" ? { name, ...value } : { name, actual: value }
    ));
  }
  return [];
}

function CadenceCard({ cadence, mode, canManage, onSaveFields, onAddAction, onSaveAttendance }) {
  const openActions = (cadence.actions || []).filter((action) => !["resolved", "closed"].includes(action.status));
  const priorityFields = [{ key: "title", label: "Rock / priority", wide: true }, { key: "owner", label: "Owner" }, { key: "status", label: "Status", type: "select", options: ROCK_STATUS }];
  const scorecardFields = [{ key: "name", label: "Measurable", wide: true }, { key: "target", label: "Goal" }, { key: "actual", label: "Actual" }];
  const idsFields = [{ key: "issue", label: "Issue", wide: true }, { key: "owner", label: "Owner" }, { key: "status", label: "Status", type: "select", options: ["identified", "discussing", "solved"] }];
  const priorOpen = cadence.prior_open_actions || [];
  return <section className="pw-panel p-5" data-testid={`pw-cadence-card-${cadence.id}`}>
    <div className="flex flex-wrap justify-between gap-3">
      <div><div className="font-bold" style={{ color: "var(--pw-navy)" }}>{cadence.factory_name || "Factory"} · {cadence.meeting_date} · {CADENCE_LABELS[mode]}</div><div className="mt-1 text-sm" style={{ color: "var(--pw-text-muted)" }}>{cadence.headline || "No headline recorded."}</div></div>
      <span className="pw-chip">{text(cadence.status)}</span>
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-3">
      <div><div className="pw-metric-label">Priorities / Rocks</div><div className="mt-1 text-sm">{cadence.priorities?.length ? cadence.priorities.length : "Unavailable"}</div></div>
      <div><div className="pw-metric-label">IDS items</div><div className="mt-1 text-sm">{cadence.ids_items?.length ? cadence.ids_items.length : "Unavailable"}</div></div>
      <div><div className="pw-metric-label">Open actions</div><div className="mt-1 text-sm">{openActions.length}</div></div>
    </div>
    {mode === "l10" && <div className="mt-4 grid gap-4 lg:grid-cols-3">
      {canManage
        ? <CadenceSectionEditor title="Rocks / priorities" items={cadence.priorities} fields={priorityFields} addLabel="Add rock" onSave={(rows, reason) => onSaveFields({ priorities: rows }, reason)} />
        : <div><strong className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--pw-text-muted)" }}>Rocks / priorities</strong>{!cadence.priorities?.length ? <div className="mt-2 text-xs" style={{ color: "var(--pw-text-muted)" }}>None recorded.</div> : <ul className="mt-2 space-y-1 text-sm">{cadence.priorities.map((item, idx) => <li key={idx}>{item.title || "Untitled"} · {text(item.status || "open")}</li>)}</ul>}</div>}
      {canManage
        ? <CadenceSectionEditor title="Scorecard" items={scorecardToRows(cadence.scorecard)} fields={scorecardFields} addLabel="Add measurable" onSave={(rows, reason) => onSaveFields({ scorecard: rows }, reason)} />
        : <div><strong className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--pw-text-muted)" }}>Scorecard</strong>{!scorecardToRows(cadence.scorecard).length ? <div className="mt-2 text-xs" style={{ color: "var(--pw-text-muted)" }}>None recorded.</div> : <ul className="mt-2 space-y-1 text-sm">{scorecardToRows(cadence.scorecard).map((item, idx) => <li key={idx}>{item.name || "Measurable"}: {item.actual ?? "Unavailable"} (goal {item.target ?? "unavailable"})</li>)}</ul>}</div>}
      {canManage
        ? <CadenceSectionEditor title="IDS list" items={cadence.ids_items} fields={idsFields} addLabel="Add issue" onSave={(rows, reason) => onSaveFields({ ids_items: rows }, reason)} />
        : <div><strong className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--pw-text-muted)" }}>IDS list</strong>{!cadence.ids_items?.length ? <div className="mt-2 text-xs" style={{ color: "var(--pw-text-muted)" }}>None recorded.</div> : <ul className="mt-2 space-y-1 text-sm">{cadence.ids_items.map((item, idx) => <li key={idx}>{item.issue || "Untitled"} · {text(item.status || "identified")}</li>)}</ul>}</div>}
    </div>}
    {mode === "l10" && <div className="mt-4" data-testid="pw-cadence-prior-actions">
      <strong className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--pw-text-muted)" }}>Review of previous actions</strong>
      {!priorOpen.length ? <div className="mt-2 text-xs" style={{ color: "var(--pw-text-muted)" }}>No still-open action from an earlier L10 is outstanding.</div> : <ul className="mt-2 space-y-2 text-sm">{priorOpen.map((action) => <li key={action.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2" style={{ borderColor: "var(--pw-border)" }}><span>{action.title} · {text(action.status)} · owner {action.owner_name || "not recorded"} · from {action.source_meeting_date}</span>{canManage && <button type="button" className="pw-chip" onClick={() => { const reason = window.prompt("Audit reason for carrying this action forward"); if (!reason) return; const event = { preventDefault: () => {}, currentTarget: null }; onAddAction(event, action.id, { title: action.title, owner_name: action.owner_name, due_date: action.due_date, reason }); }}>Carry forward</button>}</li>)}</ul>}
    </div>}
    {canManage && <details className="mt-4 text-sm"><summary className="cursor-pointer font-bold">Maintain attendance and owned actions</summary><div className="mt-3 grid gap-3 lg:grid-cols-2">
      <form onSubmit={(event) => onSaveAttendance(event)} className="grid gap-2"><strong>Attendance</strong><input required name="member_user_id" placeholder="Staff user ID" /><input required name="display_name" placeholder="Display name" /><select name="attendance_state"><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option><option value="excused">Excused</option></select><input required name="reason" placeholder="Audit reason" /><button className="pw-action pw-action--quiet">Save attendance</button></form>
      <form onSubmit={(event) => onAddAction(event)} className="grid gap-2"><strong>Owned action</strong><input required name="title" placeholder="Action" /><input name="owner_name" placeholder="Owner" /><input name="due_date" type="date" /><input required name="reason" placeholder="Audit reason" /><button className="pw-action pw-action--quiet">Add action</button></form>
    </div></details>}
    {openActions.length > 0 && <div className="mt-4 text-sm"><strong>Open actions</strong><ul className="mt-2 space-y-1">{openActions.slice(0, 8).map((action) => <li key={action.id}>{action.title} · {text(action.status)} · due {action.due_date || "not recorded"}{action.carried_forward_from ? " · carried forward" : ""}</li>)}</ul></div>}
  </section>;
}

function Huddle({ scope, onNavigate, catalogues, user }) {
  const [mode, setMode] = useState("shift_huddle");
  const [data, setData] = useState(null); const [error, setError] = useState(null); const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const buildDraft = useCallback(() => ({
    factory_id: scope.factory_id || "", shift_id: mode === "l10" ? "" : (scope.shift_id || ""),
    meeting_date: scope.date_to, headline: "", reason: "",
  }), [scope, mode]);
  const [draft, setDraft] = useState(buildDraft);
  useEffect(() => { setDraft(buildDraft()); }, [buildDraft]);
  const canManage = ["admin", "production", "leadership", "smt"].includes(String(user?.role || "").toLowerCase());
  useEffect(() => {
    let alive = true; setLoading(true); setError(null);
    const params = { date_from: scope.date_from, date_to: scope.date_to, factory_id: scope.factory_id, cadence_type: mode };
    if (mode === "shift_huddle") params.shift_id = scope.shift_id;
    api.get("/production-workspace/cadences", { params, forceFresh: true })
      .then((res) => alive && setData(res.data))
      .catch((err) => alive && setError(err?.response?.data?.detail || "Cadence records are unavailable."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [scope, mode, refresh]);
  const createCadence = async (event) => {
    event.preventDefault();
    try {
      await api.post("/production-workspace/cadences", { ...draft, cadence_type: mode, shift_id: mode === "l10" ? null : (draft.shift_id || null) });
      setDraft(buildDraft()); setRefresh((value) => value + 1);
    } catch (err) { setError(err?.response?.data?.detail || `Could not record the ${CADENCE_LABELS[mode].toLowerCase()}.`); }
  };
  const saveFields = async (cadence, patch, reason) => {
    try { await api.patch(`/production-workspace/cadences/${cadence.id}`, { expected_version: cadence.version_token, reason, ...patch }); setRefresh((value) => value + 1); }
    catch (err) { setError(err?.response?.data?.detail || "Could not save the cadence."); }
  };
  const addAction = async (event, cadence, carryForwardFromId, override) => {
    event.preventDefault?.();
    const form = event.currentTarget ? new FormData(event.currentTarget) : null;
    const payload = override
      ? { title: override.title, due_date: override.due_date || null, owner_name: override.owner_name || null, reason: override.reason, carry_forward_from: carryForwardFromId }
      : { title: form.get("title"), due_date: form.get("due_date") || null, owner_name: form.get("owner_name") || null, reason: form.get("reason") };
    try {
      await api.post(`/production-workspace/cadences/${cadence.id}/actions`, payload);
      event.currentTarget?.reset?.(); setRefresh((value) => value + 1);
    } catch (err) { setError(err?.response?.data?.detail || "Could not save the owned action."); }
  };
  const saveAttendance = async (event, cadence) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      await api.post(`/production-workspace/cadences/${cadence.id}/attendance`, { member_user_id: form.get("member_user_id"), display_name: form.get("display_name"), attendance_state: form.get("attendance_state"), expected_version: 0, reason: form.get("reason") });
      event.currentTarget.reset(); setRefresh((value) => value + 1);
    } catch (err) { setError(err?.response?.data?.detail || "Could not save attendance."); }
  };
  const cadences = data?.cadences || [];
  return <div className="pw-page space-y-5" data-testid="pw-huddle">
    <PageIntro eyebrow="Daily & weekly cadence" title="Shift huddle & weekly L10" subtitle="Two distinct governed meetings — the daily shift huddle and the factory-wide weekly L10 — each with its own scorecard, priorities/rocks, IDS list, owned actions, attendance, history and audit trail." action={<button className="pw-action pw-action--quiet" onClick={() => onNavigate("recovery")}><Flag size={15} />Review recovery actions</button>} />
    <div className="pw-panel flex flex-wrap gap-1 p-1" role="tablist" aria-label="Cadence type" data-testid="pw-cadence-mode-tabs">
      {Object.entries(CADENCE_LABELS).map(([key, label]) => <button type="button" role="tab" aria-selected={mode === key} key={key} data-testid={`pw-cadence-mode-${key}`} className="flex-1 rounded-md px-3 py-2 text-sm font-bold transition" style={mode === key ? { background: "var(--pw-navy)", color: "#fff" } : { color: "var(--pw-navy)" }} onClick={() => setMode(key)}>{label} <span className="font-normal" style={{ opacity: 0.75 }}>· {CADENCE_CADENCE_NOTE[key]}</span></button>)}
    </div>
    {canManage && <form onSubmit={createCadence} className="pw-panel grid gap-2 p-4 md:grid-cols-3" data-testid={`pw-cadence-create-${mode}`}>
      <strong className="md:col-span-3">Record a governed {CADENCE_LABELS[mode].toLowerCase()}</strong>
      <select required value={draft.factory_id} onChange={(event) => setDraft({ ...draft, factory_id: event.target.value })}><option value="">Select factory</option>{(catalogues?.factories || []).filter((item) => item.active !== false).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select>
      {mode === "shift_huddle"
        ? <select value={draft.shift_id} onChange={(event) => setDraft({ ...draft, shift_id: event.target.value })}><option value="">Factory-wide</option>{(catalogues?.shifts || []).filter((item) => !draft.factory_id || String(item.factory_id) === String(draft.factory_id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        : <div className="flex items-center rounded-md border px-3 py-2 text-xs" style={{ borderColor: "var(--pw-border)", color: "var(--pw-text-muted)" }}>Factory-wide — a weekly L10 is never scoped to a single shift</div>}
      <input required type="date" value={draft.meeting_date} onChange={(event) => setDraft({ ...draft, meeting_date: event.target.value })} />
      <input className="md:col-span-2" placeholder="Headline (optional)" value={draft.headline} onChange={(event) => setDraft({ ...draft, headline: event.target.value })} />
      <input required placeholder="Audit reason" value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} />
      <button className="pw-action" type="submit">Record {mode === "l10" ? "L10" : "huddle"}</button>
    </form>}
    {loading ? <div className="pw-panel p-8 text-center text-sm">Loading authorized cadence records…</div> : error ? <EmptyModule title="Cadence records are unavailable.">{error}</EmptyModule> : !cadences.length ? <EmptyModule title={`No ${CADENCE_LABELS[mode].toLowerCase()} is recorded for this scope.`}>No meeting, attendance or action is inferred.</EmptyModule> : <div className="space-y-4">{cadences.map((cadence) => <CadenceCard key={cadence.id} cadence={cadence} mode={mode} canManage={canManage}
      onSaveFields={(patch, reason) => saveFields(cadence, patch, reason)}
      onAddAction={(event, carryForwardFromId, override) => addAction(event, cadence, carryForwardFromId, override)}
      onSaveAttendance={(event) => saveAttendance(event, cadence)} />)}</div>}
  </div>;
}

function Team({ scope, catalogues, user }) {
  const [members, setMembers] = useState(null); const [refresh, setRefresh] = useState(0); const [error, setError] = useState(null); const [draft, setDraft] = useState({ display_name: "", role_key: "", responsibility: "", factory_id: scope.factory_id || "", line_id: scope.line_id || "", escalation_path: "", reason: "" });
  const canManage = ["admin", "production"].includes(String(user?.role || "").toLowerCase());
  useEffect(() => { let alive = true; api.get("/production-workspace/team", { params: { factory_id: scope.factory_id, line_id: scope.line_id }, forceFresh: true }).then((res) => alive && setMembers(res.data?.members || [])).catch((err) => alive && setError(err?.response?.data?.detail || "Team records are unavailable.")).finally(() => {}); return () => { alive = false; }; }, [scope, refresh]);
  const create = async (event) => { event.preventDefault(); try { await api.post("/production-workspace/team", { ...draft, line_id: draft.line_id || null }); setDraft({ display_name: "", role_key: "", responsibility: "", factory_id: scope.factory_id || "", line_id: scope.line_id || "", escalation_path: "", reason: "" }); setRefresh((value) => value + 1); } catch (err) { setError(err?.response?.data?.detail || "Could not create team assignment."); } };
  const deactivate = async (member) => { const reason = window.prompt("Audit reason for this status change"); if (!reason) return; try { await api.patch(`/production-workspace/team/${member.id}`, { expected_version: member.version_token, active: !member.active, reason }); setRefresh((value) => value + 1); } catch (err) { setError(err?.response?.data?.detail || "Could not update team assignment."); } };
  return <div className="pw-page space-y-5" data-testid="pw-team"><PageIntro eyebrow="Responsibilities & escalation" title="Team" subtitle="Role-safe team responsibility and escalation records. Individual operator identities are redacted for Quality and Product Development roles." />
    {canManage && <form onSubmit={create} className="pw-panel grid gap-2 p-4 md:grid-cols-3"><strong className="md:col-span-3">Add a governed team assignment</strong><input required placeholder="Display name" value={draft.display_name} onChange={(event) => setDraft({ ...draft, display_name: event.target.value })} /><input required placeholder="Role (e.g. production_lead)" value={draft.role_key} onChange={(event) => setDraft({ ...draft, role_key: event.target.value })} /><select required value={draft.factory_id} onChange={(event) => setDraft({ ...draft, factory_id: event.target.value, line_id: "" })}><option value="">Select factory</option>{(catalogues?.factories || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input placeholder="Responsibility" value={draft.responsibility} onChange={(event) => setDraft({ ...draft, responsibility: event.target.value })} /><select value={draft.line_id} onChange={(event) => setDraft({ ...draft, line_id: event.target.value })}><option value="">All lines</option>{(catalogues?.lines || []).filter((item) => String(item.factory_id) === String(draft.factory_id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input placeholder="Escalation path" value={draft.escalation_path} onChange={(event) => setDraft({ ...draft, escalation_path: event.target.value })} /><input required placeholder="Audit reason" value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /><button className="pw-action" type="submit">Save assignment</button></form>}
    {error ? <EmptyModule title="Team records are unavailable.">{error}</EmptyModule> : members === null ? <div className="pw-panel p-8 text-center text-sm">Loading authorized team records…</div> : !members.length ? <EmptyModule title="No governed team assignments match this scope.">No escalation path is inferred.</EmptyModule> : <div className="pw-table-wrap"><table className="pw-table"><thead><tr><th>Responsibility</th><th>Member</th><th>Scope</th><th>Escalation</th><th>Status</th></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td><strong>{text(member.role_key)}</strong><div>{member.responsibility || "Responsibility not recorded"}</div></td><td>{member.display_name || "Identity redacted"}</td><td>{member.factory_name || "All factories"} · {member.line_name || "All lines"}</td><td>{member.escalation_path || "Not recorded"}</td><td>{canManage ? <button className="pw-chip" onClick={() => deactivate(member)}>{member.active ? "Active · deactivate" : "Inactive · activate"}</button> : (member.active ? "Active" : "Inactive")}</td></tr>)}</tbody></table></div>}
  </div>;
}

function Resources({ scope, catalogues, user }) {
  const [resources, setResources] = useState(null); const [refresh, setRefresh] = useState(0); const [error, setError] = useState(null); const [draft, setDraft] = useState({ resource_key: "", title: "", resource_type: "", factory_id: scope.factory_id || "", source_ref: "", description: "", review_date: "", reason: "" });
  const canManage = ["admin", "production"].includes(String(user?.role || "").toLowerCase());
  useEffect(() => { let alive = true; api.get("/production-workspace/resources", { params: { factory_id: scope.factory_id }, forceFresh: true }).then((res) => alive && setResources(res.data?.resources || [])).catch((err) => alive && setError(err?.response?.data?.detail || "Resource register is unavailable.")); return () => { alive = false; }; }, [scope, refresh]);
  const create = async (event) => { event.preventDefault(); try { await api.post("/production-workspace/resources", { ...draft, factory_id: draft.factory_id || null, review_date: draft.review_date || null }); setDraft({ resource_key: "", title: "", resource_type: "", factory_id: scope.factory_id || "", source_ref: "", description: "", review_date: "", reason: "" }); setRefresh((value) => value + 1); } catch (err) { setError(err?.response?.data?.detail || "Could not register resource."); } };
  const approve = async (resource) => { const reason = window.prompt("Audit reason for this resource status change"); if (!reason) return; try { await api.patch(`/production-workspace/resources/${resource.id}`, { expected_version: resource.version_token, status: resource.status === "approved" ? "retired" : "approved", reason }); setRefresh((value) => value + 1); } catch (err) { setError(err?.response?.data?.detail || "Could not update resource."); } };
  return <div className="pw-page space-y-5" data-testid="pw-resources"><PageIntro eyebrow="Knowledge centre" title="Resources" subtitle="Versioned, owned production references with source provenance. A resource is never represented as current without an approved controlled record." />
    {canManage && <form onSubmit={create} className="pw-panel grid gap-2 p-4 md:grid-cols-3"><strong className="md:col-span-3">Register a controlled resource</strong><input required placeholder="Stable resource key" value={draft.resource_key} onChange={(event) => setDraft({ ...draft, resource_key: event.target.value })} /><input required placeholder="Title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><input required placeholder="Type (SOP, bulletin, guide)" value={draft.resource_type} onChange={(event) => setDraft({ ...draft, resource_type: event.target.value })} /><select value={draft.factory_id} onChange={(event) => setDraft({ ...draft, factory_id: event.target.value })}><option value="">All factories</option>{(catalogues?.factories || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input placeholder="Controlled source URL" value={draft.source_ref} onChange={(event) => setDraft({ ...draft, source_ref: event.target.value })} /><input type="date" value={draft.review_date} onChange={(event) => setDraft({ ...draft, review_date: event.target.value })} /><input className="md:col-span-2" placeholder="Description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /><input required placeholder="Audit reason" value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /><button className="pw-action" type="submit">Register resource</button></form>}
    {error ? <EmptyModule title="Resource register is unavailable.">{error}</EmptyModule> : resources === null ? <div className="pw-panel p-8 text-center text-sm">Loading authorized resource register…</div> : !resources.length ? <EmptyModule title="No controlled resource matches this scope.">There is no inferred SOP or source.</EmptyModule> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{resources.map((resource) => { const sourceUrl = safeControlledUrl(resource.source_ref); return <article className="pw-panel p-4" key={resource.id}><div className="flex justify-between gap-2"><strong style={{ color: "var(--pw-navy)" }}>{resource.title}</strong><span className="pw-chip">{text(resource.status)}</span></div><div className="mt-2 text-xs" style={{ color: "var(--pw-text-muted)" }}>{text(resource.resource_type)} · {resource.factory_name || "All factories"}</div><p className="mt-3 text-sm">{resource.description || "Description not recorded."}</p><div className="mt-4 text-xs" style={{ color: "var(--pw-text-muted)" }}>Owner: {resource.owner_name || "Not recorded"} · Review: {resource.review_date || "Not recorded"}</div>{sourceUrl ? <a className="mt-3 inline-block text-xs font-bold" style={{ color: "var(--pw-navy)" }} href={sourceUrl} target="_blank" rel="noreferrer">Open controlled source <ArrowSquareOut className="inline" size={12} /></a> : resource.source_ref ? <div className="mt-3 text-xs" style={{ color: "var(--pw-text-muted)" }}>Controlled source link unavailable</div> : null}{canManage && resource.status !== "retired" && <button className="mt-3 block text-xs font-bold" style={{ color: "var(--pw-navy)" }} onClick={() => approve(resource)}>{resource.status === "approved" ? "Retire resource" : "Approve resource"}</button>}</article>; })}</div>}
  </div>;
}

function Setup({ catalogues, onNavigate, user }) {
  const setup = [["Factories & lines", "factories"], ["Shifts & calendars", "shifts"], ["Machines & capabilities", "machines"], ["Operators & skills", "operators"], ["Approved operation / SAM definitions", "operation_definitions"], ["Approved daily targets", "targets"], ["Defect codes", "defect_codes"], ["Downtime reason codes", "downtime_reasons"]];
  const complete = setup.filter(([, key]) => (catalogues?.[key] || []).length > 0).length;
  return <div className="pw-page space-y-5" data-testid="pw-settings"><PageIntro eyebrow="Guided onboarding" title="Setup & settings" subtitle="Prepare the minimum trusted master data before a plan is approved. Imports preview and validate every row first; invalid files do not partially write production master data." action={<button className="pw-action" onClick={() => onNavigate("plan", { setup: "bulk" })}><Stack size={16} />Open controlled imports</button>} />
    <section className="pw-panel p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Factory readiness checklist</div><div className="mt-1 text-sm" style={{ color: "var(--pw-text-muted)" }}>{complete} of {setup.length} master-data sets are maintained in this environment.</div></div><span className="pw-chip">{Math.round(complete / setup.length * 100)}% setup coverage</span></div><div className="pw-progress mt-4"><span style={{ width: `${complete / setup.length * 100}%` }} /></div><div className="mt-5 grid gap-2 md:grid-cols-2">{setup.map(([label, key]) => <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-3" key={key} style={{ borderColor: "var(--pw-border)" }}><div className="flex items-center gap-2 text-sm font-bold" style={{ color: "var(--pw-navy)" }}>{(catalogues?.[key] || []).length > 0 ? <CheckCircle size={17} weight="fill" color="#2f7a50" /> : <ClockCounterClockwise size={17} color="#a8791d" />}{label}</div><span className={`pw-chip ${(catalogues?.[key] || []).length > 0 ? "pw-chip--ok" : "pw-chip--warning"}`}>{(catalogues?.[key] || []).length > 0 ? "Maintained" : "Needs setup"}</span></div>)}</div></section>
    <section className="pw-panel p-5"><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Controlled CSV onboarding</div><p className="mt-1 text-sm" style={{ color: "var(--pw-text-muted)" }}>Download a template, preview every row, correct any error, then commit the full file with an audit reason. Existing plan setup provides the trusted import workflow for factory, line, shift/calendar, machine, capability, operator, skill, operation/SAM and target masters.</p><div className="mt-4 flex flex-wrap gap-2"><button className="pw-action pw-action--quiet" onClick={() => onNavigate("plan", { setup: "bulk" })}>Open bulk templates</button><button className="pw-action pw-action--quiet" onClick={() => onNavigate("plan", { setup: "master" })}>Open master data</button></div></section>
    <ProductionTrackerSheetPanel user={user} />
  </div>;
}

function WorkspaceModule({ module, scope, catalogues, onNavigate, onScopeChange, user }) {
  const shared = { scope, catalogues, onNavigate, onScopeChange, user };
  if (module === "workspace") return <ControlRoom {...shared} />;
  if (module === "plan") return <React.Suspense fallback={<div className="pw-page py-8 text-sm">Loading production plan…</div>}><PlanningWorkspace /></React.Suspense>;
  if (module === "line-board") return <LineBoard {...shared} />;
  if (module === "work-orders") return <WorkOrders {...shared} />;
  if (module === "execution") return <React.Suspense fallback={<div className="pw-page py-8 text-sm">Loading execution capture…</div>}><ExecutionCapture /></React.Suspense>;
  if (module === "quality") return <QualityRework {...shared} />;
  if (module === "machines") return <Machines {...shared} />;
  if (module === "productivity") return <OperatorProductivity {...shared} />;
  if (module === "recovery") return <React.Suspense fallback={<div className="pw-page py-8 text-sm">Loading recovery room…</div>}><ProductivityRecovery /></React.Suspense>;
  if (module === "huddle") return <Huddle {...shared} />;
  if (module === "team") return <Team {...shared} />;
  if (module === "resources") return <Resources {...shared} />;
  return <Setup {...shared} />;
}

export default function ProductionWorkspaceHub() {
  const location = useLocation(); const navigate = useNavigate(); const { user } = useAuth();
  const [root, setRoot] = useState(null); const [catalogues, setCatalogues] = useState({}); const [loading, setLoading] = useState(true);
  const segment = location.pathname.replace(/^\/production-workspace\/?/, "").split("/")[0];
  const oldTab = new URLSearchParams(location.search).get("tab");
  const module = MODULES.has(segment) ? segment : (LEGACY_TAB_MODULE[oldTab] || "workspace");
  const rawScope = useMemo(() => readProductionScope(location.search), [location.search]);
  const scope = useMemo(() => ({ ...rawScope, date_from: rawScope.date_from || rawScope.date_to || today(), date_to: rawScope.date_to || rawScope.date_from || today() }), [rawScope]);
  const refreshContext = useCallback(async () => {
    setLoading(true);
    try {
      const [rootRes, catalogueRes] = await Promise.all([api.get("/production-workspace", { forceFresh: true }), api.get("/production-workspace/catalogues", { forceFresh: true })]);
      setRoot(rootRes.data); setCatalogues(catalogueRes.data?.catalogues || {});
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { refreshContext(); }, [refreshContext]);
  useEffect(() => {
    if (oldTab !== "tracker" && oldTab !== "report") return;
    const search = new URLSearchParams(location.search); navigate({ pathname: "/production", search: `?${search.toString()}` }, { replace: true });
  }, [location.search, navigate, oldTab]);
  const go = useCallback((next, extra = {}) => {
    const search = new URLSearchParams(location.search); search.delete("tab");
    Object.entries(extra).forEach(([key, value]) => { if (value) search.set(key, String(value)); });
    const pathname = next === "workspace" ? "/production-workspace" : `/production-workspace/${next}`;
    navigate({ pathname, search: search.toString() ? `?${search}` : "" });
  }, [location.search, navigate]);
  const changeScope = useCallback((field, value) => {
    const search = new URLSearchParams(location.search);
    const fields = {
      date: ["date_from", "date_to"], factory: ["prod_factory_id"], line: ["prod_line_id"],
      shift: ["prod_shift_id"], stage: ["prod_stage"], planStatus: ["prod_plan_status"],
       owner: ["prod_owner_user_id"], search: ["prod_search"], deliveryRisk: ["prod_delivery_risk"],
       intakeScope: ["prod_intake_scope"],
    };
    (fields[field] || []).forEach((key) => value ? search.set(key, value) : search.delete(key));
    navigate({ pathname: location.pathname, search: search.toString() ? `?${search}` : "" }, { replace: true });
  }, [location.pathname, location.search, navigate]);
  const scopeControl = {
    date: { value: scope.date_to, options: [] },
    factory: { value: scope.factory_id, options: [{ id: "", label: "All factories" }, ...(catalogues.factories || []).filter((item) => item.active !== false).map((item) => ({ id: item.id, label: `${item.code} · ${item.name}` }))] },
    line: { value: scope.line_id, options: [{ id: "", label: "All lines" }, ...(catalogues.lines || []).filter((item) => item.active !== false && (!scope.factory_id || String(item.factory_id) === String(scope.factory_id))).map((item) => ({ id: item.id, label: `${item.code} · ${item.name}` }))] },
    shift: { value: scope.shift_id, options: [{ id: "", label: "All shifts" }, ...(catalogues.shifts || []).filter((item) => item.active !== false && (!scope.factory_id || String(item.factory_id) === String(scope.factory_id))).map((item) => ({ id: item.id, label: `${item.code} · ${item.name}` }))] },
    stage: { value: scope.stage, options: [{ id: "", label: "All stages" }, ...(catalogues.tracker_stages || []).map((item) => ({ id: item.stage_key, label: item.stage_name }))] },
    planStatus: { value: scope.plan_status, options: [{ id: "", label: "All plan statuses" }, ...["draft", "submitted", "approved", "frozen", "reopened"].map((value) => ({ id: value, label: text(value) }))] },
     deliveryRisk: { value: scope.delivery_risk, options: [{ id: "", label: "All delivery risks" }, ...["urgent", "watch", "planned", "data_needed"].map((value) => ({ id: value, label: text(value) }))] },
    owner: { value: scope.owner_user_id, placeholder: "Owner ID" },
    search: { value: scope.search, placeholder: "Order or style" },
  };
  if (oldTab === "tracker" || oldTab === "report") return <Navigate to={`/production?${new URLSearchParams(location.search).toString()}`} replace />;
  return <ProductionWorkspaceShell activeModule={module} onNavigate={go} scope={scopeControl} onScopeChange={changeScope} onBackToBi={() => navigate("/production")} user={user} sourceStatus={{ label: "Workspace access", state: loading ? "loading" : root?.permissions?.can_view ? "ready" : "unknown", asOf: null }}>
    <WorkspaceModule module={module} scope={scope} catalogues={catalogues} onNavigate={go} onScopeChange={changeScope} user={user} />
  </ProductionWorkspaceShell>;
}