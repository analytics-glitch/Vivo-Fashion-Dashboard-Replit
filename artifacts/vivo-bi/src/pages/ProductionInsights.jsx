import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, fmtNum } from "@/lib/api";
import { Empty, ErrorBox, Loading, SectionTitle } from "@/components/common";
import { useAuth } from "@/lib/auth";
import {
  ArrowClockwise, CaretDown, CheckCircle, Clock, Factory, NotePencil,
  TrendUp, WarningCircle,
} from "@phosphor-icons/react";

const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

const unavailable = (value, suffix = "") =>
  value === null || value === undefined ? "Unavailable" : `${Number(value).toFixed(1)}${suffix}`;
const minutes = (value) => value === null || value === undefined ? "Unavailable" : `${fmtNum(value)} min`;
const quantity = (value) => value === null || value === undefined ? "Unavailable" : fmtNum(value);
const statusTone = (status) => ({
  urgent: "bg-rose-50 text-rose-700 border-rose-200",
  watch: "bg-amber-50 text-amber-800 border-amber-200",
  planned: "bg-sky-50 text-sky-700 border-sky-200",
  resolved: "bg-emerald-50 text-emerald-700 border-emerald-200",
}[status] || "bg-slate-50 text-slate-700 border-slate-200");

function Kpi({ label, value, hint }) {
  return (
    <div className="card-white p-3 min-w-[150px]">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-xl font-bold text-foreground">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

function Completeness({ row }) {
  const items = Object.entries(row.data_completeness || {});
  if (!items.length) return <span className="text-muted">No source status</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([key, complete]) => (
        <span key={key} className={`rounded border px-1.5 py-0.5 text-[10px] ${complete ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {key.replaceAll("_", " ")}: {complete ? "present" : "missing"}
        </span>
      ))}
    </div>
  );
}

function MetricTable({ rows, view, privacy }) {
  if (!rows.length) return <Empty label="No approved-plan context matches this period and scope." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1060px] text-left text-[12px]">
        <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-2 py-2">{view === "worker" ? "Coaching context" : view === "line" ? "Line" : "Factory"}</th>
            <th className="px-2 py-2">Plan / actual</th>
            {!privacy && <th className="px-2 py-2">Earned / attended</th>}
            {!privacy && <th className="px-2 py-2">Efficiency</th>}
            <th className="px-2 py-2">Quality</th>
            <th className="px-2 py-2">Downtime</th>
            <th className="px-2 py-2">Data completeness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.plan_version_id || row.factory_name}-${row.assignment_id || row.line_name || index}`} className="border-b border-line align-top">
              <td className="px-2 py-3">
                <div className="font-semibold text-foreground">
                  {row.operator_name || row.line_name || row.factory_name || "Unassigned"}
                </div>
                {view === "worker" && <div className="mt-0.5 text-muted">{row.plan_count || 0} approved assignment{row.plan_count === 1 ? "" : "s"} in the selected period</div>}
                {view !== "worker" && <div className="mt-0.5 text-muted">{row.plan_count || 0} approved plan{row.plan_count === 1 ? "" : "s"}</div>}
                {row.metric_unavailable_reason && <div className="mt-1 text-[11px] text-amber-800">{row.metric_unavailable_reason}</div>}
              </td>
              <td className="px-2 py-3 whitespace-nowrap">
                <div>{quantity(row.target_qty)} target</div>
                <div className="font-semibold text-emerald-700">{quantity(row.actual_qty)} captured</div>
              </td>
              {!privacy && <td className="px-2 py-3 whitespace-nowrap">
                <div>{minutes(row.earned_minutes)}</div>
                <div className="text-muted">{minutes(row.attended_minutes)}</div>
              </td>}
              {!privacy && <td className="px-2 py-3">
                {row.efficiency_pct === null || row.efficiency_pct === undefined ? (
                  <span className="rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">Unavailable</span>
                ) : <span className="font-semibold text-foreground">{unavailable(row.efficiency_pct, "%")}</span>}
              </td>}
              <td className="px-2 py-3 whitespace-nowrap">
                <div className="text-emerald-700">{quantity(row.good_qty)} good</div>
                <div className="text-rose-700">{quantity(row.reject_qty)} reject · {quantity(row.rework_qty)} rework</div>
              </td>
              <td className="px-2 py-3">{minutes(row.downtime_minutes)}</td>
              <td className="px-2 py-3"><Completeness row={row} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewAction({ candidate, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [owner, setOwner] = useState(candidate.owner_user_id || "");
  const [dueDate, setDueDate] = useState(candidate.planned_end || today);
  const [title, setTitle] = useState(`Recovery follow-up · ${candidate.style_number || candidate.external_ref}`);
  const [reason, setReason] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post("/production-workspace/recovery/actions", {
        action_key: `recovery:${candidate.plan_version_id}:${Date.now()}`,
        plan_version_id: candidate.plan_version_id,
        work_item_id: candidate.work_item_id,
        title,
        owner_user_id: owner || null,
        due_date: dueDate || null,
        priority: candidate.priority_score,
        rationale: candidate.reasons,
        source_snapshot: {
          remaining_qty: candidate.remaining_qty,
          current_stage: candidate.current_stage,
          load_pct: candidate.load_pct,
          downtime_minutes: candidate.downtime_minutes,
        },
        reason,
      });
      onSaved(); onClose();
    } catch (err) {
      setError(err?.response?.data?.detail || "Could not create the follow-up.");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-end bg-black/35 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Create recovery follow-up">
      <form onSubmit={submit} className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="font-bold text-foreground">Create constructive follow-up</h3><p className="mt-1 text-xs text-muted">This is a recovery action, not a performance rating. It remains in the authorized operational context.</p></div><button type="button" onClick={onClose} className="text-sm font-semibold text-muted">Close</button></div>
        {error && <div className="mb-3"><ErrorBox message={error} /></div>}
        <label className="mb-3 block text-xs font-semibold text-foreground">Action title<input value={title} onChange={(e) => setTitle(e.target.value)} required className="mt-1 w-full rounded border border-line px-3 py-2 font-normal" /></label>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-foreground">Owner user ID<input value={owner} onChange={(e) => setOwner(e.target.value)} className="mt-1 w-full rounded border border-line px-3 py-2 font-normal" placeholder="Optional" /></label>
          <label className="block text-xs font-semibold text-foreground">Due date<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-1 w-full rounded border border-line px-3 py-2 font-normal" /></label>
        </div>
        <label className="mb-4 block text-xs font-semibold text-foreground">Why this follow-up is needed<textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength="3" className="mt-1 min-h-[80px] w-full rounded border border-line px-3 py-2 font-normal" placeholder="Describe the support or unblock needed." /></label>
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded px-3 py-2 text-sm font-semibold text-muted">Cancel</button><button disabled={busy} className="rounded bg-[#1a5c38] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Saving…" : "Create follow-up"}</button></div>
      </form>
    </div>
  );
}

function RecoveryQueue({ recovery, canWrite, onRefresh }) {
  const [selected, setSelected] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [message, setMessage] = useState(null);
  const [history, setHistory] = useState(null);
  const updateStatus = async (action, status) => {
    setUpdating(action.id); setMessage(null);
    try {
      await api.patch(`/production-workspace/recovery/actions/${action.id}`, {
        status, expected_version: action.version_token,
        reason: `Moved recovery action to ${status.replace("_", " ")}.`,
      });
      onRefresh();
    } catch (err) {
      setMessage(err?.response?.data?.detail || "That action changed elsewhere. Refresh and try again.");
    } finally { setUpdating(null); }
  };
  const loadHistory = async (action) => {
    try {
      const { data } = await api.get(`/production-workspace/recovery/actions/${action.id}/audit`, { forceFresh: true });
      setHistory({ id: action.id, title: action.title, rows: data.audit || [] });
    } catch (err) {
      setMessage(err?.response?.data?.detail || "Could not load the action history.");
    }
  };
  return (
    <div className="space-y-4">
      {message && <ErrorBox message={message} />}
      <div className="card-white p-4">
        <SectionTitle title="Delivery recovery queue" subtitle="Priority explains delivery risk from verified plan, execution, WIP/stage, capacity, quality/rework and downtime evidence. It is not a worker score." />
        {!recovery?.queue?.length ? <Empty label="No remaining approved-plan work needs a recovery signal in this period." /> : (
          <div className="space-y-3">
            {recovery.queue.map((item) => (
              <article key={item.plan_version_id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><div className="flex items-center gap-2"><span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${statusTone(item.priority_band)}`}>{item.priority_band}</span><span className="font-semibold text-foreground">{item.style_number || item.external_ref}</span></div><div className="mt-1 text-xs text-muted">{item.factory_name} · {item.line_name || "Unassigned line"} · stage: {item.current_stage || "unavailable"}</div></div>
                  <div className="text-right text-xs"><div className="font-bold text-foreground">{item.priority_score}/100 context score</div><div className="text-muted">{quantity(item.remaining_qty)} remaining · due {item.planned_end}</div></div>
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700">{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                <div className="mt-3 flex flex-wrap items-center gap-2"><Completeness row={item} />{canWrite && <button onClick={() => setSelected(item)} className="ml-auto inline-flex items-center gap-1 rounded border border-[#1a5c38] px-2.5 py-1.5 text-xs font-semibold text-[#1a5c38] hover:bg-emerald-50"><NotePencil size={14} /> Create follow-up</button>}</div>
              </article>
            ))}
          </div>
        )}
      </div>
      <div className="card-white p-4">
        <SectionTitle title="Saved follow-ups" subtitle="Changes require a reason and are retained in the production workspace audit trail." />
        {!recovery?.actions?.length ? <Empty label="No recovery follow-ups have been saved yet." /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-2 py-2">Action</th><th className="px-2 py-2">Owner / due</th><th className="px-2 py-2">Priority</th><th className="px-2 py-2">Status</th><th className="px-2 py-2" /></tr></thead><tbody>{recovery.actions.map((action) => <tr key={action.id} className="border-b border-line"><td className="px-2 py-3"><div className="font-semibold">{action.title}</div><div className="text-muted">{action.style_number || action.external_ref} · {action.line_name || action.factory_name}</div></td><td className="px-2 py-3">{action.owner_user_id || "Unassigned"}<div className="text-muted">{action.due_date || "No due date"}</div></td><td className="px-2 py-3">{action.priority}/100</td><td className="px-2 py-3"><span className={`rounded border px-2 py-1 text-[10px] font-semibold ${statusTone(action.status)}`}>{action.status.replace("_", " ")}</span></td><td className="px-2 py-3"><div className="flex gap-2">{canWrite && !["resolved", "closed"].includes(action.status) && <button disabled={updating === action.id} onClick={() => updateStatus(action, "resolved")} className="inline-flex items-center gap-1 text-xs font-semibold text-[#1a5c38] disabled:opacity-50"><CheckCircle size={15} /> Resolve</button>}<button onClick={() => loadHistory(action)} className="text-xs font-semibold text-brand underline">History</button></div></td></tr>)}</tbody></table></div>
        )}
        {history && <div className="mt-3 rounded border border-line bg-panel/50 p-3"><div className="mb-2 flex items-center justify-between gap-3"><div className="text-xs font-bold text-foreground">Audit history · {history.title}</div><button onClick={() => setHistory(null)} className="text-xs font-semibold text-muted">Close</button></div>{history.rows.length ? <ul className="space-y-1.5 text-xs">{history.rows.map((entry) => <li key={entry.id}><span className="font-semibold">{entry.action}</span> · {entry.reason} <span className="text-muted">({entry.actor_name || "Unknown"} · {entry.occurred_at})</span></li>)}</ul> : <div className="text-xs text-muted">No audit events are available.</div>}</div>}
      </div>
      {selected && <NewAction candidate={selected} onClose={() => setSelected(null)} onSaved={onRefresh} />}
    </div>
  );
}

export default function ProductionInsights() {
  const { user } = useAuth();
  const location = useLocation();
  const [view, setView] = useState("worker");
  const commandFilters = () => {
    const params = new URLSearchParams(location.search);
    return {
      date_from: params.get("date_from") || monthAgo,
      date_to: params.get("date_to") || today,
      factory_id: params.get("prod_factory_id") || "",
      line_id: params.get("prod_line_id") || "",
      shift_id: params.get("prod_shift_id") || "",
    };
  };
  const [filters, setFilters] = useState(commandFilters);
  const [productivity, setProductivity] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const role = String(user?.role || "").toLowerCase();
  const privacy = ["quality", "fabric_quality_supervisor", "product_development"].includes(role);
  const canWrite = ["admin", "production", "leadership", "smt"].includes(role);
  const load = useCallback(async (force = false) => {
    setLoading(true); setError(null);
    try {
      const config = { params: { ...filters, view }, ...(force ? { forceFresh: true } : {}) };
      const [metrics, queue] = await Promise.all([
        api.get("/production-workspace/productivity", config).then((r) => r.data),
        api.get("/production-workspace/recovery", { params: filters, ...(force ? { forceFresh: true } : {}) }).then((r) => r.data),
      ]);
      setProductivity(metrics); setRecovery(queue);
    } catch (err) {
      setError(err?.response?.data?.detail || "Could not load productivity and recovery context.");
    } finally { setLoading(false); }
  }, [filters, view]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setFilters(commandFilters()); }, [location.search]);
  const rows = productivity?.rows || [];
  const summary = useMemo(() => ({
    available: rows.filter((row) => row.metric_state === "available").length,
    earned: rows.some((row) => row.earned_minutes !== null && row.earned_minutes !== undefined) ? rows.reduce((sum, row) => sum + (Number(row.earned_minutes) || 0), 0) : null,
    downtime: rows.some((row) => row.downtime_minutes !== null && row.downtime_minutes !== undefined) ? rows.reduce((sum, row) => sum + (Number(row.downtime_minutes) || 0), 0) : null,
    atRisk: (recovery?.queue || []).filter((row) => row.priority_band === "urgent").length,
  }), [rows, recovery]);
  if (loading && !productivity) return <Loading label="Loading verified productivity context…" />;
  return (
    <main className="space-y-4" data-testid="production-insights">
      <SectionTitle title="Productivity & Recovery" subtitle="Contextual, private-by-scope operational insight. Missing attendance, output, SAM or quality inputs stay unavailable — never a zero or ranking." action={<button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded border border-line px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-panel"><ArrowClockwise size={15} /> Refresh</button>} />
      {error && <ErrorBox message={error} />}
      <section className="card-white p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-foreground">From<input type="date" value={filters.date_from} onChange={(e) => setFilters((p) => ({ ...p, date_from: e.target.value }))} className="mt-1 block rounded border border-line px-2 py-1.5 font-normal" /></label>
          <label className="text-xs font-semibold text-foreground">To<input type="date" value={filters.date_to} onChange={(e) => setFilters((p) => ({ ...p, date_to: e.target.value }))} className="mt-1 block rounded border border-line px-2 py-1.5 font-normal" /></label>
          <fieldset className="flex gap-1 rounded border border-line p-1"><legend className="sr-only">Productivity view</legend>{["worker", "line", "factory"].map((item) => <button key={item} onClick={() => setView(item)} className={`rounded px-2.5 py-1.5 text-xs font-semibold capitalize ${view === item ? "bg-[#1a5c38] text-white" : "text-muted hover:bg-panel"}`}>{item}</button>)}</fieldset>
          <p className="ml-auto max-w-xl text-xs text-muted">{productivity?.scope?.supervisor_scope || "Authorized roles see the appropriate operational scope."}</p>
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Complete efficiency contexts" value={`${summary.available}/${rows.length}`} hint="Only rows with approved SAM and complete attendance" />
        <Kpi label="Earned minutes" value={minutes(summary.earned)} hint="Good output × approved SAM" />
        <Kpi label="Recorded downtime" value={minutes(summary.downtime)} hint="From validated downtime events" />
        <Kpi label="Urgent recovery contexts" value={summary.atRisk} hint="Approved commitments with explainable risks" />
      </section>
      <section className="card-white p-4">
        <SectionTitle title={`${view[0].toUpperCase()}${view.slice(1)} context`} subtitle={privacy ? "This role sees the quality/plan context needed for investigation; individual attendance and efficiency are withheld." : "Use these calculations to coach and unblock work. There is no default ranking."} />
        <MetricTable rows={rows} view={view} privacy={privacy} />
      </section>
      <RecoveryQueue recovery={recovery} canWrite={canWrite} onRefresh={() => load(true)} />
      <section className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
        <div className="flex items-center gap-2 font-semibold"><TrendUp size={16} /> Metric contract and drill-down paths</div>
        <p className="mt-1">Earned minutes use good output × the approved operation SAM. Efficiency is earned minutes ÷ complete recorded attended minutes. The <Link to="?tab=tracker" className="font-semibold underline">Production Tracker</Link> remains the stage/WIP source and <Link to="/quality" className="font-semibold underline">Quality</Link> remains the defect source; this view only links their verified context.</p>
      </section>
    </main>
  );
}