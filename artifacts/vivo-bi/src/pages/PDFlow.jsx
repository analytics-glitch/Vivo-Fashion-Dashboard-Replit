import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { useAuth } from "@/lib/auth";
import {
  Kanban, Plus, X, ArrowRight, ArrowUUpLeft, CheckCircle, XCircle,
  GearSix, DownloadSimple, ChartBar, ClockClockwise, ArrowsClockwise, Trash,
} from "@phosphor-icons/react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  LineChart, Line, ReferenceLine,
} from "recharts";

/**
 * Product Development Flow — pre-production style kanban.
 * 9 fixed stages (Adopted → … → Final Review); each card is ONE style.
 * Reads /api/pd/board, /api/pd/analytics, /api/pd/history; writes via
 * /api/pd/styles + /api/pd/styles/{id}/move. Aging colours come from the
 * server (`aging`: ok / warning / stuck vs per-stage SLA days, admin-editable).
 */

const agingCard = (a) =>
  a === "stuck" ? "border-l-rose-400 bg-rose-50/40"
  : a === "warning" ? "border-l-amber-400 bg-amber-50/40"
  : "border-l-emerald-400 bg-emerald-50/40";

const agingBadge = (a) =>
  a === "stuck" ? "bg-rose-100 text-rose-700"
  : a === "warning" ? "bg-amber-100 text-amber-700"
  : "bg-emerald-100 text-emerald-700";

const fmtDays = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

const fmtWhen = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: "Africa/Nairobi", day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch { return "—"; }
};

const dirLabel = (d) => ({
  adopt: "Adopted", forward: "Moved forward", back: "Sent back",
  approve: "Approved", reject: "Rejected",
}[d] || d);

const downloadCsv = (name, headers, rows) => {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

// ── Static lookup data ────────────────────────────────────────────────────────
const BRANDS = ["Vivo", "Safari by Vivo", "Zoya"];
const LIFECYCLE_TYPES = ["New", "Reorder", "Replenishment"];
const PD_ASSIGNEES = [
  "Abigail","Bella","Beryl","Chantal","Emily","Felista","Florence",
  "Jewel","Marion","Mary","Maryann","Mercy","Natasha","Pech","Queen",
  "Re","Rose","Tony","Victoria","Wandia","Wanjohi","Yvonne",
];
const CATEGORY_SUBCATS = {
  ACCESSORIES:  ["Bangles & Bracelets","Belts","Body Mists & Fragrances","Earrings","Necklaces","Rings","Scarves","Shopping Bags"],
  BOTTOMS:      ["Culottes & Capri Pants","Full Length Pants","Jumpsuits & Playsuits","Leggings","Shorts & Skorts"],
  DRESSES:      ["Knee Length Dresses","Maxi Dresses","Midi & Capri Dresses","Short & Mini Dresses"],
  MENS:         ["Men's Bottoms","Men's Tops"],
  OUTERWEAR:    ["Hoodies & Sweatshirts","Jackets & Coats","Sweaters & Ponchos","Waterfalls & Kimonos"],
  SALE:         ["Sample & Sale Items"],
  SKIRTS:       ["Knee Length Skirts","Maxi Skirts","Midi & Capri Skirts","Short & Mini Skirts"],
  TOPS:         ["Bodysuits","Fitted Tops","Loose Tops","Midriff & Crop Tops","T-shirts & Tank Tops"],
};

// ── Add style dialog ─────────────────────────────────────────────────────────
const AddStyleDialog = ({ onClose, onSaved }) => {
  const EMPTY = { style_name: "", style_number: "", brand: "", category: "", sub_category: "", lifecycle_type: "", assignee_name: "", decisions: "" };
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v, ...(k === "category" ? { sub_category: "" } : {}) }));
  const subcats = CATEGORY_SUBCATS[form.category] || [];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post("/pd/styles", {
        style_name:     form.style_name,
        style_number:   form.style_number   || null,
        brand:          form.brand          || null,
        category:       form.category       || null,
        sub_category:   form.sub_category   || null,
        lifecycle_type: form.lifecycle_type || null,
        assignee_name:  form.assignee_name  || null,
        decisions:      form.decisions      || null,
      });
      onSaved();
    } catch (ex) {
      setErr(ex?.response?.data?.detail || ex.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        data-testid="pd-add-dialog">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-[15px]">Add adopted style</h3>
          <button type="button" onClick={onClose} className="text-muted hover:text-foreground"><X size={16} /></button>
        </div>

        <input className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" placeholder="Style name *" required
          value={form.style_name} onChange={(e) => set("style_name", e.target.value)} data-testid="pd-add-name" />

        <input className="w-full px-3 py-2 rounded-lg border border-border text-[13px] font-mono" placeholder="Style number *" required
          value={form.style_number} onChange={(e) => set("style_number", e.target.value)} />

        <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" required
          value={form.brand} onChange={(e) => set("brand", e.target.value)} data-testid="pd-add-brand">
          <option value="">Brand *</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" required
          value={form.category} onChange={(e) => set("category", e.target.value)}>
          <option value="">Category *</option>
          {Object.keys(CATEGORY_SUBCATS).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        {form.category && (
          <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" required
            value={form.sub_category} onChange={(e) => set("sub_category", e.target.value)}>
            <option value="">Sub-category *</option>
            {subcats.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

        <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" required
          value={form.lifecycle_type} onChange={(e) => set("lifecycle_type", e.target.value)}>
          <option value="">Type — New / Reorder / Replenishment *</option>
          {LIFECYCLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" required
          value={form.assignee_name} onChange={(e) => set("assignee_name", e.target.value)}
          data-testid="pd-add-assignee">
          <option value="">Assignee *</option>
          {PD_ASSIGNEES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>

        <textarea className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" rows={3} required
          placeholder="Adoption decisions made… *"
          value={form.decisions} onChange={(e) => set("decisions", e.target.value)} data-testid="pd-add-decisions" />

        {err && <div className="text-danger text-[12px]">{err}</div>}
        <button type="submit" disabled={busy}
          className="w-full py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep disabled:opacity-50"
          data-testid="pd-add-submit">
          {busy ? "Saving…" : "Add to Adopted"}
        </button>
      </form>
    </div>
  );
};

// ── Move dialog (forward / send back / approve / reject) ────────────────────
const MoveDialog = ({ card, stages, users, onClose, onSaved }) => {
  const idx = stages.findIndex((s) => s.stage_key === card.current_stage);
  const nextStage = stages[idx + 1];
  const isFinal = card.current_stage === "final_review";
  const earlier = stages.slice(0, idx);
  const [action, setAction] = useState(isFinal ? "approve" : "forward");
  const [toStage, setToStage] = useState(earlier.length ? earlier[earlier.length - 1].stage_key : "");
  const [assignee, setAssignee] = useState("");
  const [decisions, setDecisions] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const targetStage = action === "forward" ? nextStage : stages.find((s) => s.stage_key === toStage);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post(`/pd/styles/${card.id}/move`, {
        action,
        to_stage: action === "forward" ? nextStage?.stage_key : toStage,
        assignee_user_id: assignee || null,
        decisions,
      });
      onSaved();
    } catch (ex) {
      setErr(ex?.response?.data?.detail || ex.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3" data-testid="pd-move-dialog">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-[15px]">{card.style_name}</h3>
          <button type="button" onClick={onClose} className="text-muted hover:text-foreground"><X size={16} /></button>
        </div>
        <div className="text-[12px] text-muted">
          Currently in <span className="font-semibold capitalize">{String(card.current_stage).replace(/_/g, " ")}</span>
          {" · "}{fmtDays(card.days_in_stage)}d in stage
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!isFinal && nextStage && (
            <button type="button" onClick={() => setAction("forward")}
              className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md border inline-flex items-center gap-1 ${action === "forward" ? "bg-brand text-white border-brand" : "border-border text-muted"}`}
              data-testid="pd-move-forward-btn">
              <ArrowRight size={12} /> Forward to {nextStage.stage_name}
            </button>
          )}
          {isFinal && (
            <>
              <button type="button" onClick={() => setAction("approve")}
                className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md border inline-flex items-center gap-1 ${action === "approve" ? "bg-brand text-white border-brand" : "border-border text-muted"}`}
                data-testid="pd-approve-btn">
                <CheckCircle size={12} /> Approve
              </button>
              <button type="button" onClick={() => setAction("reject")}
                className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md border inline-flex items-center gap-1 ${action === "reject" ? "bg-rose-600 text-white border-rose-600" : "border-border text-muted"}`}
                data-testid="pd-reject-btn">
                <XCircle size={12} /> Reject / rework
              </button>
            </>
          )}
          {earlier.length > 0 && !isFinal && (
            <button type="button" onClick={() => setAction("back")}
              className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md border inline-flex items-center gap-1 ${action === "back" ? "bg-amber-500 text-white border-amber-500" : "border-border text-muted"}`}
              data-testid="pd-sendback-btn">
              <ArrowUUpLeft size={12} /> Send back
            </button>
          )}
        </div>
        {(action === "back" || action === "reject") && (
          <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]"
            value={toStage} onChange={(e) => setToStage(e.target.value)} data-testid="pd-move-target">
            {earlier.map((s) => <option key={s.stage_key} value={s.stage_key}>{s.stage_name}</option>)}
          </select>
        )}
        {action !== "approve" && (
          <div>
            <select className="w-full px-3 py-2 rounded-lg border border-border text-[13px]"
              value={assignee} onChange={(e) => setAssignee(e.target.value)} data-testid="pd-move-assignee">
              <option value="">{targetStage ? `Assignee for ${targetStage.stage_name}` : "Assignee"} (optional)</option>
              {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
            </select>
            {targetStage?.default_role && (
              <div className="mt-1 text-[10.5px] text-muted">Default owner role: {targetStage.default_role}</div>
            )}
          </div>
        )}
        <textarea className="w-full px-3 py-2 rounded-lg border border-border text-[13px]" rows={3}
          placeholder={action === "back" || action === "reject" ? "Reason (required)…" : "Decisions made…"}
          value={decisions} onChange={(e) => setDecisions(e.target.value)} data-testid="pd-move-decisions" />
        {err && <div className="text-danger text-[12px]">{err}</div>}
        <button type="submit" disabled={busy}
          className="w-full py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep disabled:opacity-50"
          data-testid="pd-move-submit">
          {busy ? "Saving…" : action === "approve" ? "Approve & archive" : action === "reject" ? "Reject & send back" : action === "back" ? "Send back" : "Move forward"}
        </button>
      </form>
    </div>
  );
};

// ── Detail drawer with the stage timeline ────────────────────────────────────
const DetailDrawer = ({ styleId, onClose, onMove }) => {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setData(null); setErr(null);
    api.get(`/pd/styles/${styleId}`, { forceFresh: true })
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  }, [styleId]);
  const st = data?.style;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-lg h-full overflow-y-auto p-5 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="pd-detail-drawer">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-extrabold text-[16px]">{st ? st.style_name : "Loading…"}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground"><X size={18} /></button>
        </div>
        {err && <ErrorBox message={err} />}
        {!data && !err && <Loading />}
        {st && (
          <>
            <div className="flex flex-wrap gap-1.5 text-[11.5px] mb-3">
              {st.brand && <span className="pill-neutral">{st.brand}</span>}
              {st.category && <span className="pill-neutral">{st.category}</span>}
              <span className={st.status === "completed" ? "pill-green" : "pill-amber"}>
                {st.status === "completed" ? "Completed (approved)" : `In ${String(st.current_stage).replace(/_/g, " ")}`}
              </span>
              {st.assignee_name && <span className="pill-neutral">Assignee: {st.assignee_name}</span>}
            </div>
            {st.status === "active" && (
              <button onClick={() => onMove(st)}
                className="mb-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white font-semibold text-[12px] hover:bg-brand-deep"
                data-testid="pd-detail-move-btn">
                <ArrowRight size={13} /> Move / decide
              </button>
            )}
            <SectionTitle title="Stage timeline" subtitle="Every stage visit — entry, exit, duration, assignee, decisions and who moved it" />
            <div className="space-y-2 mt-2">
              {data.timeline.map((t, i) => (
                <div key={i} className="rounded-lg border border-line p-3 bg-white" data-testid={`pd-timeline-${i}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[12.5px]">{t.stage_name}</span>
                    <span className="text-[11px] font-semibold text-muted">
                      {t.duration_days != null ? `${fmtDays(t.duration_days)}d` : ""}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">
                    {fmtWhen(t.entered_at)} → {t.exited_at ? fmtWhen(t.exited_at) : "now"}
                  </div>
                  <div className="text-[11px] mt-1">
                    <span className="text-muted">Entered via:</span> {dirLabel(t.direction)} by {t.moved_by || "—"}
                    {t.assignee_name && <> · <span className="text-muted">assignee:</span> {t.assignee_name}</>}
                  </div>
                  {t.decisions && <div className="text-[11.5px] mt-1.5 bg-slate-50 rounded-md p-2 whitespace-pre-wrap">{t.decisions}</div>}
                  {t.exit_direction && (
                    <div className="text-[10.5px] text-muted mt-1">Left stage: {dirLabel(t.exit_direction)} by {t.exited_by || "—"}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ── Admin SLA settings dialog ────────────────────────────────────────────────
const SlaDialog = ({ stages, onClose, onSaved }) => {
  const [rows, setRows] = useState(stages.map((s) => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      for (const r of rows) {
        const orig = stages.find((s) => s.stage_key === r.stage_key);
        if (Number(r.sla_days) !== Number(orig.sla_days) || (r.default_role || "") !== (orig.default_role || "")) {
          await api.patch(`/pd/stages/${r.stage_key}`, { sla_days: Number(r.sla_days), default_role: r.default_role });
        }
      }
      onSaved();
    } catch (ex) {
      setErr(ex?.response?.data?.detail || ex.message);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()} data-testid="pd-sla-dialog">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-extrabold text-[15px]">Stage targets (SLA days)</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground"><X size={16} /></button>
        </div>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {rows.map((r, i) => (
            <div key={r.stage_key} className="grid grid-cols-[1fr_90px_1fr] gap-2 items-center">
              <span className="text-[12.5px] font-semibold">{r.stage_name}</span>
              <input type="number" min={1} max={365} className="px-2 py-1.5 rounded-lg border border-border text-[12.5px]"
                value={r.sla_days}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, sla_days: e.target.value } : x)))}
                data-testid={`pd-sla-${r.stage_key}`} />
              <input className="px-2 py-1.5 rounded-lg border border-border text-[12.5px]" placeholder="Default owner role"
                value={r.default_role || ""}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, default_role: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        {err && <div className="text-danger text-[12px] mt-2">{err}</div>}
        <button onClick={save} disabled={busy}
          className="mt-4 w-full py-2 rounded-lg bg-brand text-white font-semibold text-[13px] hover:bg-brand-deep disabled:opacity-50"
          data-testid="pd-sla-save">
          {busy ? "Saving…" : "Save targets"}
        </button>
      </div>
    </div>
  );
};

// ── Analytics tab ─────────────────────────────────────────────────────────────
const AnalyticsTab = ({ onOpenStyle }) => {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get("/pd/analytics", { forceFresh: true })
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  }, []);
  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  const sd = data.stage_durations.filter((s) => s.count > 0);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card-white p-5" data-testid="pd-stage-durations">
          <SectionTitle title="Days per stage" subtitle="Average and median days spent in each stage (completed visits)"
            action={
              <button className="text-[11px] text-muted hover:text-brand inline-flex items-center gap-1"
                onClick={() => downloadCsv("pd_stage_durations.csv",
                  ["stage", "sla_days", "visits", "avg_days", "median_days"],
                  data.stage_durations.map((s) => [s.stage_name, s.sla_days, s.count, s.avg_days, s.median_days]))}>
                <DownloadSimple size={12} /> CSV
              </button>
            } />
          {sd.length === 0 ? <Empty label="No completed stage visits yet." /> : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={sd} margin={{ top: 8, right: 8, left: 0, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="stage_name" angle={-30} textAnchor="end" interval={0} tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="avg_days" name="Avg days" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                <Bar dataKey="median_days" name="Median days" fill="#d97706" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card-white p-5" data-testid="pd-cycle-trend">
          <SectionTitle title="Cycle time trend" subtitle="Average days from Adopted to Final Review, by completion month"
            action={
              <button className="text-[11px] text-muted hover:text-brand inline-flex items-center gap-1"
                onClick={() => downloadCsv("pd_cycle_times.csv",
                  ["style", "brand", "completed_at", "cycle_days"],
                  data.cycle_times.map((c) => [c.style_name, c.brand, c.completed_at, c.cycle_days]))}>
                <DownloadSimple size={12} /> CSV
              </button>
            } />
          {data.cycle_trend.length === 0 ? <Empty label="No completed styles yet." /> : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data.cycle_trend} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Line type="monotone" dataKey="avg_cycle_days" name="Avg cycle days" stroke="#1a5c38" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="card-white p-5" data-testid="pd-stuck-table">
        <SectionTitle title="Stuck styles" subtitle="Styles over their stage's target duration — worst first" />
        {data.stuck_styles.length === 0 ? <Empty label="Nothing is stuck. All styles are within their stage targets." /> : (
          <SortableTable
            testId="pd-stuck" exportName="pd_stuck_styles.csv"
            initialSort={{ key: "days_overdue", dir: "desc" }}
            columns={[
              { key: "style_name", label: "Style", align: "left", render: (r) => (
                <button className="font-semibold text-brand hover:underline" onClick={() => onOpenStyle(r.id)}>{r.style_name}</button>) },
              { key: "brand", label: "Brand", align: "left", render: (r) => r.brand || "—" },
              { key: "current_stage", label: "Stage", align: "left", render: (r) => <span className="capitalize">{String(r.current_stage).replace(/_/g, " ")}</span> },
              { key: "assignee_name", label: "Assignee", align: "left", render: (r) => r.assignee_name || "Unassigned" },
              { key: "days_in_stage", label: "Days in stage", align: "right" },
              { key: "sla_days", label: "Target", align: "right" },
              { key: "days_overdue", label: "Overdue", align: "right", render: (r) => (
                <span className="pill-red">{fmtDays(r.days_overdue)}d</span>) },
            ]}
            rows={data.stuck_styles}
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card-white p-5" data-testid="pd-workload">
          <SectionTitle title="Per-assignee workload" subtitle="Active styles each person currently holds" />
          {data.workload.length === 0 ? <Empty label="No active styles." /> : (
            <SortableTable
              testId="pd-workload-table" exportName="pd_workload.csv"
              initialSort={{ key: "active_styles", dir: "desc" }}
              columns={[
                { key: "assignee", label: "Assignee", align: "left" },
                { key: "active_styles", label: "Active styles", align: "right" },
                { key: "avg_days_holding", label: "Avg days holding", align: "right" },
              ]}
              rows={data.workload}
            />
          )}
        </div>
        <div className="card-white p-5" data-testid="pd-turnaround">
          <SectionTitle title="Per-assignee turnaround" subtitle="Average and median days to move work on (completed stage visits)" />
          {data.assignee_turnaround.length === 0 ? <Empty label="No completed stage visits yet." /> : (
            <SortableTable
              testId="pd-turnaround-table" exportName="pd_turnaround.csv"
              initialSort={{ key: "avg_days", dir: "desc" }}
              columns={[
                { key: "assignee", label: "Assignee", align: "left" },
                { key: "count", label: "Stage visits", align: "right" },
                { key: "avg_days", label: "Avg days", align: "right" },
                { key: "median_days", label: "Median days", align: "right" },
              ]}
              rows={data.assignee_turnaround}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ── History tab ───────────────────────────────────────────────────────────────
const HistoryTab = ({ isAdmin }) => {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState("");
  const [lcFilter, setLcFilter] = useState("");
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    api.get("/pd/history", { forceFresh: true })
      .then((r) => setRows(r.data.movements || []))
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  }, []);

  const deleteMov = async (id) => {
    if (!window.confirm("Delete this log entry? This cannot be undone.")) return;
    setDeleting(id);
    try {
      await api.delete(`/pd/movements/${id}`);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (ex) {
      alert(ex?.response?.data?.detail || ex.message);
    } finally {
      setDeleting(null);
    }
  };

  if (err) return <ErrorBox message={err} />;
  if (!rows) return <Loading />;

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (q && !(`${r.style_name || ""} ${r.style_number || ""}`.toLowerCase().includes(q))) return false;
    if (lcFilter && r.lifecycle_type !== lcFilter) return false;
    return true;
  });

  return (
    <div className="card-white p-5" data-testid="pd-history">
      <SectionTitle title="Movement & decision log"
        subtitle="Audit of every adoption, move, send-back, approval and rejection" />
      <div className="flex flex-wrap gap-2 mb-3">
        <input className="px-3 py-1.5 rounded-lg border border-border text-[12.5px] w-60"
          placeholder="Search style name or style no."
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="px-3 py-1.5 rounded-lg border border-border text-[12.5px]"
          value={lcFilter} onChange={(e) => setLcFilter(e.target.value)}>
          <option value="">All types</option>
          {LIFECYCLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {filtered.length === 0
        ? <Empty label={rows.length === 0 ? "No movements yet." : "No results for this filter."} />
        : (
          <SortableTable
            testId="pd-history-table" exportName="pd_movement_log.csv"
            initialSort={{ key: "created_at", dir: "desc" }}
            columns={[
              { key: "created_at", label: "When", align: "left", render: (r) => fmtWhen(r.created_at) },
              { key: "style_name", label: "Style", align: "left" },
              { key: "style_number", label: "Style No.", align: "left",
                render: (r) => <span className="font-mono text-[12px] text-muted">{r.style_number || "—"}</span> },
              { key: "lifecycle_type", label: "Type", align: "left",
                render: (r) => r.lifecycle_type
                  ? <span className="pill-neutral">{r.lifecycle_type}</span>
                  : <span className="text-muted">—</span> },
              { key: "direction", label: "Action", align: "left", render: (r) => (
                <span className={r.direction === "back" || r.direction === "reject" ? "pill-red" : r.direction === "approve" ? "pill-green" : "pill-neutral"}>{dirLabel(r.direction)}</span>) },
              { key: "from_stage", label: "From", align: "left",
                render: (r) => <span className="capitalize">{String(r.from_stage || "—").replace(/_/g, " ")}</span> },
              { key: "to_stage", label: "To", align: "left",
                render: (r) => <span className="capitalize">{String(r.to_stage || "—").replace(/_/g, " ")}</span> },
              { key: "assignee_name", label: "Assignee", align: "left", render: (r) => r.assignee_name || "—" },
              { key: "moved_by_name", label: "By", align: "left" },
              { key: "decisions", label: "Decisions / reason", align: "left",
                render: (r) => <span className="text-[11.5px] whitespace-pre-wrap">{r.decisions || "—"}</span> },
              ...(isAdmin ? [{
                key: "_del", label: "", align: "right",
                render: (r) => (
                  <button onClick={() => deleteMov(r.id)} disabled={deleting === r.id}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 hover:text-rose-800 disabled:opacity-40"
                    title="Delete this log entry">
                    <Trash size={12} />{deleting === r.id ? "…" : "Delete"}
                  </button>
                ),
                csv: () => "",
              }] : []),
            ]}
            rows={filtered}
          />
        )}
    </div>
  );
};

// ── Completed tab ─────────────────────────────────────────────────────────────
const CompletedTab = ({ onOpenStyle }) => {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get("/pd/completed", { forceFresh: true })
      .then((r) => setRows(r.data.styles || []))
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  }, []);
  if (err) return <ErrorBox message={err} />;
  if (!rows) return <Loading />;
  return (
    <div className="card-white p-5" data-testid="pd-completed">
      <SectionTitle title="Completed styles" subtitle="Approved at Final Review — archived off the active board, full history retained" />
      {rows.length === 0 ? <Empty label="No completed styles yet." /> : (
        <SortableTable
          testId="pd-completed-table" exportName="pd_completed_styles.csv"
          initialSort={{ key: "completed_at", dir: "desc" }}
          columns={[
            { key: "style_name", label: "Style", align: "left", render: (r) => (
              <button className="font-semibold text-brand hover:underline" onClick={() => onOpenStyle(r.id)}>{r.style_name}</button>) },
            { key: "brand", label: "Brand", align: "left", render: (r) => r.brand || "—" },
            { key: "category", label: "Category", align: "left", render: (r) => r.category || "—" },
            { key: "created_at", label: "Adopted", align: "left", render: (r) => fmtWhen(r.created_at) },
            { key: "completed_at", label: "Approved", align: "left", render: (r) => fmtWhen(r.completed_at) },
            { key: "cycle_days", label: "Cycle days", align: "right", render: (r) => r.cycle_days != null ? fmtDays(r.cycle_days) : "—" },
          ]}
          rows={rows}
        />
      )}
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────
const TABS = [
  { key: "board", label: "Board", icon: Kanban },
  { key: "analytics", label: "Analytics & Bottlenecks", icon: ChartBar },
  { key: "completed", label: "Completed", icon: CheckCircle },
  { key: "history", label: "History Log", icon: ClockClockwise },
];

const PDFlow = () => {
  const { user } = useAuth();
  const isAdmin = (user?.role || "").toLowerCase() === "admin";
  const [tab, setTab] = useState("board");
  const [board, setBoard] = useState(null);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(null);   // card being moved
  const [detail, setDetail] = useState(null);   // style id in the drawer
  const [slaOpen, setSlaOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    api.get("/pd/board", { forceFresh: true })
      .then((r) => { setBoard(r.data); setErr(null); })
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
    api.get("/pd/assignees").then((r) => setUsers(r.data.users || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const refresh = () => { setRefreshKey((k) => k + 1); setAdding(false); setMoving(null); };

  const cardsByStage = useMemo(() => {
    if (!board) return {};
    const q = search.trim().toLowerCase();
    const out = {};
    for (const c of board.cards) {
      if (q && !(`${c.style_name} ${c.brand || ""} ${c.assignee_name || ""}`.toLowerCase().includes(q))) continue;
      (out[c.current_stage] = out[c.current_stage] || []).push(c);
    }
    return out;
  }, [board, search]);

  const exportBoard = () => {
    if (!board) return;
    downloadCsv("pd_board.csv",
      ["style", "brand", "category", "stage", "assignee", "days_in_stage", "sla_days", "aging", "adopted_at"],
      board.cards.map((c) => [c.style_name, c.brand, c.category, c.current_stage, c.assignee_name, c.days_in_stage, c.sla_days, c.aging, c.created_at]));
  };

  return (
    <div className="space-y-4" data-testid="pd-flow-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-extrabold flex items-center gap-2">
            <Kanban size={20} className="text-brand" /> Product Development Flow
          </h1>
          <p className="text-muted text-[12.5px]">
            Every adopted style through Pattern, Sampling, Review, Pattern Transfer, CAD, Buying, Set Sample and Final Review — with assignees, stage aging and a full audit log.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button onClick={() => setSlaOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-[12.5px] font-semibold text-muted hover:text-foreground"
              data-testid="pd-sla-btn">
              <GearSix size={14} /> Stage targets
            </button>
          )}
          <button onClick={exportBoard}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-[12.5px] font-semibold text-muted hover:text-foreground"
            data-testid="pd-export-board">
            <DownloadSimple size={14} /> Export board
          </button>
          <button onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand text-white font-semibold text-[12.5px] hover:bg-brand-deep"
            data-testid="pd-add-btn">
            <Plus size={14} weight="bold" /> Add adopted style
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border ${tab === t.key ? "bg-brand text-white border-brand" : "border-border text-muted hover:text-foreground"}`}
            data-testid={`pd-tab-${t.key}`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
        {tab === "board" && (
          <>
            <input className="ml-auto px-3 py-1.5 rounded-lg border border-border text-[12.5px] w-56"
              placeholder="Search style, brand, assignee…"
              value={search} onChange={(e) => setSearch(e.target.value)} data-testid="pd-search" />
            <button onClick={load} title="Refresh" className="text-muted hover:text-foreground p-1.5" data-testid="pd-refresh">
              <ArrowsClockwise size={15} />
            </button>
          </>
        )}
      </div>

      {err && <ErrorBox message={err} />}

      {tab === "board" && !board && !err && <Loading />}
      {tab === "board" && board && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {board.stages.map((s) => {
              const cards = cardsByStage[s.stage_key] || [];
              return (
                <div key={s.stage_key} className="w-[240px] shrink-0 rounded-xl bg-slate-50 border border-line flex flex-col"
                  data-testid={`pd-col-${s.stage_key}`}>
                  <div className="px-3 py-2.5 border-b border-line">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[12.5px]">{s.stage_name}</span>
                      <span className="text-[11px] font-semibold text-muted">{cards.length}</span>
                    </div>
                    <div className="text-[10px] text-muted mt-0.5">
                      target {s.sla_days}d{s.default_role ? ` · ${s.default_role}` : ""}
                    </div>
                  </div>
                  <div className="p-2 space-y-2 min-h-[120px]">
                    {cards.map((c) => (
                      <button key={c.id} onClick={() => setDetail(c.id)}
                        className={`w-full text-left rounded-lg border border-line border-l-4 bg-white hover:shadow-sm transition p-2.5 ${agingCard(c.aging)}`}
                        data-testid={`pd-card-${c.id}`}>
                        <div className="font-bold text-[12px] leading-tight">{c.style_name}</div>
                        <div className="text-[10.5px] text-muted mt-0.5">
                          {[c.brand, c.category].filter(Boolean).join(" · ") || "—"}
                        </div>
                        <div className="flex items-center justify-between mt-1.5">
                          <span className="text-[10.5px] text-muted truncate max-w-[120px]">{c.assignee_name || "Unassigned"}</span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${agingBadge(c.aging)}`}>
                            {fmtDays(c.days_in_stage)}d
                          </span>
                        </div>
                        <div className="mt-1.5 flex justify-end">
                          <span onClick={(e) => { e.stopPropagation(); setMoving(c); }}
                            className="text-[10.5px] font-semibold text-brand hover:underline inline-flex items-center gap-0.5"
                            data-testid={`pd-card-move-${c.id}`}>
                            Move <ArrowRight size={10} />
                          </span>
                        </div>
                      </button>
                    ))}
                    {cards.length === 0 && <div className="text-[10.5px] text-muted italic text-center py-4">Empty</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "analytics" && <AnalyticsTab key={refreshKey} onOpenStyle={setDetail} />}
      {tab === "completed" && <CompletedTab key={refreshKey} onOpenStyle={setDetail} />}
      {tab === "history" && <HistoryTab key={refreshKey} isAdmin={isAdmin} />}

      {adding && <AddStyleDialog onClose={() => setAdding(false)} onSaved={refresh} />}
      {moving && board && (
        <MoveDialog card={moving} stages={board.stages} users={users}
          onClose={() => setMoving(null)} onSaved={() => { refresh(); setDetail(null); }} />
      )}
      {detail != null && (
        <DetailDrawer styleId={detail} onClose={() => setDetail(null)}
          onMove={(st) => { setMoving(st); }} />
      )}
      {slaOpen && board && (
        <SlaDialog stages={board.stages} onClose={() => setSlaOpen(false)}
          onSaved={() => { setSlaOpen(false); refresh(); }} />
      )}
    </div>
  );
};

export default PDFlow;
