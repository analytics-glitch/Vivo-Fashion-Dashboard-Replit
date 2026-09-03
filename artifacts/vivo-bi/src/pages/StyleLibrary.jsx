import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MagnifyingGlass, Plus, UploadSimple, X, FunnelSimple } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Empty, ErrorBox, Loading, SectionTitle } from "@/components/common";
import { fetchAuthedBlob, Lightbox, Placeholder } from "@/components/ProductThumbnail";
import {
  STYLE_LIBRARY_CATEGORIES,
  subcategoriesForLibraryCategory,
} from "@/lib/styleLibraryTaxonomy";

const PAGE_SIZE = 48;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const BRANDS = ["Vivo", "Safari", "Zoya"];
const STATUSES = ["Active", "Retired"];

const fmtDate = (value) => {
  if (!value) return "—";
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const useDialogFocus = (dialogRef, onClose, escapeBlocked = false) => {
  const previousFocus = useRef(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector(FOCUSABLE)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocus.current?.focus?.();
    };
  }, [dialogRef]);

  return useCallback((event) => {
    if (event.key === "Escape" && !escapeBlocked) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || []);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [dialogRef, escapeBlocked, onClose]);
};

const initialForm = {
  style_name: "",
  style_number: "",
  category: "",
  sub_category: "",
  fabric: "",
  brand: "Vivo",
  status: "Active",
  launch_date: "",
  adoption_date: "",
};

const LibraryImage = ({ style, url, className = "w-full h-full object-contain", testId }) => {
  const [source, setSource] = useState(url || "");
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);

  useEffect(() => {
    setSource(url || "");
    setFailed(false);
    retried.current = false;
  }, [url]);

  const onError = async () => {
    if (!retried.current && url) {
      retried.current = true;
      const blob = await fetchAuthedBlob(url);
      if (blob) {
        setSource(blob);
        return;
      }
    }
    setFailed(true);
  };

  if (!source || failed) return <Placeholder style={style} size={180} />;
  return (
    <img
      src={source}
      alt={style}
      loading="lazy"
      className={className}
      onError={onError}
      data-testid={testId}
    />
  );
};

const StyleCard = ({ style, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(style)}
    className="card-white p-2.5 flex flex-col gap-2 text-left relative cursor-pointer transition-shadow hover:shadow-md hover:ring-1 hover:ring-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/50"
    data-testid={`style-library-card-${style.id}`}
  >
    {style.status === "Retired" && (
      <span className="absolute top-4 left-4 z-[1] text-[10px] font-semibold uppercase tracking-wide bg-black/70 text-white rounded px-1.5 py-0.5">
        Retired
      </span>
    )}
    <div className="w-full h-[192px] overflow-hidden rounded-md bg-[#F5F5F0] grid place-items-center">
      <LibraryImage
        style={style.style_name}
        url={style.image_url}
        testId="style-library-card-image"
      />
    </div>
    <div className="min-w-0">
      <div className="font-semibold text-[12.5px] leading-snug truncate" title={style.style_name}>
        {style.style_name}
      </div>
      <div className="text-[11px] text-brand truncate" title={style.style_number}>
        {style.style_number}
      </div>
      <div className="text-[10.5px] text-muted/80 truncate">
        {style.category} · {style.sub_category}
      </div>
      <div className="flex items-center justify-between gap-2 mt-1 text-[10.5px] text-muted">
        <span>{style.brand}</span>
        <span>{style.launch_date ? fmtDate(style.launch_date) : "Not launched"}</span>
      </div>
      {style.adoption_date && (
        <div className="text-[10.5px] text-muted mt-0.5">Adopted {fmtDate(style.adoption_date)}</div>
      )}
    </div>
  </button>
);

const DetailModal = ({ summary, onClose }) => {
  const dialogRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let dead = false;
    api.get(`/style-library/${summary.id}`)
      .then(({ data }) => { if (!dead) setDetail(data); })
      .catch((err) => {
        if (!dead) setError(err?.response?.data?.detail || "Couldn't load style details.");
      });
    return () => { dead = true; };
  }, [summary.id]);

  const handleDialogKey = useDialogFocus(dialogRef, onClose, zoom);

  const style = detail || summary;
  const rows = [
    ["Style Name", style.style_name],
    ["Style Number", style.style_number],
    ["Category", style.category],
    ["Sub Category", style.sub_category],
    ["Fabric", style.fabric],
    ["Brand", style.brand],
    ["Status", style.status],
    ["Launch Date", fmtDate(style.launch_date)],
    ["Adoption Date", fmtDate(style.adoption_date)],
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="style-library-detail-title"
      data-testid="style-library-detail-modal"
    >
      <div ref={dialogRef} onKeyDown={handleDialogKey} className="card-white w-full max-w-4xl mx-auto my-2 rounded-xl shadow-xl p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Style Library</div>
            <h2 id="style-library-detail-title" className="font-bold text-[20px]">
              {style.style_name}
            </h2>
            <div className="text-[13px] text-brand">{style.style_number}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-panel" aria-label="Close details" data-testid="style-library-detail-close">
            <X size={20} />
          </button>
        </div>
        <div className="grid gap-6 md:grid-cols-[340px,1fr]">
          <button
            type="button"
            onClick={() => setZoom(true)}
            className="w-full aspect-square overflow-hidden rounded-lg bg-[#F5F5F0] grid place-items-center cursor-zoom-in"
            aria-label="Enlarge style photo"
          >
            <LibraryImage style={style.style_name} url={style.image_url} testId="style-library-detail-image" />
          </button>
          <div>
            {error ? <ErrorBox message={error} /> : !detail ? (
              <Loading label="Loading style details…" />
            ) : (
              <>
                <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${style.status === "Retired" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                  {style.status}
                </span>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3 mt-4" data-testid="style-library-detail-fields">
                  {rows.map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
                      <dd className="text-[14px] font-medium break-words">{value || "—"}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        </div>
      </div>
      {zoom && (
        <Lightbox
          url={style.image_url}
          caption={`${style.style_name} · ${style.style_number}`}
          onClose={() => setZoom(false)}
        />
      )}
    </div>,
    document.body,
  );
};

const AddStyleModal = ({ onClose, onCreated }) => {
  const dialogRef = useRef(null);
  const [form, setForm] = useState(initialForm);
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const subcategories = subcategoriesForLibraryCategory(form.category);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const handleDialogKey = useDialogFocus(dialogRef, onClose, saving);

  const update = (key, value) => {
    setError("");
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "category" ? { sub_category: "" } : {}),
    }));
  };

  const pickPhoto = (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) {
      setError("Choose a JPG, PNG or WebP photo.");
      event.target.value = "";
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError("Photo is too large (maximum 5 MB).");
      event.target.value = "";
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
    setError("");
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (!photo) {
      setError("Photo is required.");
      return;
    }
    if (form.launch_date && form.adoption_date && form.adoption_date < form.launch_date) {
      setError("Adoption Date cannot be before Launch Date.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = new FormData();
      Object.entries(form).forEach(([key, value]) => body.append(key, value));
      body.append("photo", photo);
      const { data } = await api.post("/style-library", body);
      onCreated(data);
    } catch (err) {
      setError(err?.response?.data?.detail || "Couldn't save this style. Please check the form and try again.");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-style-title"
      data-testid="add-style-modal"
    >
      <form ref={dialogRef} onKeyDown={handleDialogKey} onSubmit={submit} className="card-white w-full max-w-3xl mx-auto my-2 rounded-xl shadow-xl p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 id="add-style-title" className="font-bold text-[20px]">Add Style</h2>
            <p className="text-[12.5px] text-muted">Create a manual library record with one product photo.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="p-1.5 rounded hover:bg-panel disabled:opacity-40" aria-label="Close form" data-testid="add-style-close">
            <X size={20} />
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            ["style_name", "Style Name"],
            ["style_number", "Style Number"],
            ["fabric", "Fabric"],
          ].map(([key, label]) => (
            <label key={key} className="space-y-1">
              <span className="text-[12px] font-semibold">{label} *</span>
              <input required maxLength={200} value={form[key]} onChange={(event) => update(key, event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand" data-testid={`add-style-${key}`} />
            </label>
          ))}
          <label className="space-y-1">
            <span className="text-[12px] font-semibold">Category *</span>
            <select required value={form.category} onChange={(event) => update("category", event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand" data-testid="add-style-category">
              <option value="">Select category</option>
              {STYLE_LIBRARY_CATEGORIES.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[12px] font-semibold">Sub Category *</span>
            <select required disabled={!form.category} value={form.sub_category} onChange={(event) => update("sub_category", event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand disabled:opacity-50" data-testid="add-style-sub-category">
              <option value="">Select sub category</option>
              {subcategories.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[12px] font-semibold">Brand *</span>
            <select required value={form.brand} onChange={(event) => update("brand", event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand" data-testid="add-style-brand">
              {BRANDS.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[12px] font-semibold">Status *</span>
            <select required value={form.status} onChange={(event) => update("status", event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand" data-testid="add-style-status">
              {STATUSES.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[12px] font-semibold">Launch Date <span className="font-normal text-muted">(optional)</span></span>
            <input type="date" value={form.launch_date} onChange={(event) => update("launch_date", event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand" data-testid="add-style-launch-date" />
          </label>
          <label className="space-y-1">
            <span className="text-[12px] font-semibold">Adoption Date <span className="font-normal text-muted">(optional)</span></span>
            <input type="date" value={form.adoption_date} onChange={(event) => update("adoption_date", event.target.value)} className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-card outline-none focus:border-brand" data-testid="add-style-adoption-date" />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-[12px] font-semibold">Photo *</span>
            <span className="flex flex-col sm:flex-row items-start sm:items-center gap-3 border border-dashed border-border rounded-lg p-3">
              {preview ? <img src={preview} alt="Selected style preview" className="w-24 h-24 object-contain rounded bg-[#F5F5F0]" data-testid="add-style-photo-preview" /> : <span className="w-24 h-24 rounded bg-panel grid place-items-center text-muted"><UploadSimple size={24} /></span>}
              <span>
                <input required type="file" accept="image/jpeg,image/png,image/webp" onChange={pickPhoto} className="block text-[12px]" data-testid="add-style-photo" />
                <span className="block text-[11px] text-muted mt-1">JPG, PNG or WebP, maximum 5 MB.</span>
              </span>
            </span>
          </label>
        </div>
        {error && <div className="mt-4 text-[13px] text-danger border border-danger/40 rounded-md p-3" role="alert" data-testid="add-style-error">{error}</div>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-[13px] rounded-md hover:bg-panel disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-[13px] font-semibold rounded-md bg-brand text-white hover:bg-brand-deep disabled:opacity-50" data-testid="add-style-submit">
            {saving ? "Saving…" : "Save Style"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

const StyleLibrary = () => {
  const { user } = useAuth();
  const canCreate = ["product_development", "admin"].includes(String(user?.role || "").toLowerCase());
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [fabric, setFabric] = useState("");
  const [brand, setBrand] = useState("");
  const [status, setStatus] = useState("");
  const [facets, setFacets] = useState(null);
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [active, setActive] = useState(null);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(term.trim()), 300);
    return () => clearTimeout(timer);
  }, [term]);

  const loadFacets = useCallback(() => {
    api.get("/style-library/facets")
      .then(({ data }) => setFacets(data))
      .catch(() => setFacets(null));
  }, []);

  useEffect(() => { loadFacets(); }, [loadFacets]);

  const fetchPage = useCallback(async (off, append) => {
    const mine = ++requestId.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setError("");
    }
    try {
      const { data } = await api.get("/style-library/search", {
        params: {
          q: query, category, sub_category: subCategory, fabric, brand, status,
          limit: PAGE_SIZE, offset: off,
        },
      });
      if (mine !== requestId.current) return;
      const next = Array.isArray(data?.items) ? data.items : [];
      setItems((current) => append ? [...current, ...next] : next);
      setHasMore(Boolean(data?.has_more));
      setOffset(off + next.length);
    } catch (err) {
      if (mine !== requestId.current) return;
      if (!append) setItems([]);
      setError(err?.response?.data?.detail || "Couldn't load the Style Library.");
    } finally {
      if (mine === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [brand, category, fabric, query, status, subCategory]);

  useEffect(() => {
    setOffset(0);
    fetchPage(0, false);
  }, [fetchPage]);

  const subcategories = useMemo(
    () => facets?.categories?.find((item) => item.name === category)?.sub_categories || [],
    [category, facets],
  );
  const anyFilter = Boolean(query || category || subCategory || fabric || brand || status);

  const clearFilters = () => {
    setTerm("");
    setQuery("");
    setCategory("");
    setSubCategory("");
    setFabric("");
    setBrand("");
    setStatus("");
  };

  const created = (style) => {
    setAdding(false);
    clearFilters();
    setItems((current) => [style, ...current.filter((item) => item.id !== style.id)]);
    setOffset((current) => current + 1);
    loadFacets();
  };

  return (
    <div className="space-y-4" data-testid="style-library-page">
      <SectionTitle
        title="Style Library"
        subtitle="Browse proposed and manually entered styles without mixing them into the Odoo Product Catalogue."
        testId="style-library-header"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72">
              <MagnifyingGlass size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              <input value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search style, number, fabric…" className="w-full border border-border rounded-md pl-8 pr-8 py-2 text-[13px] outline-none focus:border-brand bg-card" data-testid="style-library-search" />
              {term && <button type="button" onClick={() => setTerm("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted" aria-label="Clear search"><X size={14} /></button>}
            </div>
            {canCreate && (
              <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-md bg-brand text-white px-4 py-2 text-[13px] font-semibold hover:bg-brand-deep" data-testid="style-library-add">
                <Plus size={16} /> Add Style
              </button>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-2" data-testid="style-library-filters">
        <FunnelSimple size={15} className="text-muted" />
        <select value={brand} onChange={(event) => setBrand(event.target.value)} className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card">
          <option value="">All brands</option>
          {(facets?.brands || BRANDS).map((value) => <option key={value}>{value}</option>)}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card">
          <option value="">All statuses</option>
          {(facets?.statuses || STATUSES).map((value) => <option key={value}>{value}</option>)}
        </select>
        <select value={category} onChange={(event) => { setCategory(event.target.value); setSubCategory(""); }} className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card" data-testid="style-library-category-filter">
          <option value="">All categories</option>
          {(facets?.categories || []).map((value) => <option key={value.name} value={value.name}>{value.name}</option>)}
        </select>
        <select value={subCategory} onChange={(event) => setSubCategory(event.target.value)} disabled={!category} className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card disabled:opacity-50">
          <option value="">All sub categories</option>
          {subcategories.map((value) => <option key={value.name} value={value.name}>{value.name}</option>)}
        </select>
        <select value={fabric} onChange={(event) => setFabric(event.target.value)} className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card max-w-[200px]">
          <option value="">All fabrics</option>
          {(facets?.fabrics || []).map((value) => <option key={value}>{value}</option>)}
        </select>
        {anyFilter && <button type="button" onClick={clearFilters} className="text-[12px] text-brand hover:underline">Clear filters</button>}
      </div>
      {loading ? <Loading label="Loading styles…" /> : error ? <ErrorBox message={error} /> : items.length === 0 ? (
        <Empty label={anyFilter ? "No styles match the current search or filters." : "No styles have been added to the library yet."} />
      ) : (
        <>
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6" data-testid="style-library-grid">
            {items.map((style) => <StyleCard key={style.id} style={style} onOpen={setActive} />)}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-2">
              <button type="button" onClick={() => fetchPage(offset, true)} disabled={loadingMore} className="text-[13px] px-4 py-2 rounded-md border border-border hover:bg-panel disabled:opacity-50" data-testid="style-library-load-more">
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
      {adding && <AddStyleModal onClose={() => setAdding(false)} onCreated={created} />}
      {active && <DetailModal summary={active} onClose={() => setActive(null)} />}
    </div>
  );
};

export default StyleLibrary;