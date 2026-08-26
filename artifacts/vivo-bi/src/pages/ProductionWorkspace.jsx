import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { ErrorBox, Loading, SectionTitle } from "@/components/common";
import {
  ArrowsClockwise, CheckCircle, ClipboardText, DownloadSimple, Factory,
  FileArrowUp, FloppyDisk, LockKey, Plus, WarningCircle,
} from "@phosphor-icons/react";

const CATALOGUES = [
  ["factories", "Factories"],
  ["lines", "Lines"],
  ["shifts", "Shifts & calendars"],
  ["calendars", "Shift calendars"],
  ["machines", "Machines"],
  ["capabilities", "Capabilities"],
  ["operators", "Operators"],
  ["skills", "Skills"],
  ["operation_definitions", "Operation / SAM definitions"],
  ["targets", "Approved targets"],
];

const MASTER_FIELDS = {
  factories: [["code", "Code"], ["name", "Name"], ["timezone", "Timezone"], ["active", "Active", "boolean"]],
  lines: [["factory_id", "Factory ID", "number"], ["code", "Code"], ["name", "Name"], ["active", "Active", "boolean"]],
  shifts: [["factory_id", "Factory ID", "number"], ["code", "Code"], ["name", "Name"], ["start_time", "Start", "time"], ["end_time", "End", "time"], ["active", "Active", "boolean"]],
  calendars: [["factory_id", "Factory ID", "number"], ["calendar_date", "Date", "date"], ["shift_id", "Shift ID", "number"], ["capacity_minutes", "Minutes", "number"], ["day_status", "Status"],],
  machines: [["factory_id", "Factory ID", "number"], ["line_id", "Line ID", "number"], ["code", "Code"], ["name", "Name"], ["active", "Active", "boolean"]],
  capabilities: [["machine_id", "Machine ID", "number"], ["line_id", "Line ID", "number"], ["capability_key", "Capability key"], ["name", "Name"], ["active", "Active", "boolean"]],
  operators: [["operator_code", "Operator code"], ["display_name", "Display name"], ["user_id", "App user ID"], ["active", "Active", "boolean"]],
  skills: [["skill_key", "Skill key"], ["name", "Name"], ["active", "Active", "boolean"]],
  operation_definitions: [["operation_code", "Operation code"], ["name", "Name"], ["default_sam_minutes", "Default SAM", "number"], ["capability_id", "Capability ID", "number"], ["active", "Active", "boolean"]],
  targets: [["factory_id", "Factory ID", "number"], ["line_id", "Line ID", "number"], ["target_date", "Date", "date"], ["target_qty", "Target units", "number"], ["status", "Status"]],
};

const blank = (resource) => Object.fromEntries(
  (MASTER_FIELDS[resource] || []).map(([key, , type]) => [key, type === "boolean" ? true : key === "status" ? "draft" : ""])
);
const num = (value) => Number(value || 0);
const asId = (value) => value === "" || value == null ? null : Number(value);
const fmt = (value, digits = 1) => num(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const title = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function Badge({ status }) {
  const tone = {
    draft: "bg-slate-100 text-slate-700 border-slate-200",
    submitted: "bg-amber-50 text-amber-800 border-amber-200",
    approved: "bg-sky-50 text-sky-800 border-sky-200",
    frozen: "bg-violet-50 text-violet-800 border-violet-200",
    reopened: "bg-orange-50 text-orange-800 border-orange-200",
    passed: "bg-emerald-50 text-emerald-800 border-emerald-200",
    waived: "bg-violet-50 text-violet-800 border-violet-200",
    failed: "bg-rose-50 text-rose-800 border-rose-200",
    pending: "bg-amber-50 text-amber-800 border-amber-200",
  }[status] || "bg-slate-100 text-slate-700 border-slate-200";
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{title(status)}</span>;
}

function Field({ label, value, onChange, type = "text", options }) {
  if (type === "boolean") {
    return <label className="flex items-center gap-2 text-xs font-medium text-slate-700"><input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
  }
  if (options) {
    return <label className="block text-xs font-medium text-slate-700">{label}
      <select className="input-pill mt-1 w-full text-xs" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>;
  }
  return <label className="block text-xs font-medium text-slate-700">{label}
    <input className="input-pill mt-1 w-full text-xs" type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
  </label>;
}

function ReasonBar({ reason, setReason }) {
  return <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
    <Field label="Reason for changes (recorded in the audit timeline)" value={reason} onChange={setReason} />
  </div>;
}

function MasterEditor({ catalogues, canPlan, canApprove, reason, onSaved }) {
  const [resource, setResource] = useState("factories");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank("factories"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const rows = catalogues?.[resource] || [];
  const fields = MASTER_FIELDS[resource] || [];

  const openCreate = () => { setEditing(null); setForm(blank(resource)); setError(null); };
  const openEdit = (row) => {
    setEditing(row);
    setForm(Object.fromEntries(fields.map(([key, , type]) => [key, type === "boolean" ? Boolean(row[key]) : row[key] ?? ""])));
    setError(null);
  };
  const save = async (e) => {
    e.preventDefault();
    if (!reason || reason.trim().length < 3) { setError("Add a short reason first."); return; }
    setSaving(true); setError(null);
    const body = { ...form, reason };
    for (const [key, , type] of fields) {
      if (type === "number") body[key] = body[key] === "" ? null : Number(body[key]);
    }
    try {
      if (editing) await api.patch(`/production-workspace/catalogues/${resource}/${editing.id}`, { ...body, expected_version: editing.version_token });
      else await api.post(`/production-workspace/catalogues/${resource}`, body);
      openCreate(); onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not save master data."); }
    finally { setSaving(false); }
  };
  const approveRecord = async (row) => {
    if (!reason || reason.trim().length < 3) { setError("Add a short reason first."); return; }
    setSaving(true); setError(null);
    try {
      const path = resource === "targets"
        ? `/production-workspace/targets/${row.id}/approve`
        : `/production-workspace/operation-definitions/${row.id}/approve`;
      await api.post(path, { expected_version: row.version_token, reason });
      onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not approve target."); }
    finally { setSaving(false); }
  };
  const reviseRecord = async (row) => {
    if (!reason || reason.trim().length < 3) { setError("Add a short reason first."); return; }
    setSaving(true); setError(null);
    try {
      await api.post(`/production-workspace/catalogues/${resource}/${row.id}/revise`, { expected_version: row.version_token, reason });
      onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not create a draft revision."); }
    finally { setSaving(false); }
  };
  return <><div className="grid gap-4 xl:grid-cols-[1.45fr_0.9fr]">
    <div className="card-white overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div><div className="font-bold text-[#0f3d24]">Master data</div><div className="text-xs text-muted">Maintain the approved planning denominators.</div></div>
        <select className="input-pill text-xs" value={resource} onChange={(e) => { setResource(e.target.value); setEditing(null); setForm(blank(e.target.value)); }}>
          {CATALOGUES.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select>
      </div>
      <div className="max-h-[460px] overflow-auto">
        {rows.length === 0 ? <div className="p-8 text-center text-sm text-muted">No {title(resource)} maintained yet.</div> :
          <table className="data min-w-full"><thead><tr><th>ID</th><th>Record</th><th>Status</th><th /></tr></thead><tbody>
            {rows.map((row) => <tr key={row.id}>
              <td className="num">{row.id}</td>
              <td><div className="font-semibold">{row.name || row.display_name || row.code || row.operation_code || row.operator_code || row.skill_key || row.capability_key}</div>
                <div className="text-[11px] text-muted">{row.code || row.operation_code || row.operator_code || row.skill_key || row.capability_key || row.target_date || ""}</div></td>
              <td>{row.active === false ? <Badge status="retired" /> : row.status ? <Badge status={row.status} /> : <Badge status="approved" />}</td>
              <td><div className="flex gap-2">{canPlan && (!["targets", "operation_definitions"].includes(resource) || row.status === "draft") && <button className="text-xs font-semibold text-brand hover:underline" onClick={() => openEdit(row)}>Edit</button>}{["targets", "operation_definitions"].includes(resource) && row.status === "draft" && canApprove && <button className="text-xs font-semibold text-brand hover:underline" onClick={() => approveRecord(row)}>Approve</button>}{["targets", "operation_definitions"].includes(resource) && row.status === "approved" && canApprove && <button className="text-xs font-semibold text-brand hover:underline" onClick={() => reviseRecord(row)}>Revise</button>}</div></td>
            </tr>)}
          </tbody></table>}
      </div>
    </div>
    {canPlan && <form className="card-white p-4 space-y-3" onSubmit={save}>
      <div className="flex items-center justify-between"><div><div className="font-bold text-[#0f3d24]">{editing ? `Edit ${title(resource)}` : `Add ${title(resource)}`}</div><div className="text-xs text-muted">{editing ? "Optimistic version checks prevent overwrites." : "Saved records become reusable planning inputs."}</div></div>
      {editing && <button type="button" className="text-xs text-muted underline" onClick={openCreate}>New record</button>}</div>
      <div className="grid gap-2 sm:grid-cols-2">{fields.map(([key, label, type]) => <Field key={key} label={label} type={type} value={form[key]} onChange={(v) => setForm((old) => ({ ...old, [key]: v }))} />)}</div>
      {error && <div className="text-xs text-rose-700">{error}</div>}
      <button className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-50" disabled={saving}><FloppyDisk size={14} />{saving ? "Saving…" : editing ? "Save change" : "Add record"}</button>
    </form>}
  </div>{canPlan && <SkillLinker catalogues={catalogues} reason={reason} onSaved={onSaved} />}</>;
}

function SkillLinker({ catalogues, reason, onSaved }) {
  const [operatorId, setOperatorId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [level, setLevel] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const links = catalogues.operator_skills || [];
  const add = async (event) => {
    event.preventDefault();
    if (!reason || reason.trim().length < 3) { setError("Add a short reason first."); return; }
    setBusy(true); setError(null);
    try {
      await api.post(`/production-workspace/operators/${operatorId}/skills`, { skill_id: Number(skillId), skill_level: level || null, reason });
      setOperatorId(""); setSkillId(""); setLevel(""); onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not assign that skill."); }
    finally { setBusy(false); }
  };
  return <div className="card-white mt-4 p-4">
    <div className="font-bold text-[#0f3d24]">Operator skill matrix</div><div className="mt-1 text-xs text-muted">A capability allocation is checked against this approved skill list.</div>
    <form className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_180px_auto]" onSubmit={add}>
      <Field label="Operator" value={operatorId} onChange={setOperatorId} options={(catalogues.operators || []).filter((row) => row.active).map((row) => ({ value: row.id, label: `${row.operator_code} · ${row.display_name}` }))} />
      <Field label="Skill" value={skillId} onChange={setSkillId} options={(catalogues.skills || []).filter((row) => row.active).map((row) => ({ value: row.id, label: `${row.skill_key} · ${row.name}` }))} />
      <Field label="Level (optional)" value={level} onChange={setLevel} />
      <button className="btn-primary self-end text-xs" disabled={busy || !operatorId || !skillId}>{busy ? "Saving…" : "Assign skill"}</button>
    </form>
    {error && <div className="mt-2 text-xs text-rose-700">{error}</div>}
    {links.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{links.map((row) => <span className="rounded-full border border-line bg-slate-50 px-2 py-1 text-[11px]" key={`${row.operator_id}-${row.skill_id}`}>{row.operator_code} · {row.skill_key}{row.skill_level ? ` (${row.skill_level})` : ""}</span>)}</div>}
  </div>;
}

function WorkItemForm({ tracker, stages, workItems, canPlan, reason, onSaved }) {
  const [form, setForm] = useState({ production_order_ref: "", external_ref: "", style_number: "", planned_qty: "", stage_key: "" });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const selectOrder = (orderRef) => {
    const order = (tracker?.orders || []).find((item) => item.order_ref === orderRef);
    setForm((old) => ({ ...old, production_order_ref: orderRef, external_ref: orderRef || old.external_ref, style_number: order?.style_number || old.style_number, planned_qty: order?.order_qty || old.planned_qty }));
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!reason || reason.trim().length < 3) { setError("Add a short reason first."); return; }
    setBusy(true); setError(null);
    try {
      if (editing) {
        await api.patch(`/production-workspace/work-items/${editing.id}`, { ...form, planned_qty: Number(form.planned_qty), expected_version: editing.version_token, reason });
      } else {
        await api.post("/production-workspace/work-items", { ...form, planned_qty: Number(form.planned_qty), reason });
      }
      setEditing(null);
      setForm({ production_order_ref: "", external_ref: "", style_number: "", planned_qty: "", stage_key: "" }); onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not create work item."); }
    finally { setBusy(false); }
  };
  if (!canPlan) return null;
  return <form className="card-white p-4 space-y-3" onSubmit={submit}>
    <div className="flex items-start justify-between gap-2"><div><div className="font-bold text-[#0f3d24]">{editing ? "Edit planning work item" : "Create planning work item"}</div><div className="text-xs text-muted">Link it to a live tracker order where possible.</div></div>{editing && <button className="text-xs text-muted underline" type="button" onClick={() => { setEditing(null); setForm({ production_order_ref: "", external_ref: "", style_number: "", planned_qty: "", stage_key: "" }); }}>New work item</button>}</div>
    <div className="grid gap-2 md:grid-cols-2">
      <Field label="Edit existing work item" value={editing?.id || ""} onChange={(value) => { const record = workItems.find((item) => String(item.id) === String(value)); setEditing(record || null); if (record) setForm({ production_order_ref: record.production_order_ref || "", external_ref: record.external_ref || "", style_number: record.style_number || "", planned_qty: record.planned_qty || "", stage_key: record.stage_key || "" }); }} options={workItems.map((item) => ({ value: item.id, label: `${item.external_ref} · ${item.style_number || "No style"}` }))} />
      <Field label="Tracker order" value={form.production_order_ref} onChange={selectOrder} options={(tracker?.orders || []).map((o) => ({ value: o.order_ref, label: `${o.order_ref} · ${o.style_number || o.style_name || "Unspecified"}` }))} />
      <Field label="External reference" value={form.external_ref} onChange={(v) => setForm((old) => ({ ...old, external_ref: v }))} />
      <Field label="Style number" value={form.style_number} onChange={(v) => setForm((old) => ({ ...old, style_number: v }))} />
      <Field label="Planned quantity" type="number" value={form.planned_qty} onChange={(v) => setForm((old) => ({ ...old, planned_qty: v }))} />
      <Field label="Current tracker stage" value={form.stage_key} onChange={(v) => setForm((old) => ({ ...old, stage_key: v }))} options={(stages || []).map((s) => ({ value: s.stage_key, label: s.stage_name }))} />
    </div>
    {error && <div className="text-xs text-rose-700">{error}</div>}
    <button disabled={busy} className="btn-primary text-xs"><Plus size={14} className="inline mr-1" />{busy ? "Saving…" : editing ? "Save work item" : "Create work item"}</button>
  </form>;
}

function PlanForm({ workItems, catalogues, canPlan, reason, onSaved }) {
  const [form, setForm] = useState({ work_item_id: "", factory_id: "", line_id: "", shift_id: "", planned_start: "", planned_end: "", planned_qty: "" });
  const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  const lines = (catalogues.lines || []).filter((line) => !form.factory_id || Number(line.factory_id) === Number(form.factory_id));
  const shifts = (catalogues.shifts || []).filter((shift) => !form.factory_id || Number(shift.factory_id) === Number(form.factory_id));
  const submit = async (event) => {
    event.preventDefault();
    if (!reason || reason.trim().length < 3) { setError("Add a short reason first."); return; }
    setBusy(true); setError(null);
    try {
      const { work_item_id, ...values } = form;
      await api.post(`/production-workspace/work-items/${work_item_id}/plans`, { ...values, factory_id: asId(values.factory_id), line_id: asId(values.line_id), shift_id: asId(values.shift_id), planned_qty: num(values.planned_qty), reason });
      setForm({ work_item_id: "", factory_id: "", line_id: "", shift_id: "", planned_start: "", planned_end: "", planned_qty: "" }); onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not create plan."); }
    finally { setBusy(false); }
  };
  if (!canPlan) return null;
  return <form onSubmit={submit} className="card-white p-4 space-y-3">
    <div><div className="font-bold text-[#0f3d24]">Start dated line plan</div><div className="text-xs text-muted">Plans only use saved factory, line and shift inputs.</div></div>
    <div className="grid gap-2 md:grid-cols-3">
      <Field label="Work item" value={form.work_item_id} onChange={(v) => setForm((old) => ({ ...old, work_item_id: v }))} options={workItems.map((item) => ({ value: item.id, label: `${item.external_ref} · ${item.style_number || "No style"}` }))} />
      <Field label="Factory" value={form.factory_id} onChange={(v) => setForm((old) => ({ ...old, factory_id: v, line_id: "", shift_id: "" }))} options={(catalogues.factories || []).filter((f) => f.active).map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))} />
      <Field label="Line" value={form.line_id} onChange={(v) => setForm((old) => ({ ...old, line_id: v }))} options={lines.filter((l) => l.active).map((l) => ({ value: l.id, label: `${l.code} · ${l.name}` }))} />
      <Field label="Shift" value={form.shift_id} onChange={(v) => setForm((old) => ({ ...old, shift_id: v }))} options={shifts.filter((s) => s.active).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
      <Field label="Start" type="date" value={form.planned_start} onChange={(v) => setForm((old) => ({ ...old, planned_start: v }))} />
      <Field label="End" type="date" value={form.planned_end} onChange={(v) => setForm((old) => ({ ...old, planned_end: v }))} />
      <Field label="Planned units" type="number" value={form.planned_qty} onChange={(v) => setForm((old) => ({ ...old, planned_qty: v }))} />
    </div>
    {error && <div className="text-xs text-rose-700">{error}</div>}
    <button className="btn-primary text-xs" disabled={busy}><Plus size={14} className="inline mr-1" />{busy ? "Creating…" : "Create draft plan"}</button>
  </form>;
}

function BulkTools({ reason, canPlan, onSaved }) {
  const [resource, setResource] = useState("factories");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const download = async () => {
    const { data } = await api.get(`/production-workspace/bulk/${resource}/template`, { forceFresh: true });
    const csv = `${data.columns.join(",")}\n`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `production-${resource}-template.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const read = async (file) => {
    if (!file) return;
    setBusy(true); setPreview(null); setError(null);
    try {
      const csv = await file.text();
      const { data } = await api.post(`/production-workspace/bulk/${resource}/preview`, { csv });
      setPreview({ ...data, csv });
    } catch (err) { setError(err?.response?.data?.detail || "Could not validate this template."); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!reason || reason.trim().length < 3) { setError("Add a short reason before committing."); return; }
    setBusy(true); setError(null);
    try {
      await api.post(`/production-workspace/bulk/${resource}/commit`, { csv: preview.csv, reason });
      setPreview(null); if (input.current) input.current.value = ""; onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "The import was not committed."); }
    finally { setBusy(false); }
  };
  return <div className="card-white p-4 space-y-4">
    <div><div className="font-bold text-[#0f3d24]">Bulk templates</div><div className="text-xs text-muted">Preview every row first. Invalid files never write partial master data.</div></div>
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Template type" value={resource} onChange={(v) => { setResource(v); setPreview(null); }} options={CATALOGUES.map(([value, label]) => ({ value, label }))} />
      <button type="button" className="btn-ghost text-xs" onClick={download}><DownloadSimple size={14} className="inline mr-1" />Template CSV</button>
      {canPlan && <label className="btn-primary text-xs cursor-pointer"><FileArrowUp size={14} className="inline mr-1" />{busy ? "Checking…" : "Choose CSV"}<input ref={input} className="hidden" type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} /></label>}
    </div>
    {error && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
    {preview && <div className="rounded-lg border border-line overflow-hidden">
      <div className={`px-3 py-2 text-xs font-semibold ${preview.valid ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{preview.valid ? `${preview.row_count} valid rows ready to commit` : "Fix the highlighted row errors before committing"}</div>
      <div className="max-h-64 overflow-auto"><table className="data min-w-full"><thead><tr><th>Row</th><th>Identity</th><th>Validation</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.row}><td>{row.row}</td><td className="font-mono text-xs">{row.identity}</td><td>{row.valid ? <span className="text-emerald-700">Ready</span> : <span className="text-rose-700">{row.errors.join("; ")}</span>}</td></tr>)}</tbody></table></div>
      {preview.valid && canPlan && <div className="border-t border-line p-3"><button type="button" onClick={commit} disabled={busy} className="btn-primary text-xs"><FloppyDisk size={14} className="inline mr-1" />Commit all {preview.row_count} rows</button></div>}
    </div>}
  </div>;
}

export default function ProductionWorkspace() {
  const location = useLocation();
  const [data, setData] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [detail, setDetail] = useState(null);
  const [feasibility, setFeasibility] = useState(null);
  const [active, setActive] = useState("plans");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Command Centre drill-downs retain the selected approved plan in the hub
  // URL. The workspace remains independently usable when it is absent.
  useEffect(() => {
    setSelectedPlanId(new URLSearchParams(location.search).get("prod_plan") || "");
  }, [location.search]);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [root, catalogues, workItems, plans, tracker] = await Promise.all([
        api.get("/production-workspace", { forceFresh: true }),
        api.get("/production-workspace/catalogues", { forceFresh: true }),
        api.get("/production-workspace/work-items", { forceFresh: true }),
        api.get("/production-workspace/plans", { forceFresh: true }),
        api.get("/production-workspace/tracker-references", { forceFresh: true }),
      ]);
      setData({ root: root.data, catalogues: catalogues.data.catalogues || {}, workItems: workItems.data.work_items || [], plans: plans.data.plans || [], tracker: tracker.data });
    } catch (err) { setError(err?.response?.data?.detail || "Could not load the production planning workspace."); }
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (planId) => {
    if (!planId) { setDetail(null); setFeasibility(null); return; }
    try {
      const [plan, check] = await Promise.all([
        api.get(`/production-workspace/plans/${planId}`, { forceFresh: true }),
        api.get(`/production-workspace/plans/${planId}/feasibility`, { forceFresh: true }),
      ]);
      setDetail(plan.data); setFeasibility(check.data);
    } catch (err) { setError(err?.response?.data?.detail || "Could not load the selected plan."); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { loadDetail(selectedPlanId); }, [selectedPlanId, loadDetail]);
  const onSaved = async () => { await refresh(); if (selectedPlanId) await loadDetail(selectedPlanId); };
  const canPlan = Boolean(data?.root?.permissions?.can_plan);
  const canApprove = Boolean(data?.root?.permissions?.can_approve);
  const plan = detail?.plan;
  const mutable = plan && ["draft", "reopened"].includes(plan.status) && canPlan;
  const commandScope = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      factoryId: params.get("prod_factory_id") || "",
      lineId: params.get("prod_line_id") || "",
      shiftId: params.get("prod_shift_id") || "",
      dateFrom: params.get("date_from") || "",
      dateTo: params.get("date_to") || "",
    };
  }, [location.search]);
  const planOptions = useMemo(() => (data?.plans || []).filter((item) => {
    if (commandScope.factoryId && String(item.factory_id) !== commandScope.factoryId) return false;
    if (commandScope.lineId && String(item.line_id) !== commandScope.lineId) return false;
    if (commandScope.shiftId && String(item.shift_id) !== commandScope.shiftId) return false;
    if (commandScope.dateFrom && String(item.planned_start || "") < commandScope.dateFrom) return false;
    if (commandScope.dateTo && String(item.planned_end || "") > commandScope.dateTo) return false;
    return true;
  }), [data, commandScope]);

  const mutatePlan = async (action, body = {}) => {
    if (!plan) return;
    if (!reason || reason.trim().length < 3) { setError("Add a short reason before changing the plan."); return; }
    setBusy(true); setError(null);
    try {
      await api.post(`/production-workspace/plans/${plan.id}/${action}`, { expected_version: plan.version_token, reason, ...body });
      await onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not change this plan."); }
    finally { setBusy(false); }
  };
  const addPlanInput = async (kind, body) => {
    if (!plan || !reason || reason.trim().length < 3) { setError("Add a short reason before saving."); return; }
    setBusy(true); setError(null);
    try {
      await api.post(`/production-workspace/plans/${plan.id}/${kind}`, { ...body, expected_version: plan.version_token, reason });
      await onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not save plan input."); }
    finally { setBusy(false); }
  };

  if (loading) return <Loading label="Loading production planning workspace…" />;
  if (error && !data) return <ErrorBox message={error} />;
  return <div className="space-y-4" data-testid="production-planning-workspace">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <SectionTitle title="Production Planning Workspace" subtitle="Prepare feasible, readiness-controlled line plans without changing the live Odoo tracker." />
      {(commandScope.factoryId || commandScope.lineId || commandScope.shiftId || commandScope.dateFrom || commandScope.dateTo) && <div className="mt-2 text-xs text-muted" data-testid="workspace-command-context">Showing plans in the Command Centre scope.</div>}
      <button type="button" className="btn-ghost text-xs" onClick={refresh}><ArrowsClockwise size={14} className="inline mr-1" />Refresh</button>
    </div>
    {error && <ErrorBox message={error} />}
    <ReasonBar reason={reason} setReason={setReason} />
    <div className="flex gap-1 overflow-x-auto border-b border-line">
      {[["plans", "Plans & feasibility"], ["master", "Master data"], ["bulk", "Bulk templates"]].map(([key, label]) => <button key={key} type="button" onClick={() => setActive(key)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold ${active === key ? "border-brand text-brand" : "border-transparent text-muted"}`}>{label}</button>)}
    </div>
    {active === "master" && <MasterEditor catalogues={data.catalogues} canPlan={canPlan} canApprove={canApprove} reason={reason} onSaved={onSaved} />}
    {active === "bulk" && <BulkTools reason={reason} canPlan={canPlan} onSaved={onSaved} />}
    {active === "plans" && <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2"><WorkItemForm tracker={data.tracker} stages={data.catalogues.tracker_stages} workItems={data.workItems} canPlan={canPlan} reason={reason} onSaved={onSaved} /><PlanForm workItems={data.workItems} catalogues={data.catalogues} canPlan={canPlan} reason={reason} onSaved={onSaved} /></div>
      <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <div className="card-white overflow-hidden"><div className="border-b border-line px-4 py-3"><div className="font-bold text-[#0f3d24]">Plan versions</div><div className="text-xs text-muted">Frozen versions stay unchanged; reopening creates the next revision.</div></div>
          <div className="max-h-[620px] overflow-auto">{planOptions.length === 0 ? <div className="p-8 text-center text-sm text-muted">Create a work item and draft plan to begin.</div> : planOptions.map((item) => <button key={item.id} onClick={() => setSelectedPlanId(String(item.id))} className={`block w-full border-b border-line px-4 py-3 text-left hover:bg-panel/30 ${String(item.id) === String(selectedPlanId) ? "bg-emerald-50" : ""}`}><div className="flex items-center justify-between gap-2"><span className="font-semibold text-sm">{item.external_ref}</span><Badge status={item.status} /></div><div className="mt-1 text-xs text-muted">v{item.version_no} · {item.factory_code}{item.line_code ? ` / ${item.line_code}` : ""}</div><div className="mt-1 text-xs text-muted">{item.planned_start} → {item.planned_end} · {fmt(item.planned_qty, 0)} units</div></button>)}</div>
        </div>
        {!plan ? <div className="card-white grid min-h-[300px] place-items-center p-8 text-center text-sm text-muted"><ClipboardText size={30} className="mb-2 opacity-40" />Select a plan version to review its readiness and line loading.</div> :
          <PlanDetail plan={plan} detail={detail} feasibility={feasibility} catalogues={data.catalogues} canPlan={canPlan} canApprove={canApprove} mutable={mutable} busy={busy} onAction={mutatePlan} onInput={addPlanInput} onReload={() => loadDetail(plan.id)} reason={reason} setError={setError} />}
      </div>
    </div>}
  </div>;
}

function PlanDetail({ plan, detail, feasibility, catalogues, canPlan, canApprove, mutable, busy, onAction, onInput, onReload, reason, setError }) {
  const [operation, setOperation] = useState({ operation_definition_id: "", operation_code: "", name: "", sequence_no: "", sam_minutes: "", capability_id: "", line_id: plan.line_id || "" });
  const [capacity, setCapacity] = useState({ calendar_id: "", line_id: plan.line_id || "", machine_id: "", available_minutes: "", required_minutes: "", source: "approved_calendar" });
  const [assignment, setAssignment] = useState({ operation_id: "", operator_id: "", line_id: plan.line_id || "", machine_id: "", assignment_role: "operator", planned_minutes: "" });
  const [changeover, setChangeover] = useState({ line_id: plan.line_id || "", changeover_date: plan.planned_start, minutes: "", note: "" });
  const [audit, setAudit] = useState([]);
  const gates = detail?.readiness_gates || [];
  const blockers = feasibility?.blockers || [];
  const warning = feasibility?.warnings || [];
  const lineMachines = (catalogues.machines || []).filter((m) => !plan.line_id || Number(m.line_id) === Number(plan.line_id));
  const loadAudit = async () => { try { const { data } = await api.get(`/production-workspace/audit/plan_version/${plan.id}`, { forceFresh: true }); setAudit(data.events || []); } catch { setError("Could not load the audit timeline."); } };
  const submit = (event, kind, value, setValue) => { event.preventDefault(); onInput(kind, value); if (setValue) setValue({}); };
  const submitAssignment = (event) => {
    event.preventDefault();
    const selectedOperation = (detail.operations || []).find((item) => Number(item.id) === Number(assignment.operation_id));
    if (selectedOperation?.capability_id && (!assignment.operator_id || !assignment.machine_id)) {
      setError("Choose both a qualified operator and a compatible machine for this capability-bound operation.");
      return;
    }
    onInput("assignments", { ...assignment, operation_id: asId(assignment.operation_id), operator_id: asId(assignment.operator_id), line_id: asId(assignment.line_id), machine_id: asId(assignment.machine_id), planned_minutes: num(assignment.planned_minutes) });
  };
  const removeInput = async (kind, row) => {
    if (!reason || reason.trim().length < 3) { setError("Add a short reason before correcting a plan input."); return; }
    try {
      await api.delete(`/production-workspace/plans/${plan.id}/${kind}/${row.id}`, { data: { expected_version: plan.version_token, reason } });
      onReload();
    } catch (err) { setError(err?.response?.data?.detail || "Could not remove the plan input. Refresh and try again."); }
  };
  return <div className="space-y-4">
    <div className="card-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><div className="text-lg font-bold text-[#0f3d24]">{detail?.work_item?.external_ref}</div><Badge status={plan.status} /></div><div className="mt-1 text-xs text-muted">Version {plan.version_no} · {plan.planned_start} → {plan.planned_end} · {fmt(plan.planned_qty, 0)} planned units</div></div>
      <div className="flex flex-wrap gap-2">
        {plan.status === "draft" && mutable && <button disabled={busy} className="btn-primary text-xs" onClick={() => onAction("submit")}><CheckCircle size={14} className="inline mr-1" />Submit</button>}
        {plan.status === "submitted" && canApprove && <button disabled={busy} className="btn-primary text-xs" onClick={() => onAction("approve")}>Approve</button>}
        {plan.status === "approved" && canApprove && <button disabled={busy} className="btn-primary text-xs" onClick={() => onAction("freeze")}><LockKey size={14} className="inline mr-1" />Freeze</button>}
        {plan.status === "frozen" && canApprove && <button disabled={busy} className="btn-ghost text-xs" onClick={() => onAction("reopen")}>Reopen as revision</button>}
      </div></div>
      {plan.status === "frozen" && <div className="mt-3 rounded border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800"><LockKey size={13} className="inline mr-1" />This approved operational plan is read-only. Reopening preserves this version and creates a new editable revision.</div>}
    </div>
    <div className="grid gap-3 md:grid-cols-4">
      {[
        ["Available minutes", feasibility?.available_minutes, "Saved calendar / capacity inputs"],
        ["Required minutes", feasibility?.required_minutes, "SAM demand + changeovers"],
        ["Load", feasibility?.load_pct == null ? "Incomplete" : `${feasibility.load_pct}%`, feasibility?.capacity_gap_minutes == null ? "No valid denominator" : `${fmt(feasibility.capacity_gap_minutes)} min remaining`],
        ["Readiness", `${gates.filter((gate) => ["passed", "waived"].includes(gate.status)).length}/${gates.length}`, blockers.length ? `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}` : "No submission blockers"],
      ].map(([label, value, sub]) => <div className="card-white p-3" key={label}><div className="eyebrow">{label}</div><div className="mt-1 text-xl font-extrabold text-brand">{typeof value === "number" ? fmt(value) : value ?? "—"}</div><div className="mt-1 text-[11px] text-muted">{sub}</div></div>)}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card-white p-4"><div className="font-bold text-[#0f3d24]">Feasibility checks</div>
        {blockers.length === 0 && warning.length === 0 ? <div className="mt-3 text-sm text-emerald-700"><CheckCircle size={15} className="inline mr-1" />All saved denominators are feasible.</div> : <div className="mt-3 space-y-2">{blockers.map((item, index) => <div key={`${item.code}-${index}`} className="rounded border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs text-rose-800"><WarningCircle size={13} className="inline mr-1" />{item.message}</div>)}{warning.map((item, index) => <div key={`${item.code}-${index}`} className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">{item.message}</div>)}</div>}
        {feasibility?.allocations?.length > 0 && <div className="mt-3 text-xs"><div className="font-semibold">Machine allocation</div>{feasibility.allocations.map((row) => <div className="mt-1 flex justify-between" key={row.machine_key}>Machine {row.machine_key === -1 ? "unassigned" : row.machine_key}<span>{fmt(row.assigned_minutes)} / {fmt(row.available_minutes)} min</span></div>)}</div>}
      </div>
      <div className="card-white p-4"><div className="font-bold text-[#0f3d24]">Readiness gates</div><div className="mt-3 space-y-2">{gates.map((gate) => <ReadinessGate key={gate.id} gate={gate} mutable={mutable} canPlan={canPlan} plan={plan} reason={reason} onSaved={onReload} setError={setError} />)}</div></div>
    </div>
    <div className="grid gap-4 xl:grid-cols-3">
      <InputCard title="Operations & SAM" disabled={!mutable} onSubmit={(event) => submit(event, "operations", { ...operation, operation_definition_id: asId(operation.operation_definition_id), sequence_no: num(operation.sequence_no), sam_minutes: num(operation.sam_minutes), capability_id: asId(operation.capability_id), line_id: asId(operation.line_id) })}>
        <Field label="Approved SAM definition" value={operation.operation_definition_id} onChange={(v) => setOperation((o) => ({ ...o, operation_definition_id: v }))} options={(catalogues.operation_definitions || []).filter((d) => d.active && d.status === "approved").map((d) => ({ value: d.id, label: `${d.operation_code} · ${d.name} (${fmt(d.default_sam_minutes)} min)` }))} /><Field label="Sequence" type="number" value={operation.sequence_no} onChange={(v) => setOperation((o) => ({ ...o, sequence_no: v }))} />
      </InputCard>
      <InputCard title="Capacity inputs" disabled={!mutable} onSubmit={(event) => submit(event, "capacity-inputs", { ...capacity, calendar_id: asId(capacity.calendar_id), line_id: asId(capacity.line_id), machine_id: asId(capacity.machine_id), available_minutes: num(capacity.available_minutes), required_minutes: num(capacity.required_minutes) })}>
        <Field label="Calendar date" value={capacity.calendar_id} onChange={(v) => setCapacity((o) => ({ ...o, calendar_id: v }))} options={(catalogues.calendars || []).filter((c) => Number(c.factory_id) === Number(plan.factory_id)).map((c) => ({ value: c.id, label: `${c.calendar_date} · ${fmt(c.capacity_minutes)} min` }))} /><Field label="Machine" value={capacity.machine_id} onChange={(v) => setCapacity((o) => ({ ...o, machine_id: v }))} options={lineMachines.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} /><Field label="Available minutes" type="number" value={capacity.available_minutes} onChange={(v) => setCapacity((o) => ({ ...o, available_minutes: v }))} /><Field label="Required minutes" type="number" value={capacity.required_minutes} onChange={(v) => setCapacity((o) => ({ ...o, required_minutes: v }))} />
      </InputCard>
      <InputCard title="Qualified staffing" disabled={!mutable} onSubmit={submitAssignment}>
        <Field label="Operation" value={assignment.operation_id} onChange={(v) => setAssignment((o) => ({ ...o, operation_id: v }))} options={(detail.operations || []).map((o) => ({ value: o.id, label: `${o.sequence_no}. ${o.operation_code}` }))} /><Field label="Operator" value={assignment.operator_id} onChange={(v) => setAssignment((o) => ({ ...o, operator_id: v }))} options={(catalogues.operators || []).filter((o) => o.active).map((o) => ({ value: o.id, label: `${o.operator_code} · ${o.display_name}` }))} /><Field label="Machine" value={assignment.machine_id} onChange={(v) => setAssignment((o) => ({ ...o, machine_id: v }))} options={lineMachines.filter((m) => m.active).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} /><Field label="Allocated minutes" type="number" value={assignment.planned_minutes} onChange={(v) => setAssignment((o) => ({ ...o, planned_minutes: v }))} />
      </InputCard>
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <InputCard title="Line changeover" disabled={!mutable} onSubmit={(event) => submit(event, "changeovers", { ...changeover, line_id: asId(changeover.line_id), minutes: num(changeover.minutes) })}><Field label="Date" type="date" value={changeover.changeover_date} onChange={(v) => setChangeover((o) => ({ ...o, changeover_date: v }))} /><Field label="Changeover minutes" type="number" value={changeover.minutes} onChange={(v) => setChangeover((o) => ({ ...o, minutes: v }))} /><Field label="Notes" value={changeover.note} onChange={(v) => setChangeover((o) => ({ ...o, note: v }))} /></InputCard>
      <div className="card-white p-4"><div className="flex items-center justify-between"><div className="font-bold text-[#0f3d24]">Audit timeline</div><button className="text-xs font-semibold text-brand hover:underline" onClick={loadAudit}>Load timeline</button></div><div className="mt-3 space-y-2">{audit.length === 0 ? <div className="text-xs text-muted">Load the trace for approval and change history.</div> : audit.slice(0, 8).map((item) => <div key={item.id} className="border-l-2 border-brand/30 pl-2 text-xs"><div className="font-semibold">{title(item.action)}</div><div className="text-muted">{item.actor_name || "System"} · {new Date(item.occurred_at).toLocaleString()}</div><div className="mt-0.5">{item.reason}</div></div>)}</div></div>
    </div>
    <div className="card-white p-4"><div className="font-bold text-[#0f3d24]">Saved planning inputs</div><div className="mt-3 grid gap-3 md:grid-cols-2">{[
      ["operations", detail.operations || [], (row) => `${row.sequence_no}. ${row.operation_code} · ${fmt(row.sam_minutes)} SAM`],
      ["capacity-inputs", detail.capacity_inputs || [], (row) => `${fmt(row.available_minutes)} available / ${fmt(row.required_minutes)} required min`],
      ["assignments", detail.assignments || [], (row) => `${row.operator_name || "No operator"} · ${row.machine_name || "No machine"}`],
      ["changeovers", detail.changeovers || [], (row) => `${row.changeover_date} · ${fmt(row.minutes)} min`],
    ].map(([kind, rows, label]) => <div key={kind}><div className="eyebrow">{title(kind)}</div>{rows.length === 0 ? <div className="mt-1 text-xs text-muted">None saved</div> : rows.map((row) => <div key={row.id} className="mt-1 flex items-center justify-between gap-2 text-xs"><span>{label(row)}</span>{mutable && <button className="text-rose-700 hover:underline" onClick={() => removeInput(kind, row)}>Remove</button>}</div>)}</div>)}</div></div>
  </div>;
}

function InputCard({ title, disabled, onSubmit, children }) {
  return <form className="card-white p-4" onSubmit={onSubmit}><div className="font-bold text-[#0f3d24]">{title}</div><div className="mt-3 grid gap-2">{children}</div><button disabled={disabled} className="btn-primary mt-3 text-xs disabled:opacity-40">{disabled ? "Plan locked" : "Add to plan"}</button></form>;
}

function ReadinessGate({ gate, mutable, canPlan, plan, reason, onSaved, setError }) {
  const [status, setStatus] = useState(gate.status);
  const [note, setNote] = useState(gate.note || "");
  const [evidence, setEvidence] = useState(gate.evidence_ref || gate.quality_ref || "");
  const [owner, setOwner] = useState(gate.owner_user_id || "");
  const [dueDate, setDueDate] = useState(gate.due_date || "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!reason || reason.trim().length < 3) { setError("Add a short reason before updating readiness."); return; }
    setBusy(true);
    try {
      await api.put(`/production-workspace/plans/${plan.id}/gates/${gate.gate_key}`, { status, note, evidence_ref: evidence, quality_ref: evidence, owner_user_id: owner || null, due_date: dueDate || null, expected_version: plan.version_token, reason });
      onSaved();
    } catch (err) { setError(err?.response?.data?.detail || "Could not update this readiness gate."); }
    finally { setBusy(false); }
  };
  return <div className="rounded border border-line p-2.5"><div className="flex items-center justify-between gap-2"><div className="text-xs font-semibold text-[#0f3d24]">{gate.gate_name}</div><Badge status={gate.status} /></div>
    {mutable && canPlan && <div className="mt-2 grid gap-1.5 sm:grid-cols-[120px_1fr_1fr_auto]"><select className="input-pill text-xs" value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="waived">Waived (admin)</option></select><input className="input-pill text-xs" placeholder="Evidence / reference" value={evidence} onChange={(e) => setEvidence(e.target.value)} /><input className="input-pill text-xs" placeholder="Notes / exception rationale" value={note} onChange={(e) => setNote(e.target.value)} /><button type="button" className="btn-ghost text-xs" onClick={save} disabled={busy}>{busy ? "…" : "Save"}</button><input className="input-pill text-xs" placeholder="Gate owner user ID" value={owner} onChange={(e) => setOwner(e.target.value)} /><input className="input-pill text-xs" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>}
    {!mutable && (gate.note || gate.evidence_ref || gate.quality_ref) && <div className="mt-1 text-[11px] text-muted">{gate.evidence_ref || gate.quality_ref}{gate.note ? ` · ${gate.note}` : ""}</div>}
  </div>;
}