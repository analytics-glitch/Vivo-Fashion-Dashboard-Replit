import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { useAuth } from "@/lib/auth";
import {
  Kanban, Plus, X, ArrowRight, ArrowUUpLeft, CheckCircle, XCircle,
  GearSix, DownloadSimple, ChartBar, ClockClockwise, ArrowsClockwise, Trash, Rows, PencilSimple, UploadSimple,
  ChartPieSlice, PaperPlaneTilt, Note,
} from "@phosphor-icons/react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  LineChart, Line, ReferenceLine,
} from "recharts";

/**
 * Product Development Flow — pre-production style kanban.
 * 9 fixed stages (Adopted → … → Set Sample Final Review); each card is ONE style.
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
  "Abigail","Bella","Beryl","CAD","Chantal","Emily","Felista","Florence",
  "Jewel","Marion","Mary","Maryann","Mercy","Natasha","Pech","Queen",
  "Re","Rose","Tony","Victoria","Wandia","Wanjohi","Yvonne",
];
const PD_STYLE_DELETE_EMAIL = "marynyambura@vivofashiongroup.com";
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
const MoveDialog = ({ card, stages, onClose, onSaved }) => {
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
        assignee_name: assignee || null,
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
              <option value="">{targetStage ? `Assignee for ${targetStage.stage_name}` : "Assignee"}</option>
              {PD_ASSIGNEES.map((n) => <option key={n} value={n}>{n}</option>)}
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

// ── Style photo panel ─────────────────────────────────────────────────────────
const StyleImage = ({ styleId, styleName }) => {
  const [blobUrl, setBlobUrl] = useState(null);   // null = loading, "" = no image
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState(null);
  const fileRef = useRef(null);
  const prevBlobRef = useRef(null);

  // Fetch the image through the authenticated API client so the Bearer token is sent.
  const fetchImage = useCallback(async () => {
    try {
      const res = await api.get(`/pd/styles/${styleId}/image`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current);
      prevBlobRef.current = url;
      setBlobUrl(url);
    } catch {
      setBlobUrl("");   // 404 = no image yet
    }
  }, [styleId]);

  useEffect(() => {
    fetchImage();
    return () => { if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current); };
  }, [fetchImage]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadErr(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api.post(`/pd/styles/${styleId}/image`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await fetchImage();
    } catch (err) {
      setUploadErr(err?.response?.data?.detail || err.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleRemove = async () => {
    if (!window.confirm("Remove this photo?")) return;
    try {
      await api.delete(`/pd/styles/${styleId}/image`);
      if (prevBlobRef.current) { URL.revokeObjectURL(prevBlobRef.current); prevBlobRef.current = null; }
      setBlobUrl("");
    } catch (err) {
      setUploadErr(err?.response?.data?.detail || err.message);
    }
  };

  return (
    <div className="mb-4" data-testid="pd-style-image">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
      {blobUrl === null ? (
        /* loading */
        <div className="w-full rounded-lg border border-line bg-slate-50 h-20 animate-pulse" />
      ) : blobUrl ? (
        <div className="relative rounded-lg overflow-hidden border border-line bg-slate-50">
          <img src={blobUrl} alt={styleName} className="w-full object-cover max-h-56" />
          <div className="absolute top-2 right-2 flex gap-1.5">
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="text-[10.5px] font-semibold bg-white/90 rounded-md px-2 py-0.5 shadow-sm hover:bg-white border border-line">
              {uploading ? "Uploading…" : "Replace"}
            </button>
            <button onClick={handleRemove}
              className="text-[10.5px] font-semibold bg-white/90 rounded-md px-2 py-0.5 shadow-sm hover:bg-white border border-line text-red-600">
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
          className="w-full rounded-lg border-2 border-dashed border-border bg-slate-50 hover:bg-slate-100 transition flex flex-col items-center justify-center gap-1.5 py-8 text-muted"
          data-testid="pd-image-upload-btn">
          <UploadSimple size={22} />
          <span className="text-[12px] font-medium">{uploading ? "Uploading…" : "Upload photo"}</span>
          <span className="text-[10.5px]">JPG, PNG or WebP · max 10 MB</span>
        </button>
      )}
      {uploadErr && <p className="mt-1.5 text-[11.5px] text-red-600">{uploadErr}</p>}
    </div>
  );
};

// ── Per-style stage notes ─────────────────────────────────────────────────────
const StageNotes = ({ styleId, currentStage, stages }) => {
  const [notes, setNotes]   = useState(null);
  const [draft, setDraft]   = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState(null);

  const stageNameMap = useMemo(
    () => Object.fromEntries((stages || []).map((s) => [s.stage_key, s.stage_name])),
    [stages],
  );

  const load = useCallback(() => {
    api.get(`/pd/styles/${styleId}/notes`, { forceFresh: true })
      .then((r) => setNotes(r.data.notes || []))
      .catch(() => setNotes([]));
  }, [styleId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true); setErr(null);
    try {
      await api.post(`/pd/styles/${styleId}/notes`, { stage_key: currentStage, note: text });
      setDraft("");
      load();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Could not save note");
    } finally {
      setSaving(false);
    }
  };

  const stageName = stageNameMap[currentStage] || String(currentStage).replace(/_/g, " ");

  return (
    <div>
      <SectionTitle
        title="Stage notes"
        subtitle="Notes tied to each stage — visible to the whole team"
        icon={<Note size={14} />}
      />

      {/* compose area */}
      <div className="mt-2 mb-3 rounded-lg border border-line bg-slate-50 p-3">
        <div className="text-[10.5px] text-muted font-medium mb-1">
          Adding note for: <span className="font-bold text-foreground">{stageName}</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
          placeholder={`Type a note for ${stageName}… (Ctrl+Enter to save)`}
          rows={3}
          className="w-full px-2.5 py-1.5 rounded-lg border border-border text-[12px] bg-white
                     focus:outline-none focus:ring-1 focus:ring-brand resize-none"
        />
        {err && <p className="text-[11px] text-red-600 mt-0.5">{err}</p>}
        <button
          onClick={submit}
          disabled={saving || !draft.trim()}
          className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white
                     text-[12px] font-semibold hover:bg-brand-deep disabled:opacity-40 transition"
        >
          <PaperPlaneTilt size={13} />
          {saving ? "Saving…" : "Add note"}
        </button>
      </div>

      {/* notes list */}
      {notes === null ? (
        <Loading />
      ) : notes.length === 0 ? (
        <p className="text-[11.5px] text-muted italic">No notes yet — be the first to add one.</p>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-line p-2.5 bg-white">
              <div className="flex items-start justify-between gap-2 mb-1.5 flex-wrap">
                <span className="text-[10.5px] font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded-full shrink-0">
                  {stageNameMap[n.stage_key] || n.stage_key}
                </span>
                <span className="text-[10.5px] text-muted leading-tight text-right">
                  {n.created_by_name || n.created_by_email || "Unknown"} · {fmtWhen(n.created_at)}
                </span>
              </div>
              <p className="text-[12px] whitespace-pre-wrap leading-relaxed">{n.note}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Tiny form field helpers ───────────────────────────────────────────────────
const FField = ({ label, name, value, onChange, type = "text", placeholder = "" }) => (
  <div className="flex flex-col gap-0.5">
    <label className="text-[10.5px] text-muted font-medium">{label}</label>
    <input
      type={type} name={name} value={value ?? ""} placeholder={placeholder}
      onChange={(e) => onChange(name, e.target.value)}
      className="px-2.5 py-1.5 rounded-lg border border-border text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-brand"
    />
  </div>
);

// ── Detail drawer with the stage timeline ────────────────────────────────────
const DetailDrawer = ({ styleId, onClose, onMove, onRefreshBoard, allStages, canDelete }) => {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState(null);

  const load = () => {
    setData(null); setErr(null); setEditing(false);
    api.get(`/pd/styles/${styleId}`, { forceFresh: true })
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  };
  useEffect(load, [styleId]);

  const startEdit = (st) => {
    setForm({
      style_name: st.style_name || "",
      style_number: st.style_number || "",
      brand: st.brand || "",
      category: st.category || "",
      sub_category: st.sub_category || "",
      lifecycle_type: st.lifecycle_type || "",
      pattern_maker: st.pattern_maker || "",
      cad: st.cad || "",
      target_order_week: st.target_order_week || "",
      fabric_type: st.fabric_type || "",
      fabric_name: st.fabric_name || "",
      sample_colour: st.sample_colour || "",
      theme: st.theme || "",
      print_solid: st.print_solid || "",
      adoption_date: st.adoption_date ? st.adoption_date.slice(0, 10) : "",
      order_date: st.order_date ? st.order_date.slice(0, 10) : "",
      sample_approval_date: st.sample_approval_date ? st.sample_approval_date.slice(0, 10) : "",
    });
    setSaveErr(null);
    setEditing(true);
  };

  const setField = (name, val) => setForm((f) => ({ ...f, [name]: val }));

  const save = async () => {
    if (!form.style_name?.trim()) { setSaveErr("Style name is required"); return; }
    setSaving(true); setSaveErr(null);
    try {
      await api.patch(`/pd/styles/${styleId}`, form);
      if (onRefreshBoard) onRefreshBoard();
      load();
    } catch (e) {
      setSaveErr(e?.response?.data?.detail || e.message);
      setSaving(false);
    }
  };

  const deleteStyle = async () => {
    if (!st || !window.confirm(`Delete “${st.style_name}” from Product Development Flow? This removes the style and its stage history.`)) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await api.delete(`/pd/styles/${styleId}`);
      onClose();
      onRefreshBoard?.();
    } catch (e) {
      setDeleteErr(e?.response?.data?.detail || e.message || "Could not delete style");
    } finally {
      setDeleting(false);
    }
  };

  const st = data?.style;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-lg h-full overflow-y-auto p-5 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="pd-detail-drawer">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-extrabold text-[16px]">{st ? st.style_name : "Loading…"}</h3>
          <div className="flex items-center gap-2">
            {st && !editing && (
              <>
                <button onClick={() => startEdit(st)}
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand hover:text-brand-deep"
                  data-testid="pd-edit-details-btn" title="Edit style details">
                  <PencilSimple size={14} /> Edit
                </button>
                {canDelete && (
                  <button onClick={deleteStyle} disabled={deleting}
                    className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-rose-600 hover:text-rose-800 disabled:opacity-50"
                    data-testid="pd-delete-style-btn" title="Delete style">
                    <Trash size={14} /> {deleting ? "Deleting…" : "Delete"}
                  </button>
                )}
              </>
            )}
            <button onClick={onClose} className="text-muted hover:text-foreground"><X size={18} /></button>
          </div>
        </div>
        {err && <ErrorBox message={err} />}
        {deleteErr && <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11.5px] text-rose-700">{deleteErr}</div>}
        {!data && !err && <Loading />}
        {st && (
          <>
            <div className="flex flex-wrap gap-1.5 text-[11.5px] mb-3">
              {st.style_number && <span className="font-mono pill-neutral">{st.style_number}</span>}
              {st.brand && <span className="pill-neutral">{st.brand}</span>}
              {st.category && <span className="pill-neutral">{st.category}</span>}
              {st.lifecycle_type && <span className="pill-neutral">{st.lifecycle_type}</span>}
              <span className={st.status === "completed" ? "pill-green" : "pill-amber"}>
                {st.status === "completed" ? "Completed (approved)" : `In ${String(st.current_stage).replace(/_/g, " ")}`}
              </span>
              {st.assignee_name && <span className="pill-neutral">Assignee: {st.assignee_name}</span>}
            </div>

            {/* ── Style image ── */}
            <StyleImage styleId={st.id} styleName={st.style_name} />

            {/* ── Edit form ── */}
            {editing ? (
              <div className="mb-4 rounded-lg border border-brand/30 bg-slate-50 p-4 space-y-3" data-testid="pd-edit-form">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-[12.5px]">Edit style details</span>
                  <button onClick={() => setEditing(false)} className="text-muted hover:text-foreground text-[11px]">Cancel</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FField label="Style Name *" name="style_name" value={form.style_name} onChange={setField} />
                  <FField label="Style Number" name="style_number" value={form.style_number} onChange={setField} placeholder="e.g. V0626023" />
                  <FField label="Brand" name="brand" value={form.brand} onChange={setField} />
                  <FField label="Category" name="category" value={form.category} onChange={setField} />
                  <FField label="Sub-category" name="sub_category" value={form.sub_category} onChange={setField} />
                  <FField label="Lifecycle Type" name="lifecycle_type" value={form.lifecycle_type} onChange={setField} placeholder="e.g. core, new" />
                  <FField label="Pattern Maker" name="pattern_maker" value={form.pattern_maker} onChange={setField} />
                  <FField label="CAD" name="cad" value={form.cad} onChange={setField} />
                  <FField label="Target Order Wk" name="target_order_week" value={form.target_order_week} onChange={setField} placeholder="e.g. WK 30" />
                  <FField label="Fabric Type" name="fabric_type" value={form.fabric_type} onChange={setField} />
                  <FField label="Fabric Name" name="fabric_name" value={form.fabric_name} onChange={setField} />
                  <FField label="Sample Colour" name="sample_colour" value={form.sample_colour} onChange={setField} />
                  <FField label="Print / Solid" name="print_solid" value={form.print_solid} onChange={setField} />
                  <FField label="Theme" name="theme" value={form.theme} onChange={setField} />
                  <FField label="Adoption Date" name="adoption_date" value={form.adoption_date} onChange={setField} type="date" />
                  <FField label="Order Date" name="order_date" value={form.order_date} onChange={setField} type="date" />
                  <FField label="Sample Approval" name="sample_approval_date" value={form.sample_approval_date} onChange={setField} type="date" />
                </div>
                {saveErr && <div className="text-[11.5px] text-red-600 font-medium">{saveErr}</div>}
                <div className="flex gap-2 pt-1">
                  <button onClick={save} disabled={saving}
                    className="px-4 py-1.5 rounded-lg bg-brand text-white font-semibold text-[12px] hover:bg-brand-deep disabled:opacity-50"
                    data-testid="pd-edit-save-btn">
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                  <button onClick={() => setEditing(false)}
                    className="px-4 py-1.5 rounded-lg border border-border text-[12px] font-semibold hover:bg-slate-50">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* ── Read-only metadata grid ── */
              <div className="mb-4 rounded-lg border border-line bg-slate-50 p-3" data-testid="pd-meta-grid">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
                  {[
                    ["Pattern Maker", st.pattern_maker || st.assignee_name],
                    ["CAD", st.cad],
                    ["Target Order Wk", st.target_order_week],
                    ["Sub-category", st.sub_category],
                    ["Theme", st.theme],
                    ["Fabric Type", st.fabric_type],
                    ["Fabric Name", st.fabric_name],
                    ["Sample Colour", st.sample_colour],
                    ["Print / Solid", st.print_solid],
                    ["Adoption Date", st.adoption_date ? new Date(st.adoption_date).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : null],
                    ["Order Date", st.order_date ? new Date(st.order_date).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : null],
                    ["Sample Approval", st.sample_approval_date ? new Date(st.sample_approval_date).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : null],
                  ].filter(([, v]) => v).map(([label, val]) => (
                    <div key={label}>
                      <span className="text-muted">{label}: </span>
                      <span className="font-semibold">{val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 mb-4">
              {st.status === "active" && (
                <button onClick={() => onMove(st)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white font-semibold text-[12px] hover:bg-brand-deep"
                  data-testid="pd-detail-move-btn">
                  <ArrowRight size={13} /> Move / decide
                </button>
              )}
            </div>
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

            {/* ── Stage notes ── */}
            <div className="mt-5">
              <StageNotes
                styleId={st.id}
                currentStage={st.current_stage}
                stages={allStages || []}
              />
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
// ── Summary tab — per-stage & per-assignee overview ──────────────────────────
const AgingBar = ({ ok, warning, stuck, total }) => {
  if (!total) return null;
  return (
    <div className="flex gap-0.5 h-1.5 rounded overflow-hidden bg-slate-100">
      {ok > 0 && <div className="bg-emerald-500 transition-all" style={{ width: `${(ok / total) * 100}%` }} />}
      {warning > 0 && <div className="bg-amber-400 transition-all" style={{ width: `${(warning / total) * 100}%` }} />}
      {stuck > 0 && <div className="bg-rose-400 transition-all" style={{ width: `${(stuck / total) * 100}%` }} />}
    </div>
  );
};

const SummaryTab = () => {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get("/pd/summary", { forceFresh: true })
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  }, []);
  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  const { stages, assignees, cross_tab, stage_order, stage_names, totals } = data;

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Active styles", value: totals.total_active, color: "border-l-brand", text: "text-foreground" },
          { label: "Stuck (over SLA)", value: totals.stuck, color: "border-l-rose-400", text: "text-rose-600" },
          { label: "At risk", value: totals.warning, color: "border-l-amber-400", text: "text-amber-600" },
          { label: "Unassigned", value: totals.unassigned, color: "border-l-slate-300", text: "text-slate-500" },
        ].map((k) => (
          <div key={k.label} className={`card-white p-4 text-center border-l-4 ${k.color}`}>
            <div className={`text-3xl font-bold ${k.text}`}>{k.value}</div>
            <div className="text-[11px] text-muted mt-1">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Stage pipeline */}
      <div className="card-white p-5">
        <SectionTitle title="Pipeline by stage" subtitle="Active styles in each stage — green ok · amber at risk · red stuck" />
        <div className="grid grid-cols-3 sm:grid-cols-5 xl:grid-cols-9 gap-3 mt-4">
          {stages.map((s) => (
            <div key={s.stage_key} className="flex flex-col gap-2 bg-[#fdf8f4] rounded-xl p-3 min-w-0">
              <div className="text-[10.5px] font-bold text-foreground leading-tight" title={s.stage_name}>{s.stage_name}</div>
              <div className="text-2xl font-bold text-foreground">{s.total}</div>
              <div className="text-[10px] text-muted">SLA {s.sla_days ?? "—"}d</div>
              <AgingBar ok={s.ok} warning={s.warning} stuck={s.stuck} total={s.total} />
              <div className="flex flex-col gap-1">
                {s.ok > 0 && (
                  <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">{s.ok} on track</span>
                )}
                {s.warning > 0 && (
                  <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">{s.warning} at risk</span>
                )}
                {s.stuck > 0 && (
                  <span className="text-[10px] font-semibold text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded">{s.stuck} stuck</span>
                )}
                {s.total === 0 && <span className="text-[10px] text-muted italic">empty</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Assignee workload */}
      <div className="card-white p-5">
        <SectionTitle title="Workload by assignee" subtitle="Active styles per pattern maker / designer" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
          {assignees.map((a) => (
            <div key={a.assignee} className="bg-[#fdf8f4] rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-brand/10 text-brand font-bold text-sm flex items-center justify-center flex-shrink-0 uppercase">
                  {a.assignee === "Unassigned" ? "?" : a.assignee.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[13px] truncate">{a.assignee}</div>
                  <div className="text-[11px] text-muted">{a.total} style{a.total !== 1 ? "s" : ""}</div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {a.stuck > 0 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">{a.stuck} stuck</span>
                  )}
                  {a.warning > 0 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{a.warning} risk</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {stage_order.filter((sk) => (a.by_stage[sk] || 0) > 0).map((sk) => (
                  <span key={sk}
                    className="inline-flex items-center gap-1 text-[10.5px] bg-white border border-line rounded-full px-2 py-0.5">
                    <span className="text-muted">{stage_names[sk]}</span>
                    <span className="font-bold text-brand">{a.by_stage[sk]}</span>
                  </span>
                ))}
              </div>
              <AgingBar ok={a.ok} warning={a.warning} stuck={a.stuck} total={a.total} />
            </div>
          ))}
        </div>
      </div>

      {/* Assignee × stage matrix */}
      <div className="card-white p-5 overflow-x-auto">
        <SectionTitle title="Assignee × stage matrix" subtitle="Count of active styles at each intersection" />
        <table className="mt-4 text-[11px] w-full min-w-max">
          <thead>
            <tr>
              <th className="text-left text-muted font-semibold pb-2 pr-6 sticky left-0 bg-white min-w-[130px]">Assignee</th>
              {stage_order.map((sk) => (
                <th key={sk} className="text-center text-muted font-semibold pb-2 px-3 whitespace-nowrap">{stage_names[sk]}</th>
              ))}
              <th className="text-center font-bold text-foreground pb-2 px-3">Total</th>
            </tr>
          </thead>
          <tbody>
            {cross_tab.map((row) => {
              const rowMax = Math.max(...stage_order.map((sk) => row[sk] || 0), 1);
              const rowTotal = stage_order.reduce((s, sk) => s + (row[sk] || 0), 0);
              return (
                <tr key={row.assignee} className="border-t border-line">
                  <td className="py-2 pr-6 font-semibold text-[12px] text-foreground sticky left-0 bg-white">{row.assignee}</td>
                  {stage_order.map((sk) => {
                    const v = row[sk] || 0;
                    const alpha = v > 0 ? 0.08 + (v / rowMax) * 0.24 : 0;
                    return (
                      <td key={sk} className="text-center py-2 px-3">
                        {v > 0 ? (
                          <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded font-bold text-brand"
                            style={{ backgroundColor: `rgba(26,92,56,${alpha})` }}>
                            {v}
                          </span>
                        ) : (
                          <span className="text-slate-200">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="text-center py-2 px-3 font-bold text-[12px] text-foreground">{rowTotal}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

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

// ── Tracker tab — full sortable table of all styles ──────────────────────────
const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch { return "—"; }
};

const TrackerTab = ({ onOpenStyle }) => {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState("");
  const [brandF, setBrandF] = useState("");
  const [catF, setCatF] = useState("");
  const [stageF, setStageF] = useState("");

  useEffect(() => {
    api.get("/pd/board", { forceFresh: true })
      .then((r) => {
        const active = r.data.cards || [];
        api.get("/pd/completed", { forceFresh: true })
          .then((r2) => setRows([...active, ...(r2.data.styles || [])]))
          .catch(() => setRows(active));
      })
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  }, []);

  if (err) return <ErrorBox message={err} />;
  if (!rows) return <Loading />;

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (q && !(`${r.style_name} ${r.style_number || ""} ${r.pattern_maker || ""} ${r.assignee_name || ""}`.toLowerCase().includes(q))) return false;
    if (brandF && r.brand !== brandF) return false;
    if (catF && (r.category || "").toUpperCase() !== catF.toUpperCase()) return false;
    if (stageF && r.current_stage !== stageF) return false;
    return true;
  });

  const brands = [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort();
  const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  const stages = [...new Set(rows.map((r) => r.current_stage).filter(Boolean))].sort();

  return (
    <div className="card-white p-5" data-testid="pd-tracker">
      <SectionTitle title="Style Tracker" subtitle="All active and completed styles with full specification details — searchable and exportable" />
      <div className="flex flex-wrap gap-2 mb-3">
        <input className="px-3 py-1.5 rounded-lg border border-border text-[12.5px] w-64"
          placeholder="Search style, number, pattern maker…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="px-3 py-1.5 rounded-lg border border-border text-[12.5px]"
          value={brandF} onChange={(e) => setBrandF(e.target.value)}>
          <option value="">All brands</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className="px-3 py-1.5 rounded-lg border border-border text-[12.5px]"
          value={catF} onChange={(e) => setCatF(e.target.value)}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="px-3 py-1.5 rounded-lg border border-border text-[12.5px]"
          value={stageF} onChange={(e) => setStageF(e.target.value)}>
          <option value="">All stages</option>
          {stages.map((s) => <option key={s} value={s}>{String(s).replace(/_/g, " ")}</option>)}
        </select>
        <span className="ml-auto text-[11.5px] text-muted self-center">{filtered.length} style{filtered.length !== 1 ? "s" : ""}</span>
      </div>
      {filtered.length === 0
        ? <Empty label="No styles match the current filter." />
        : (
          <SortableTable
            testId="pd-tracker-table" exportName="pd_q3_tracker.csv"
            initialSort={{ key: "target_order_week", dir: "asc" }}
            columns={[
              { key: "style_number", label: "Style No.", align: "left",
                render: (r) => <span className="font-mono text-[11.5px]">{r.style_number || "—"}</span> },
              { key: "style_name", label: "Style Name", align: "left",
                render: (r) => <button className="font-semibold text-brand hover:underline text-left" onClick={() => onOpenStyle(r.id)}>{r.style_name}</button> },
              { key: "brand", label: "Brand", align: "left", render: (r) => r.brand || "—" },
              { key: "lifecycle_type", label: "Type", align: "left",
                render: (r) => r.lifecycle_type ? <span className="pill-neutral">{r.lifecycle_type}</span> : <span className="text-muted">—</span> },
              { key: "current_stage", label: "Stage", align: "left",
                render: (r) => (
                  <span className={`capitalize text-[11.5px] font-semibold ${r.status === "completed" ? "text-emerald-700" : ""}`}>
                    {r.status === "completed" ? "Completed" : String(r.current_stage).replace(/_/g, " ")}
                  </span>
                )},
              { key: "category", label: "Category", align: "left", render: (r) => r.category || "—" },
              { key: "sub_category", label: "Sub-Category", align: "left", render: (r) => r.sub_category || "—" },
              { key: "pattern_maker", label: "Pattern Maker", align: "left", render: (r) => r.pattern_maker || r.assignee_name || "—" },
              { key: "target_order_week", label: "Target Wk", align: "left", render: (r) => r.target_order_week || "—" },
              { key: "adoption_date", label: "Adopted", align: "left", render: (r) => fmtDate(r.adoption_date || r.created_at) },
              { key: "order_date", label: "Order Date", align: "left", render: (r) => fmtDate(r.order_date) },
              { key: "sample_approval_date", label: "Sample Approval", align: "left", render: (r) => fmtDate(r.sample_approval_date) },
              { key: "fabric_type", label: "Fabric Type", align: "left", render: (r) => r.fabric_type || "—" },
              { key: "fabric_name", label: "Fabric Name", align: "left", render: (r) => r.fabric_name || "—" },
              { key: "sample_colour", label: "Sample Colour", align: "left", render: (r) => r.sample_colour || "—" },
              { key: "print_solid", label: "P/S", align: "left", render: (r) => r.print_solid || "—" },
              { key: "theme", label: "Theme", align: "left", render: (r) => r.theme || "—" },
            ]}
            rows={filtered}
          />
        )}
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────
const TABS = [
  { key: "board", label: "Board", icon: Kanban },
  { key: "tracker", label: "Tracker", icon: Rows },
  { key: "summary", label: "Summary", icon: ChartPieSlice },
  { key: "analytics", label: "Analytics & Bottlenecks", icon: ChartBar },
  { key: "completed", label: "Completed", icon: CheckCircle },
  { key: "history", label: "History Log", icon: ClockClockwise },
];

const PDFlow = () => {
  const { user } = useAuth();
  const isAdmin = (user?.role || "").toLowerCase() === "admin";
  const canDeleteStyle = isAdmin || (user?.email || "").trim().toLowerCase() === PD_STYLE_DELETE_EMAIL;
  const [tab, setTab] = useState("board");
  const [board, setBoard] = useState(null);
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
      ["style_number", "style", "brand", "category", "sub_category", "type", "stage", "pattern_maker", "target_order_week", "adoption_date", "order_date", "sample_approval_date", "fabric_type", "fabric_name", "sample_colour", "print_solid", "theme", "days_in_stage", "sla_days", "aging"],
      board.cards.map((c) => [c.style_number, c.style_name, c.brand, c.category, c.sub_category, c.lifecycle_type, c.current_stage, c.pattern_maker || c.assignee_name, c.target_order_week, c.adoption_date, c.order_date, c.sample_approval_date, c.fabric_type, c.fabric_name, c.sample_colour, c.print_solid, c.theme, c.days_in_stage, c.sla_days, c.aging]));
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
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {c.style_number && (
                            <span className="font-mono text-[10px] text-muted bg-slate-100 px-1 rounded">{c.style_number}</span>
                          )}
                          {c.target_order_week && (
                            <span className="text-[10px] text-muted">{c.target_order_week}</span>
                          )}
                        </div>
                        <div className="text-[10.5px] text-muted mt-0.5">
                          {[c.brand, c.category].filter(Boolean).join(" · ") || "—"}
                        </div>
                        <div className="flex items-center justify-between mt-1.5">
                          <div className="flex flex-col min-w-0">
                            <span className="text-[10.5px] text-muted truncate max-w-[120px]">{c.assignee_name || c.pattern_maker || "Unassigned"}</span>
                            {c.cad && <span className="text-[9.5px] text-muted/70 truncate max-w-[120px]">CAD: {c.cad}</span>}
                          </div>
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

      {tab === "tracker" && <TrackerTab key={refreshKey} onOpenStyle={setDetail} />}
      {tab === "summary" && <SummaryTab key={refreshKey} />}
      {tab === "analytics" && <AnalyticsTab key={refreshKey} onOpenStyle={setDetail} />}
      {tab === "completed" && <CompletedTab key={refreshKey} onOpenStyle={setDetail} />}
      {tab === "history" && <HistoryTab key={refreshKey} isAdmin={isAdmin} />}

      {adding && <AddStyleDialog onClose={() => setAdding(false)} onSaved={refresh} />}
      {moving && board && (
        <MoveDialog card={moving} stages={board.stages}
          onClose={() => setMoving(null)} onSaved={() => { refresh(); setDetail(null); }} />
      )}
      {detail != null && (
        <DetailDrawer styleId={detail} onClose={() => setDetail(null)} allStages={board.stages}
          onMove={(st) => { setMoving(st); }}
          onRefreshBoard={refresh} canDelete={canDeleteStyle} />
      )}
      {slaOpen && board && (
        <SlaDialog stages={board.stages} onClose={() => setSlaOpen(false)}
          onSaved={() => { setSlaOpen(false); refresh(); }} />
      )}
    </div>
  );
};

export default PDFlow;
