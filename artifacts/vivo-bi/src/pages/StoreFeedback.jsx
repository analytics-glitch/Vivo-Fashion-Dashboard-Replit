import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { api, API, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import {
  PaperPlaneRight, CheckCircle, Camera, X, MagnifyingGlass,
  Storefront, ChatCenteredText, DownloadSimple, CaretDown, CaretUp,
  UserCircle, Phone, ArrowClockwise, FilePdf,
} from "@phosphor-icons/react";

/**
 * Store Feedback (Voice of Customer)
 * - Submit: store teams log what customers say (product, quality, sizing,
 *   requests…), attach photos, flag follow-ups.
 * - My submissions: submitters track status + HQ response (closes the loop).
 * - Responses: admin / leadership / SMT review, respond, change status and
 *   export. Server-gated; the tab is hidden for everyone else.
 */

const REVIEWER_ROLES = ["admin", "leadership", "smt"];

const STATUS_STYLE = {
  new:       "bg-amber-100 text-amber-800 border-amber-200",
  reviewed:  "bg-blue-100 text-blue-800 border-blue-200",
  actioned:  "bg-emerald-100 text-emerald-800 border-emerald-200",
  dismissed: "bg-slate-100 text-slate-600 border-slate-200",
};
const STATUS_LABEL = { new: "New", reviewed: "Reviewed", actioned: "Actioned", dismissed: "Closed" };

const StatusPill = ({ status }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11.5px] font-semibold ${STATUS_STYLE[status] || STATUS_STYLE.new}`}>
    {STATUS_LABEL[status] || status}
  </span>
);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Downscale photos client-side so uploads are fast on store connections and
// the database stays lean. PDFs / GIFs pass through untouched.
const compressImage = (file) => new Promise((resolve) => {
  if (!file.type?.startsWith("image/") || file.type === "image/gif") return resolve(file);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (scale >= 1 && file.size < 1.5 * 1024 * 1024) { URL.revokeObjectURL(url); return resolve(file); }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(url);
      if (!blob) return resolve(file);
      const name = (file.name || "photo").replace(/\.\w+$/, "") + ".jpg";
      resolve(new File([blob], name, { type: "image/jpeg" }));
    }, "image/jpeg", 0.82);
  };
  img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
  img.src = url;
});

// ── Lightbox (portal — never trapped under sticky headers) ──────────────────
const Lightbox = ({ src, alt, onClose }) => createPortal(
  <div className="fixed inset-0 z-[999] bg-black/80 flex items-center justify-center p-6" onClick={onClose}>
    <button className="absolute top-4 right-4 text-white/90 hover:text-white" onClick={onClose} aria-label="Close">
      <X size={26} />
    </button>
    <img src={src} alt={alt || "attachment"} className="max-h-full max-w-full rounded-lg shadow-2xl object-contain" onClick={(e) => e.stopPropagation()} />
  </div>,
  document.body,
);

const AttachmentThumbs = ({ attachments, size = "h-16 w-16" }) => {
  const [open, setOpen] = useState(null);
  if (!attachments?.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => {
        const url = `${API}/store-feedback/attachment/${a.id}`;
        const isPdf = (a.content_type || "").includes("pdf");
        return isPdf ? (
          <a key={a.id} href={url} target="_blank" rel="noreferrer"
            className={`${size} rounded-lg border border-border bg-slate-50 flex flex-col items-center justify-center text-muted hover:bg-slate-100`}
            title={a.filename}>
            <FilePdf size={22} />
            <span className="text-[9.5px] mt-0.5">PDF</span>
          </a>
        ) : (
          <button key={a.id} onClick={() => setOpen(a)} className={`${size} rounded-lg border border-border overflow-hidden bg-slate-50 hover:opacity-90`} title={a.filename}>
            <img src={url} alt={a.filename || "photo"} className="h-full w-full object-cover" loading="lazy" />
          </button>
        );
      })}
      {open && <Lightbox src={`${API}/store-feedback/attachment/${open.id}`} alt={open.filename} onClose={() => setOpen(null)} />}
    </div>
  );
};

// ── Product autocomplete ─────────────────────────────────────────────────────
const ProductPicker = ({ value, onPick, onClear }) => {
  const [q, setQ] = useState("");
  const [items, setItems] = useState([]);
  const [openList, setOpenList] = useState(false);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef(null);
  const tRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpenList(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const search = (text) => {
    setQ(text);
    if (tRef.current) clearTimeout(tRef.current);
    if (text.trim().length < 2) { setItems([]); setOpenList(false); return; }
    tRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get("/store-feedback/product-search", { params: { q: text.trim() }, forceFresh: true });
        setItems(r.data?.items || []);
        setOpenList(true);
      } catch { setItems([]); }
      finally { setSearching(false); }
    }, 300);
  };

  if (value?.product_name) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-slate-50 px-3 py-2">
        {value.product_sku && (
          <img src={`${API}/product-image/${encodeURIComponent(value.product_sku)}`} alt=""
            className="h-11 w-11 rounded-md object-cover bg-white border border-border"
            onError={(e) => { e.currentTarget.style.display = "none"; }} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-slate-800 truncate">{value.product_name}</div>
          {value.style_number && <div className="text-[12px] text-muted">Style № {value.style_number}</div>}
        </div>
        <button type="button" onClick={onClear} className="text-muted hover:text-slate-700" aria-label="Clear product">
          <X size={17} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => search(e.target.value)}
          onFocus={() => items.length && setOpenList(true)}
          placeholder="Search style name or number… (or type freely)"
          className="w-full rounded-lg border border-border pl-9 pr-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-slate-300"
          data-testid="sf-product-search"
        />
      </div>
      {openList && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-white shadow-lg max-h-72 overflow-auto">
          {searching && <div className="px-3 py-2 text-[12.5px] text-muted">Searching…</div>}
          {!searching && !items.length && <div className="px-3 py-2 text-[12.5px] text-muted">No matching products</div>}
          {items.map((it) => (
            <button key={it.style_name} type="button"
              onClick={() => { onPick(it); setQ(""); setItems([]); setOpenList(false); }}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-50 text-left">
              <img src={`${API}/product-image/${encodeURIComponent(it.sku || "")}`} alt=""
                className="h-10 w-10 rounded-md object-cover bg-slate-100 border border-border"
                onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-slate-800 truncate">{it.style_name}</div>
                <div className="text-[11.5px] text-muted">{it.style_number ? `Style № ${it.style_number}` : it.brand || ""}</div>
              </div>
            </button>
          ))}
          {q.trim().length >= 2 && !searching && (
            <button type="button"
              onClick={() => { onPick({ style_name: q.trim(), style_number: "", sku: "" }); setQ(""); setItems([]); setOpenList(false); }}
              className="w-full px-3 py-2 text-left text-[12.5px] text-slate-600 border-t border-border hover:bg-slate-50">
              Use “{q.trim()}” as typed
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const FieldLabel = ({ children, required, hint }) => (
  <label className="block text-[12.5px] font-semibold text-slate-700 mb-1.5">
    {children} {required && <span className="text-red-500">*</span>}
    {hint && <span className="ml-1.5 font-normal text-muted">{hint}</span>}
  </label>
);

// ── Submit form ──────────────────────────────────────────────────────────────
const SubmitForm = ({ meta, onSubmitted }) => {
  const [form, setForm] = useState({
    feedback_date: todayISO(),
    store_name: localStorage.getItem("sf_last_store") || "",
    category: "",
    frequency: "",
    product: null,
    customer_name: "",
    customer_contact: "",
    wants_followup: false,
    feedback_text: "",
    business_impact: "",
  });
  const [files, setFiles] = useState([]); // { file, previewUrl }
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // submitted id
  const fileRef = useRef(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addFiles = async (list) => {
    setError(null);
    const incoming = Array.from(list || []);
    const room = 4 - files.length;
    if (incoming.length > room) setError(`Maximum 4 attachments — only the first ${room} added.`);
    const accepted = [];
    for (const f of incoming.slice(0, Math.max(0, room))) {
      if (!f.type.startsWith("image/") && f.type !== "application/pdf") { setError(`${f.name}: photos or PDF only.`); continue; }
      const c = await compressImage(f);
      if (c.size > 8 * 1024 * 1024) { setError(`${f.name} is too large (max 8 MB).`); continue; }
      accepted.push({ file: c, previewUrl: c.type.startsWith("image/") ? URL.createObjectURL(c) : null });
    }
    if (accepted.length) setFiles((prev) => [...prev, ...accepted].slice(0, 4));
  };

  const removeFile = (i) => setFiles((prev) => {
    const cp = [...prev];
    if (cp[i]?.previewUrl) URL.revokeObjectURL(cp[i].previewUrl);
    cp.splice(i, 1);
    return cp;
  });

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.store_name) return setError("Please choose your store.");
    if (form.feedback_text.trim().length < 5) return setError("Please write what the customer said.");
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("feedback_date", form.feedback_date || "");
      fd.append("store_name", form.store_name);
      fd.append("category", form.category || "other");
      fd.append("frequency", form.frequency || "");
      fd.append("product_name", form.product?.style_name || "");
      fd.append("style_number", form.product?.style_number || "");
      fd.append("product_sku", form.product?.sku || "");
      fd.append("customer_name", form.customer_name.trim());
      fd.append("customer_contact", form.customer_contact.trim());
      fd.append("wants_followup", form.wants_followup ? "true" : "false");
      fd.append("feedback_text", form.feedback_text.trim());
      fd.append("business_impact", form.business_impact.trim());
      files.forEach((f) => fd.append("files", f.file, f.file.name));
      const r = await api.post("/store-feedback", fd, { headers: { "Content-Type": "multipart/form-data" } });
      localStorage.setItem("sf_last_store", form.store_name);
      setDone(r.data?.id);
      onSubmitted?.();
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="card-white p-8 text-center max-w-2xl mx-auto">
        <CheckCircle size={44} weight="fill" className="mx-auto text-emerald-500" />
        <h3 className="mt-3 text-[17px] font-bold text-slate-800">Feedback logged — thank you!</h3>
        <p className="mt-1 text-[13px] text-muted">
          HQ has been notified. You can track the status and any response under <b>My submissions</b>.
        </p>
        <button
          onClick={() => {
            setDone(null);
            files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
            setFiles([]);
            setForm((f) => ({
              ...f, category: "", frequency: "", product: null, customer_name: "",
              customer_contact: "", wants_followup: false, feedback_text: "", business_impact: "",
              feedback_date: todayISO(),
            }));
          }}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 text-white px-4 py-2.5 text-[13px] font-semibold hover:bg-slate-700"
          data-testid="sf-log-another">
          <ArrowClockwise size={16} /> Log another feedback
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="max-w-2xl mx-auto space-y-5">
      <div className="card-white p-5 sm:p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <FieldLabel required>Store</FieldLabel>
            <div className="relative">
              <Storefront size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <select value={form.store_name} onChange={(e) => set("store_name", e.target.value)}
                className="w-full appearance-none rounded-lg border border-border pl-9 pr-8 py-2.5 text-[13.5px] bg-white focus:outline-none focus:ring-2 focus:ring-slate-300"
                data-testid="sf-store">
                <option value="">Select your store…</option>
                {(meta?.stores || []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <CaretDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            </div>
          </div>
          <div>
            <FieldLabel>Date</FieldLabel>
            <input type="date" value={form.feedback_date} max={todayISO()}
              onChange={(e) => set("feedback_date", e.target.value)}
              className="w-full rounded-lg border border-border px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-slate-300" />
          </div>
        </div>

        <div>
          <FieldLabel required>What is this about?</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {(meta?.categories || []).map((c) => (
              <button key={c.key} type="button" onClick={() => set("category", c.key)}
                className={`rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition ${
                  form.category === c.key
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-border hover:bg-slate-50"}`}
                data-testid={`sf-cat-${c.key}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <FieldLabel hint="(optional — search the catalogue or type freely)">Product</FieldLabel>
          <ProductPicker
            value={form.product ? { product_name: form.product.style_name, style_number: form.product.style_number, product_sku: form.product.sku } : null}
            onPick={(it) => set("product", it)}
            onClear={() => set("product", null)}
          />
        </div>

        <div>
          <FieldLabel required>What did the customer say?</FieldLabel>
          <textarea value={form.feedback_text} onChange={(e) => set("feedback_text", e.target.value)}
            rows={4} placeholder="In the customer's own words — e.g. “I love this dress but you never have my size 14 in stock.”"
            className="w-full rounded-lg border border-border px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-slate-300"
            data-testid="sf-feedback-text" />
        </div>

        <div>
          <FieldLabel hint="(why does this matter?)">Business impact</FieldLabel>
          <textarea value={form.business_impact} onChange={(e) => set("business_impact", e.target.value)}
            rows={3} placeholder="e.g. lost the sale · third customer this week asking for this · customer compared us to a competitor…"
            className="w-full rounded-lg border border-border px-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-slate-300" />
        </div>

        <div>
          <FieldLabel>How often are customers saying this?</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {(meta?.frequencies || []).map((f) => (
              <button key={f.key} type="button"
                onClick={() => set("frequency", form.frequency === f.key ? "" : f.key)}
                className={`rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition ${
                  form.frequency === f.key
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-border hover:bg-slate-50"}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card-white p-5 sm:p-6 space-y-4">
        <SectionTitle title="Customer (optional)" subtitle="Only if the customer is happy to be contacted" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="relative">
            <UserCircle size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={form.customer_name} onChange={(e) => set("customer_name", e.target.value)}
              placeholder="Customer name"
              className="w-full rounded-lg border border-border pl-9 pr-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-slate-300" />
          </div>
          <div className="relative">
            <Phone size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={form.customer_contact} onChange={(e) => set("customer_contact", e.target.value)}
              placeholder="Phone or email"
              className="w-full rounded-lg border border-border pl-9 pr-3 py-2.5 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-slate-300" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-slate-700">
          <input type="checkbox" checked={form.wants_followup} onChange={(e) => set("wants_followup", e.target.checked)}
            className="h-4 w-4 rounded border-border" />
          Customer would like a follow-up
        </label>
      </div>

      <div className="card-white p-5 sm:p-6">
        <SectionTitle title="Photos" subtitle="Product issues are 10× clearer with a photo — up to 4 (photos or PDF)" />
        <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <div className="mt-3 flex flex-wrap gap-3">
          {files.map((f, i) => (
            <div key={i} className="relative h-20 w-20 rounded-lg border border-border overflow-hidden bg-slate-50">
              {f.previewUrl
                ? <img src={f.previewUrl} alt="" className="h-full w-full object-cover" />
                : <div className="h-full w-full flex flex-col items-center justify-center text-muted"><FilePdf size={22} /><span className="text-[9.5px] mt-0.5">PDF</span></div>}
              <button type="button" onClick={() => removeFile(i)}
                className="absolute top-1 right-1 rounded-full bg-black/60 text-white p-0.5 hover:bg-black/80" aria-label="Remove">
                <X size={12} />
              </button>
            </div>
          ))}
          {files.length < 4 && (
            <button type="button" onClick={() => fileRef.current?.click()}
              className="h-20 w-20 rounded-lg border-2 border-dashed border-border bg-slate-50 hover:bg-slate-100 flex flex-col items-center justify-center gap-1 text-muted"
              data-testid="sf-add-photo">
              <Camera size={20} />
              <span className="text-[10.5px] font-medium">Add</span>
            </button>
          )}
        </div>
      </div>

      {error && <ErrorBox message={String(error)} />}

      <button type="submit" disabled={submitting}
        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 text-white px-6 py-3 text-[13.5px] font-semibold hover:bg-slate-700 disabled:opacity-60"
        data-testid="sf-submit">
        <PaperPlaneRight size={16} weight="fill" />
        {submitting ? "Sending…" : "Submit feedback"}
      </button>
    </form>
  );
};

// ── Shared detail block ──────────────────────────────────────────────────────
const FeedbackDetail = ({ item }) => (
  <div className="space-y-3 text-[13px]">
    <div>
      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">Customer feedback</div>
      <p className="mt-1 whitespace-pre-wrap text-slate-800">{item.feedback_text}</p>
    </div>
    {item.business_impact && (
      <div>
        <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">Business impact</div>
        <p className="mt-1 whitespace-pre-wrap text-slate-700">{item.business_impact}</p>
      </div>
    )}
    <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[12.5px] text-slate-600">
      {item.frequency_label && <span>📈 {item.frequency_label}</span>}
      {item.customer_name && <span>👤 {item.customer_name}{item.customer_contact ? ` · ${item.customer_contact}` : ""}</span>}
      {!item.customer_name && item.customer_contact && <span>👤 {item.customer_contact}</span>}
      {item.wants_followup && <span className="text-amber-700 font-medium">⚑ Customer wants a follow-up</span>}
    </div>
    {item.attachments?.length > 0 && <AttachmentThumbs attachments={item.attachments} />}
  </div>
);

// ── My submissions ───────────────────────────────────────────────────────────
const MineList = ({ refreshKey }) => {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let dead = false;
    api.get("/store-feedback/mine", { forceFresh: true })
      .then((r) => { if (!dead) setItems(r.data?.items || []); })
      .catch((e) => { if (!dead) setError(e?.response?.data?.detail || e.message); });
    return () => { dead = true; };
  }, [refreshKey]);

  if (error) return <ErrorBox message={String(error)} />;
  if (items === null) return <Loading label="Loading your submissions…" />;
  if (!items.length) return <Empty label="You haven't submitted any feedback yet." />;

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      {items.map((it) => (
        <div key={it.id} className="card-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={it.status} />
            <span className="text-[12.5px] font-semibold text-slate-700">{it.store_name}</span>
            <span className="text-[12px] text-muted">· {it.category_label}</span>
            <span className="ml-auto text-[12px] text-muted">{fmtDate ? fmtDate(it.feedback_date) : it.feedback_date}</span>
          </div>
          {it.product_name && (
            <div className="mt-1.5 text-[12.5px] text-slate-600">
              {it.product_name}{it.style_number ? ` · Style № ${it.style_number}` : ""}
            </div>
          )}
          <p className="mt-2 text-[13px] text-slate-800 whitespace-pre-wrap">{it.feedback_text}</p>
          {it.attachments?.length > 0 && <div className="mt-2.5"><AttachmentThumbs attachments={it.attachments} size="h-12 w-12" /></div>}
          {it.admin_notes && (
            <div className="mt-3 rounded-lg bg-blue-50 border border-blue-100 px-3 py-2.5">
              <div className="text-[11.5px] font-semibold text-blue-800">Response from HQ</div>
              <p className="mt-0.5 text-[12.5px] text-blue-900 whitespace-pre-wrap">{it.admin_notes}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// ── Responses (reviewers) ────────────────────────────────────────────────────
const KpiCard = ({ label, value, sub }) => (
  <div className="card-white p-4">
    <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">{label}</div>
    <div className="mt-1 text-[22px] font-bold text-slate-800 leading-none">{value}</div>
    {sub && <div className="mt-1 text-[11.5px] text-muted truncate">{sub}</div>}
  </div>
);

const ResponsesView = ({ meta, openId }) => {
  const [filters, setFilters] = useState({ store: "", category: "", status: "", date_from: "", date_to: "", q: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(openId ? Number(openId) : null);
  const [drafts, setDrafts] = useState({}); // id -> { status, admin_notes, saving }
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const LIMIT = 50;

  const fetchList = useCallback((off = 0, append = false) => {
    setLoading(true);
    setError(null);
    const params = { ...filters, limit: LIMIT, offset: off };
    api.get("/store-feedback/list", { params, forceFresh: true })
      .then((r) => {
        setData((prev) => append && prev
          ? { ...r.data, items: [...prev.items, ...r.data.items] }
          : r.data);
        setOffset(off);
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { fetchList(0, false); }, [fetchList]);

  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  const draftFor = (it) => drafts[it.id] || { status: it.status, admin_notes: it.admin_notes || "", saving: false };

  const save = async (it) => {
    const d = draftFor(it);
    setDrafts((ds) => ({ ...ds, [it.id]: { ...d, saving: true } }));
    try {
      const r = await api.patch(`/store-feedback/item/${it.id}`, { status: d.status, admin_notes: d.admin_notes });
      const updated = r.data?.item;
      setData((prev) => prev ? { ...prev, items: prev.items.map((x) => (x.id === it.id ? { ...x, ...updated } : x)) } : prev);
      setDrafts((ds) => { const cp = { ...ds }; delete cp[it.id]; return cp; });
    } catch (e) {
      setDrafts((ds) => ({ ...ds, [it.id]: { ...d, saving: false } }));
      alert(e?.response?.data?.detail || e.message || "Failed to save");
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await api.get("/store-feedback/export.csv", { params: filters, responseType: "blob", forceFresh: true });
      const url = URL.createObjectURL(new Blob([r.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "store-feedback.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Export failed: " + (e?.response?.data?.detail || e.message));
    } finally {
      setExporting(false);
    }
  };

  const s = data?.summary;
  const items = data?.items || [];
  const sel = "rounded-lg border border-border bg-white px-2.5 py-2 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-slate-300";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Needs review" value={s ? s.open_new : "—"} sub="status: New" />
        <KpiCard label="This month" value={s ? s.this_month : "—"} sub="submissions" />
        <KpiCard label="Top theme · 30d" value={s?.top_categories?.[0]?.n ?? "—"} sub={s?.top_categories?.[0]?.label || "no data yet"} />
        <KpiCard label="Most active store · 30d" value={s?.top_stores?.[0]?.n ?? "—"} sub={s?.top_stores?.[0]?.store || "no data yet"} />
      </div>

      <div className="card-white p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[180px]">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={filters.q} onChange={(e) => setF("q", e.target.value)} placeholder="Search feedback, product, customer…"
              className="w-full rounded-lg border border-border pl-8.5 pr-3 py-2 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-slate-300"
              style={{ paddingLeft: "2.1rem" }} />
          </div>
          <select value={filters.store} onChange={(e) => setF("store", e.target.value)} className={sel}>
            <option value="">All stores</option>
            {(meta?.stores || []).map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
          <select value={filters.category} onChange={(e) => setF("category", e.target.value)} className={sel}>
            <option value="">All categories</option>
            {(meta?.categories || []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setF("status", e.target.value)} className={sel} data-testid="sf-filter-status">
            <option value="">All statuses</option>
            {(meta?.statuses || []).map((st) => <option key={st} value={st}>{STATUS_LABEL[st] || st}</option>)}
          </select>
          <input type="date" value={filters.date_from} onChange={(e) => setF("date_from", e.target.value)} className={sel} />
          <input type="date" value={filters.date_to} onChange={(e) => setF("date_to", e.target.value)} className={sel} />
          <button onClick={exportCsv} disabled={exporting}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-2 text-[12.5px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            data-testid="sf-export">
            <DownloadSimple size={15} /> {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>

      {error && <ErrorBox message={String(error)} />}
      {!error && loading && !data && <Loading label="Loading feedback…" />}
      {!error && data && !items.length && <Empty label="No feedback matches these filters." />}

      <div className="space-y-2.5">
        {items.map((it) => {
          const open = expanded === it.id;
          const d = draftFor(it);
          const dirty = d.status !== it.status || (d.admin_notes || "") !== (it.admin_notes || "");
          return (
            <div key={it.id} className={`card-white overflow-hidden ${it.status === "new" ? "ring-1 ring-amber-200" : ""}`}>
              <button onClick={() => setExpanded(open ? null : it.id)} className="w-full text-left px-4 sm:px-5 py-3.5 hover:bg-slate-50/60">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={it.status} />
                  <span className="text-[13px] font-semibold text-slate-800">{it.store_name}</span>
                  <span className="text-[12px] text-muted">· {it.category_label}</span>
                  {it.wants_followup && <span className="text-[11.5px] font-semibold text-amber-700">⚑ follow-up</span>}
                  {it.attachments?.length > 0 && <span className="text-[11.5px] text-muted">📎 {it.attachments.length}</span>}
                  <span className="ml-auto flex items-center gap-2 text-[12px] text-muted">
                    {fmtDate ? fmtDate(it.feedback_date) : it.feedback_date}
                    {open ? <CaretUp size={13} /> : <CaretDown size={13} />}
                  </span>
                </div>
                <div className="mt-1.5 text-[13px] text-slate-700 line-clamp-2">
                  {it.product_name && <span className="font-medium">{it.product_name}{it.style_number ? ` (№ ${it.style_number})` : ""} — </span>}
                  {it.feedback_text}
                </div>
                <div className="mt-1 text-[11.5px] text-muted">by {it.submitted_by_name || it.submitted_by_email || "unknown"}</div>
              </button>

              {open && (
                <div className="border-t border-border px-4 sm:px-5 py-4 space-y-4 bg-slate-50/40">
                  <FeedbackDetail item={it} />
                  <div className="rounded-lg bg-white border border-border p-3.5 space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-[12px] font-semibold text-slate-700">Status</span>
                      <select value={d.status}
                        onChange={(e) => setDrafts((ds) => ({ ...ds, [it.id]: { ...d, status: e.target.value } }))}
                        className={sel} data-testid={`sf-status-${it.id}`}>
                        {(meta?.statuses || []).map((st) => <option key={st} value={st}>{STATUS_LABEL[st] || st}</option>)}
                      </select>
                      {it.status_updated_by && (
                        <span className="text-[11.5px] text-muted">last updated by {it.status_updated_by}</span>
                      )}
                    </div>
                    <textarea value={d.admin_notes}
                      onChange={(e) => setDrafts((ds) => ({ ...ds, [it.id]: { ...d, admin_notes: e.target.value } }))}
                      rows={2} placeholder="Response / notes back to the store (the submitter sees this)…"
                      className="w-full rounded-lg border border-border px-3 py-2 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-slate-300" />
                    <button onClick={() => save(it)} disabled={!dirty || d.saving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3.5 py-2 text-[12.5px] font-semibold hover:bg-slate-700 disabled:opacity-50"
                      data-testid={`sf-save-${it.id}`}>
                      {d.saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {data && items.length < (data.total || 0) && (
        <div className="text-center">
          <button onClick={() => fetchList(offset + LIMIT, true)} disabled={loading}
            className="rounded-lg border border-border bg-white px-4 py-2 text-[12.5px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            {loading ? "Loading…" : `Load more (${items.length} of ${data.total})`}
          </button>
        </div>
      )}
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────
const StoreFeedback = () => {
  const { user } = useAuth();
  const isReviewer = REVIEWER_ROLES.includes(user?.role);
  const [params] = useSearchParams();
  const openId = params.get("open");
  const initialTab = params.get("tab") || (openId && isReviewer ? "responses" : "submit");
  const [tab, setTab] = useState(initialTab === "responses" && !isReviewer ? "submit" : initialTab);
  const [meta, setMeta] = useState(null);
  const [metaErr, setMetaErr] = useState(null);
  const [mineKey, setMineKey] = useState(0);

  useEffect(() => {
    let dead = false;
    api.get("/store-feedback/meta")
      .then((r) => { if (!dead) setMeta(r.data); })
      .catch((e) => { if (!dead) setMetaErr(e?.response?.data?.detail || e.message); });
    return () => { dead = true; };
  }, []);

  const tabs = useMemo(() => [
    { key: "submit", label: "Submit feedback" },
    { key: "mine", label: "My submissions" },
    ...(isReviewer ? [{ key: "responses", label: "Responses" }] : []),
  ], [isReviewer]);

  return (
    <div className="space-y-5">
      <SectionTitle
        title={<span className="inline-flex items-center gap-2"><ChatCenteredText size={20} /> Store Feedback</span>}
        subtitle="The voice of the customer, straight from the shop floor — log it, and HQ reviews and responds"
      />
      <div className="flex gap-1.5 border-b border-border">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 text-[13px] font-semibold border-b-2 -mb-px transition ${
              tab === t.key ? "border-slate-900 text-slate-900" : "border-transparent text-muted hover:text-slate-700"}`}
            data-testid={`sf-tab-${t.key}`}>
            {t.label}
          </button>
        ))}
      </div>

      {metaErr && <ErrorBox message={String(metaErr)} />}
      {!meta && !metaErr && <Loading label="Loading…" />}
      {meta && tab === "submit" && <SubmitForm meta={meta} onSubmitted={() => setMineKey((k) => k + 1)} />}
      {meta && tab === "mine" && <MineList refreshKey={mineKey} />}
      {meta && tab === "responses" && isReviewer && <ResponsesView meta={meta} openId={openId} />}
    </div>
  );
};

export default StoreFeedback;
