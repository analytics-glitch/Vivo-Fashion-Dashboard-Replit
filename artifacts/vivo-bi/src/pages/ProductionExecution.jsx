import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import {
  ArrowClockwise, CheckCircle, Clock, DownloadSimple, Factory,
  FileArrowUp, FloppyDisk, LinkSimple, WarningCircle,
} from "@phosphor-icons/react";

const EVENT_TYPES = [
  ["downtime", "Downtime"],
  ["attendance", "Attendance / absence"],
  ["qc_defect", "QC defect"],
  ["recovery", "Delivery recovery"],
  ["wip", "WIP movement reference"],
];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const n = (v) => Number(v || 0);
const fmt = (v) => n(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

function Notice({ kind = "info", children }) {
  const styles = {
    info: "border-sky-200 bg-sky-50 text-sky-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    error: "border-rose-200 bg-rose-50 text-rose-800",
  };
  return <div className={`rounded-lg border px-3 py-2 text-[12px] ${styles[kind]}`}>{children}</div>;
}

function Field({ label, value, onChange, type = "text", placeholder, required }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold text-muted">{label}{required ? " *" : ""}</span>
      <input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-md border border-line bg-white px-2.5 py-2 text-[12.5px] text-[#0f3d24] outline-none focus:ring-2 focus:ring-brand/25"
      />
    </label>
  );
}

function ContextCard({ row, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition ${
        selected ? "border-[#1a5c38] bg-emerald-50 ring-1 ring-[#1a5c38]" : "border-line bg-white hover:border-brand/50"
      }`}
      data-testid={`execution-worklist-${row.plan_version_id}-${row.assignment_id || "plan"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold text-[#0f3d24]">
            {row.style_number || row.order_style_name || row.external_ref}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted">{row.external_ref} · {row.operation_name || "Unassigned operation"}</div>
        </div>
        <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-700">
          {row.status}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        <span><Factory size={12} className="mr-1 inline" />{row.factory_name}</span>
        <span>{row.line_name || "No line"} · {row.shift_name || "No shift"}</span>
        <span>{fmt(row.captured_qty)} captured</span>
      </div>
      {row.operator_name && <div className="mt-1 text-[11px] text-muted">Assigned to {row.operator_name}</div>}
    </button>
  );
}

function OutputForm({ context, date, onSaved }) {
  const [kind, setKind] = useState("hourly");
  const [hour, setHour] = useState(String(new Date().getHours()));
  const [planned, setPlanned] = useState("");
  const [good, setGood] = useState("");
  const [reject, setReject] = useState("");
  const [rework, setRework] = useState("");
  const [comments, setComments] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const total = n(good) + n(reject) + n(rework);
  const key = `output-${context.plan_version_id}-${context.assignment_id || "plan"}-${date}-${kind}-${kind === "hourly" ? hour : "shift"}`;

  const save = async (e) => {
    e.preventDefault();
    setMessage(null);
    if (total > n(planned)) {
      setMessage({ kind: "error", text: "Good + rejects + rework cannot exceed planned quantity." });
      return;
    }
    if (!reason.trim()) {
      setMessage({ kind: "error", text: "Add a short reason so the capture is auditable." });
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/production-workspace/execution/plans/${context.plan_version_id}/output`, {
        plan_version_id: context.plan_version_id,
        assignment_id: context.assignment_id || undefined,
        work_item_id: context.work_item_id,
        capture_kind: kind,
        capture_date: date,
        hour_no: kind === "hourly" ? Number(hour) : undefined,
        planned_qty: Number(planned),
        good_qty: Number(good || 0),
        reject_qty: Number(reject || 0),
        rework_qty: Number(rework || 0),
        capture_key: key,
        comments,
        reason,
      });
      setMessage({ kind: "success", text: data?.idempotent ? "Already captured — safe retry confirmed." : "Output saved and reconciled." });
      setGood(""); setReject(""); setRework(""); setComments("");
      onSaved?.();
    } catch (err) {
      setMessage({ kind: "error", text: err?.response?.data?.detail || err.message || "Could not save output. Check your connection and retry." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="card-white p-4" data-testid="execution-output-form">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div><div className="font-bold text-[#0f3d24]">Capture output</div><div className="text-[11px] text-muted">One safe entry per assignment, date and period.</div></div>
        <div className="rounded-full bg-panel px-2 py-1 text-[11px] font-bold text-[#0f3d24]">{fmt(total)} / {fmt(planned || 0)} total</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="mb-1 block text-[11px] font-semibold text-muted">Capture period</span><select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-md border border-line bg-white px-2.5 py-2 text-[12.5px]"><option value="hourly">Hourly</option><option value="shift">Whole shift</option></select></label>
        {kind === "hourly" ? <Field label="Hour (0–23)" type="number" value={hour} onChange={setHour} required /> : <div />}
        <Field label="Planned quantity" type="number" value={planned} onChange={setPlanned} required />
        <Field label="Good pieces" type="number" value={good} onChange={setGood} />
        <Field label="Rejects" type="number" value={reject} onChange={setReject} />
        <Field label="Rework" type="number" value={rework} onChange={setRework} />
        <Field label="Comments" value={comments} onChange={setComments} placeholder="Optional context" />
        <Field label="Reason / confirmation note" value={reason} onChange={setReason} placeholder="e.g. Supervisor shift close" required />
      </div>
      {message && <div className="mt-3"><Notice kind={message.kind}>{message.text}</Notice></div>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10.5px] text-muted">Key: <span className="font-mono">{key}</span></span>
        <button type="submit" disabled={busy} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-[#1a5c38] px-3 py-2 text-[12px] font-semibold text-white hover:bg-[#0f3d24] disabled:opacity-50" data-testid="execution-output-save"><FloppyDisk size={14} />{busy ? "Saving…" : "Save output"}</button>
      </div>
    </form>
  );
}

function EventForm({ context, date, onSaved }) {
  const [type, setType] = useState("downtime");
  const [reason, setReason] = useState("");
  const [cause, setCause] = useState("");
  const [action, setAction] = useState("");
  const [quantity, setQuantity] = useState("");
  const [duration, setDuration] = useState("");
  const [evidence, setEvidence] = useState("");
  const [notes, setNotes] = useState("");
  const [fromStage, setFromStage] = useState("");
  const [toStage, setToStage] = useState("");
  const [movementId, setMovementId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [eventNonce, setEventNonce] = useState(() => (
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  ));
  const key = `event-${context.plan_version_id}-${context.assignment_id || "plan"}-${date}-${type}-${eventNonce}`;

  const save = async (e) => {
    e.preventDefault();
    setMessage(null);
    if (!reason.trim() || (type === "downtime" && (!cause.trim() || !action.trim())) || (type === "recovery" && !action.trim()) || (type === "wip" && !fromStage.trim() && !toStage.trim())) {
      setMessage({ kind: "error", text: type === "downtime" ? "Reason, cause and action are required." : type === "recovery" ? "Reason and recovery action are required." : type === "wip" ? "Add the from or to stage for this WIP reference." : "Reason is required." });
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/production-workspace/execution/events", {
        plan_version_id: context.plan_version_id,
        assignment_id: context.assignment_id || undefined,
        work_item_id: context.work_item_id,
        event_type: type,
        event_date: date,
        event_key: key,
        reason, cause, action,
        quantity: quantity === "" ? undefined : Number(quantity),
        duration_minutes: duration === "" ? undefined : Number(duration),
        evidence_ref: evidence || undefined,
        notes: notes || undefined,
        from_stage: fromStage || undefined,
        to_stage: toStage || undefined,
        stage_movement_id: movementId === "" ? undefined : Number(movementId),
      });
      setMessage({ kind: "success", text: data?.idempotent ? "Already recorded — safe retry confirmed." : "Event saved to the execution timeline." });
      setReason(""); setCause(""); setAction(""); setQuantity(""); setDuration(""); setEvidence(""); setNotes(""); setFromStage(""); setToStage(""); setMovementId("");
      setEventNonce(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      onSaved?.();
    } catch (err) {
      setMessage({ kind: "error", text: err?.response?.data?.detail || err.message || "Could not save the event. Check your connection and retry." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="card-white p-4" data-testid="execution-event-form">
      <div className="mb-3"><div className="font-bold text-[#0f3d24]">Record an operational cause</div><div className="text-[11px] text-muted">Each event stays linked to this plan, line, shift and order.</div></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2"><span className="mb-1 block text-[11px] font-semibold text-muted">Event type</span><select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-md border border-line bg-white px-2.5 py-2 text-[12.5px]">{EVENT_TYPES.map(([v, label]) => <option value={v} key={v}>{label}</option>)}</select></label>
        <Field label="Reason" value={reason} onChange={setReason} placeholder="What happened?" required />
        <Field label={type === "downtime" ? "Cause" : "Action / detail"} value={type === "downtime" ? cause : action} onChange={type === "downtime" ? setCause : setAction} placeholder={type === "recovery" ? "Owner's recovery action" : "Optional detail"} required={type === "downtime" || type === "recovery"} />
        {type === "downtime" && <Field label="Immediate action" value={action} onChange={setAction} placeholder="What was done?" required />}
        {(type === "downtime" || type === "attendance") && <Field label="Minutes" type="number" value={duration} onChange={setDuration} />}
        {type === "qc_defect" && <Field label="Affected quantity" type="number" value={quantity} onChange={setQuantity} />}
        {type === "wip" && <><Field label="From stage" value={fromStage} onChange={setFromStage} placeholder="e.g. cutting" required /><Field label="To stage" value={toStage} onChange={setToStage} placeholder="e.g. sewing" required /><Field label="Existing tracker movement ID" type="number" value={movementId} onChange={setMovementId} placeholder="Required tracker link" required /></>}
        <Field label="Evidence / attachment reference" value={evidence} onChange={setEvidence} placeholder="Photo, ticket or document reference" />
        <Field label="Notes" value={notes} onChange={setNotes} placeholder="Follow-up context" />
      </div>
      {message && <div className="mt-3"><Notice kind={message.kind}>{message.text}</Notice></div>}
      {type === "wip" && <div className="mt-3"><Notice kind="info">WIP must link an existing Production Tracker movement. This never changes stage balances or writes to Odoo.</Notice></div>}
      <div className="mt-3 flex justify-end"><button type="submit" disabled={busy} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-[#1a5c38] px-3 py-2 text-[12px] font-semibold text-white hover:bg-[#0f3d24] disabled:opacity-50" data-testid="execution-event-save"><FloppyDisk size={14} />{busy ? "Saving…" : "Save event"}</button></div>
    </form>
  );
}

function BulkCapture({ onSaved }) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [batchKey, setBatchKey] = useState("");
  const columns = "plan_version_id,assignment_id,capture_kind,capture_date,hour_no,planned_qty,good_qty,reject_qty,rework_qty,capture_key,comments,reason";

  const download = async () => {
    try {
      const { data } = await api.get("/production-workspace/execution/bulk/template", { forceFresh: true });
      const header = (data?.columns || columns.split(",")).join(",");
      const blob = new Blob([`${header}\n`], { type: "text/csv" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "production-execution-template.csv"; a.click(); URL.revokeObjectURL(url);
    } catch (err) { setMessage({ kind: "error", text: err?.response?.data?.detail || "Template unavailable." }); }
  };
  const runPreview = async () => {
    setBusy(true); setMessage(null);
    try {
      const { data } = await api.post("/production-workspace/execution/bulk/preview", { csv, batch_key: batchKey });
      setPreview(data);
      setMessage({ kind: data.valid ? "success" : "warning", text: data.valid ? `${data.row_count} rows ready to commit.` : "Fix the highlighted rows before committing." });
    } catch (err) { setMessage({ kind: "error", text: err?.response?.data?.detail || err.message || "Preview failed." }); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!batchKey.trim()) { setMessage({ kind: "error", text: "Add a batch key before committing." }); return; }
    setBusy(true);
    try {
      const { data } = await api.post("/production-workspace/execution/bulk/commit", { csv, batch_key: batchKey, reason: "Supervisor bulk execution capture" });
      setMessage({ kind: "success", text: data.idempotent ? "Batch was already committed — safe retry confirmed." : `${data.committed} rows committed atomically.` });
      onSaved?.();
    } catch (err) { setMessage({ kind: "error", text: err?.response?.data?.detail || err.message || "Commit failed. No partial rows were saved." }); }
    finally { setBusy(false); }
  };
  return (
    <div className="card-white p-4" data-testid="execution-bulk">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-bold text-[#0f3d24]">Bulk daily / shift entry</div><div className="text-[11px] text-muted">Preview validates every row. Commit is atomic and safe to retry.</div></div><button type="button" onClick={download} className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand underline"><DownloadSimple size={13} />Template</button></div>
      <textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={`${columns}\n123,456,hourly,2026-08-25,8,40,36,2,2,unique-key,,shift close`} className="mt-3 min-h-[100px] w-full rounded-md border border-line bg-white p-2.5 font-mono text-[10.5px] outline-none focus:ring-2 focus:ring-brand/25" />
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]"><Field label="Batch key" value={batchKey} onChange={setBatchKey} placeholder="e.g. supervisor-2026-08-25-am" required /><button type="button" onClick={runPreview} disabled={busy} className="self-end rounded-md border border-brand/30 px-3 py-2 text-[12px] font-semibold text-brand disabled:opacity-50"><FileArrowUp size={14} className="mr-1 inline" />{busy ? "Checking…" : "Preview"}</button><button type="button" onClick={commit} disabled={busy || !preview?.valid} className="self-end rounded-md bg-[#1a5c38] px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40"><CheckCircle size={14} className="mr-1 inline" />Commit</button></div>
      {message && <div className="mt-3"><Notice kind={message.kind}>{message.text}</Notice></div>}
      {preview && <div className="mt-3 max-h-44 overflow-auto rounded border border-line text-[11px]">{preview.rows.map((r) => <div key={r.row} className={`flex gap-2 border-b border-line px-2 py-1.5 ${r.valid ? "" : "bg-rose-50 text-rose-800"}`}><span className="w-8 shrink-0 font-mono">#{r.row}</span><span className="min-w-0 flex-1 truncate">{r.capture_key || "missing key"}</span><span>{r.valid ? "Ready" : r.errors.join("; ")}</span></div>)}</div>}
    </div>
  );
}

function OutputTrail({ output, onSaved }) {
  const [editing, setEditing] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const saveCorrection = async (e) => {
    e.preventDefault();
    if (!reason.trim()) { setMessage({ kind: "error", text: "State why this correction is needed." }); return; }
    setBusy(true); setMessage(null);
    try {
      await api.patch(`/production-workspace/execution/output/${editing.id}`, {
        expected_version: editing.version_token,
        planned_qty: Number(editing.planned_qty),
        good_qty: Number(editing.good_qty),
        reject_qty: Number(editing.reject_qty),
        rework_qty: Number(editing.rework_qty),
        comments: editing.comments || "",
        reason,
      });
      setEditing(null); setReason("");
      onSaved?.();
    } catch (err) {
      setMessage({ kind: "error", text: err?.response?.data?.detail || "This entry changed elsewhere. Refresh and try again." });
    } finally { setBusy(false); }
  };
  if (!output.length) return null;
  return (
    <div className="card-white p-4">
      <div className="mb-2 font-bold text-[#0f3d24]">Saved output captures</div>
      {message && <div className="mb-2"><Notice kind={message.kind}>{message.text}</Notice></div>}
      <div className="overflow-x-auto"><table className="w-full min-w-[740px] text-left text-[11px]"><thead className="border-b border-line text-muted"><tr><th className="px-2 py-2">Context</th><th className="px-2 py-2">Period</th><th className="px-2 py-2">Plan</th><th className="px-2 py-2">Good</th><th className="px-2 py-2">Reject</th><th className="px-2 py-2">Rework</th><th className="px-2 py-2" /></tr></thead><tbody>{output.map((row) => <React.Fragment key={row.id}><tr className="border-b border-line"><td className="px-2 py-2">{row.style_number || row.external_ref} · {row.line_name || "—"}</td><td className="px-2 py-2">{row.capture_kind === "hourly" ? `${row.hour_no}:00` : "Shift"}</td><td className="px-2 py-2">{fmt(row.planned_qty)}</td><td className="px-2 py-2 font-semibold text-emerald-700">{fmt(row.good_qty)}</td><td className="px-2 py-2 text-rose-700">{fmt(row.reject_qty)}</td><td className="px-2 py-2 text-amber-700">{fmt(row.rework_qty)}</td><td className="px-2 py-2"><button type="button" onClick={() => { setEditing({ ...row }); setMessage(null); }} className="font-semibold text-brand underline">Correct</button></td></tr>{editing?.id === row.id && <tr className="border-b border-line bg-amber-50"><td colSpan="7" className="p-3"><form onSubmit={saveCorrection} className="grid gap-2 sm:grid-cols-6"><Field label="Plan" type="number" value={editing.planned_qty} onChange={(v) => setEditing({ ...editing, planned_qty: v })} /><Field label="Good" type="number" value={editing.good_qty} onChange={(v) => setEditing({ ...editing, good_qty: v })} /><Field label="Reject" type="number" value={editing.reject_qty} onChange={(v) => setEditing({ ...editing, reject_qty: v })} /><Field label="Rework" type="number" value={editing.rework_qty} onChange={(v) => setEditing({ ...editing, rework_qty: v })} /><Field label="Correction reason" value={reason} onChange={setReason} required /><div className="flex items-end gap-2"><button type="submit" disabled={busy} className="min-h-[38px] rounded-md bg-[#1a5c38] px-2.5 text-[11px] font-semibold text-white disabled:opacity-50">Save correction</button><button type="button" onClick={() => setEditing(null)} className="min-h-[38px] text-[11px] font-semibold text-muted">Cancel</button></div></form></td></tr>}</React.Fragment>)}</tbody></table></div>
    </div>
  );
}

export default function ProductionExecution() {
  const location = useLocation();
  const commandDate = new URLSearchParams(location.search).get("date_to");
  const [date, setDate] = useState(() => commandDate || today);
  const [worklist, setWorklist] = useState(null);
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [output, setOutput] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const opts = { params: { capture_date: date }, ...(force ? { forceFresh: true } : {}) };
      const [wl, sm, ev, out] = await Promise.all([
        api.get("/production-workspace/execution/worklist", opts),
        api.get("/production-workspace/execution/summary", opts),
        api.get("/production-workspace/execution/events", { params: { event_date: date }, ...(force ? { forceFresh: true } : {}) }),
        api.get("/production-workspace/execution/output", opts),
      ]);
      setWorklist(wl.data); setSummary(sm.data); setEvents(ev.data?.events || []); setOutput(out.data?.output || []);
      setSelected((current) => current && (wl.data?.worklist || []).some((r) => r.plan_version_id === current.plan_version_id && r.assignment_id === current.assignment_id) ? current : wl.data?.worklist?.[0] || null);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Could not load execution capture. Check your connection.");
    } finally { setLoading(false); setRefreshing(false); }
  }, [date]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("date_to");
    if (requested) setDate(requested);
  }, [location.search]);
  const eventCounts = useMemo(() => Object.fromEntries((summary?.summary?.events || []).map((x) => [x.event_type, x.count])), [summary]);
  const resolveEvent = async (event) => {
    try {
      await api.patch(`/production-workspace/execution/events/${event.id}`, {
        expected_version: event.version_token, status: "resolved",
        reason: "Supervisor marked the execution follow-up resolved.",
      });
      load(true);
    } catch (err) {
      setError(err?.response?.data?.detail || "This event changed elsewhere. Refresh and try again.");
    }
  };

  return (
    <div className="space-y-4" data-testid="production-execution">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex items-center gap-2"><Factory size={20} className="text-brand" /><h1 className="text-xl font-extrabold text-[#0f3d24]">Production Execution Capture</h1></div><p className="mt-1 text-[12px] text-muted">Supervisor capture for approved plans — output, causes, quality and recovery.</p></div>
        <div className="flex flex-wrap items-center gap-2"><label className="text-[11px] font-semibold text-muted">Work date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="ml-1 rounded-md border border-line px-2 py-2 text-[12px]" /></label><button type="button" onClick={() => load(true)} disabled={refreshing || loading} className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-brand/30 px-3 py-2 text-[12px] font-semibold text-brand disabled:opacity-50"><ArrowClockwise size={14} className={refreshing ? "animate-spin" : ""} />{refreshing ? "Refreshing…" : "Refresh"}</button></div>
      </div>
      <div className="flex flex-wrap gap-2"><a href="/production?tab=tracker" className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-[#0f3d24]"><LinkSimple size={12} />Production Tracker</a><a href="/production?tab=report" className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-[#0f3d24]"><LinkSimple size={12} />Production Report</a><a href="/quality" className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-[#0f3d24]"><LinkSimple size={12} />Quality & rework</a></div>
      {loading ? <div className="card-white p-8 text-center text-sm text-muted"><Clock size={20} className="mr-1 inline animate-pulse" />Loading approved assignments…</div> : error ? <Notice kind="error"><WarningCircle size={14} className="mr-1 inline" />{error} <button type="button" onClick={() => load(true)} className="ml-2 font-semibold underline">Retry</button></Notice> : worklist?.state === "missing_plan" ? <Notice kind="warning"><WarningCircle size={14} className="mr-1 inline" />No approved plan or authorized line assignment is available for {date}. Planning must approve and assign work before capture can begin.</Notice> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5"><div className="card-white p-3"><div className="eyebrow">Assignments</div><div className="mt-1 text-xl font-extrabold text-brand">{worklist.worklist.length}</div></div><div className="card-white p-3"><div className="eyebrow">Good pieces</div><div className="mt-1 text-xl font-extrabold text-emerald-700">{fmt(summary?.summary?.good_qty)}</div></div><div className="card-white p-3"><div className="eyebrow">Rejects</div><div className="mt-1 text-xl font-extrabold text-rose-700">{fmt(summary?.summary?.reject_qty)}</div></div><div className="card-white p-3"><div className="eyebrow">Rework</div><div className="mt-1 text-xl font-extrabold text-amber-700">{fmt(summary?.summary?.rework_qty)}</div></div><div className="card-white p-3"><div className="eyebrow">Open events</div><div className="mt-1 text-xl font-extrabold text-[#0f3d24]">{fmt(Object.values(eventCounts).reduce((a, v) => a + n(v), 0))}</div></div></div>
          <div className="grid gap-4 xl:grid-cols-[minmax(240px,0.75fr)_minmax(420px,1.25fr)]"><div><div className="mb-2 text-[12px] font-bold text-[#0f3d24]">Approved worklist</div><div className="space-y-2">{worklist.worklist.map((row) => <ContextCard key={`${row.plan_version_id}-${row.assignment_id || "plan"}`} row={row} selected={selected?.plan_version_id === row.plan_version_id && selected?.assignment_id === row.assignment_id} onSelect={() => setSelected(row)} />)}</div></div><div className="space-y-4">{selected ? <><div className="rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-[12px] text-[#0f3d24]"><strong>{selected.style_number || selected.external_ref}</strong> · {selected.factory_name} / {selected.line_name || "No line"} / {selected.shift_name || "No shift"} · {selected.operation_name || "Assignment"}<div className="mt-0.5 text-[10.5px] text-muted">Plan {selected.plan_version_id} · {selected.status} · stage balances remain owned by Odoo / Production Tracker</div></div><OutputForm context={selected} date={date} onSaved={() => load(true)} /><EventForm context={selected} date={date} onSaved={() => load(true)} /></> : <Notice kind="info">Choose an assignment to begin capture.</Notice>}</div></div>
          <BulkCapture onSaved={() => load(true)} />
          <OutputTrail output={output} onSaved={() => load(true)} />
          {events.length > 0 && <div className="card-white p-4"><div className="mb-2 font-bold text-[#0f3d24]">Today’s event trail</div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[11px]"><thead className="border-b border-line text-muted"><tr><th className="px-2 py-2">Type</th><th className="px-2 py-2">Context</th><th className="px-2 py-2">Reason</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Evidence</th><th className="px-2 py-2" /></tr></thead><tbody>{events.map((e) => <tr key={e.id} className="border-b border-line"><td className="px-2 py-2 font-semibold">{e.event_type.replace("_", " ")}</td><td className="px-2 py-2">{e.style_number || e.external_ref} · {e.line_name || "—"}</td><td className="px-2 py-2">{e.reason}</td><td className="px-2 py-2">{e.status}</td><td className="px-2 py-2">{e.evidence_ref || "—"}</td><td className="px-2 py-2">{!["resolved", "closed", "excused"].includes(e.status) && <button type="button" onClick={() => resolveEvent(e)} className="font-semibold text-brand underline">Resolve</button>}</td></tr>)}</tbody></table></div></div>}
        </>
      )}
    </div>
  );
}