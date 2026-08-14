import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useCart } from "@/context/CartContext";
import { useAuthImage, dropAuthImage } from "./authImage";
import { btnPrimary, btnSecondary, cardCls, kes, ImagePlaceholder } from "./ui";
import {
  ArrowLeft, Camera, Check, ChevronRight, Loader2, Lock, ShoppingBag,
  Sparkles, Share2, Trash2, Upload, User, X,
} from "lucide-react";

// Copy fixed by product spec — do not reword.
const PRIVACY_COPY = "Your photos are private. We use them only to create your try-ons, and you can delete them anytime.";
const FRAMING_COPY = "See it on you — a fun AI preview of the look. For the perfect fit, check the size guide and community fit notes.";
const LOADING_LINES = ["Styling you…", "Draping the fabric…", "Perfecting the fall…", "Almost there…"];
const HANDOFF_KEY = "vivo_tryon_sku";
const displaySize = (s) => (s === "F" ? "One Size" : s);

// Client-side downscale before upload: phone photos are 3–12MB straight off
// the camera; the API caps uploads at ~3MB and the AI call gets faster with
// smaller inputs. 1280px long edge keeps plenty of detail for styling.
async function fileToB64(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That file doesn't look like a photo"));
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

function PhotoTile({ photo, selected, onSelect, onDelete, deleting }) {
  const url = useAuthImage(`/tryon/photos/${photo.id}/image`);
  return (
    <div className="relative group">
      <button
        type="button"
        data-testid={`tryon-photo-${photo.id}`}
        onClick={onSelect}
        aria-pressed={selected}
        className={`relative w-full aspect-[3/4] rounded overflow-hidden border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          selected ? "border-primary shadow-md" : "border-border hover:border-foreground/40"
        }`}
      >
        {url ? (
          <img src={url} alt="Your photo" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-secondary animate-pulse" />
        )}
        {selected && (
          <span className="absolute top-2 left-2 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
            <Check size={13} strokeWidth={3} />
          </span>
        )}
      </button>
      {onDelete && (
        <button
          type="button"
          data-testid={`tryon-photo-delete-${photo.id}`}
          aria-label="Delete this photo"
          onClick={onDelete}
          disabled={deleting}
          className="absolute top-2 right-2 w-8 h-8 rounded-full bg-background/90 backdrop-blur border border-border flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function GarmentCard({ p, selected, onPick }) {
  return (
    <button
      type="button"
      data-testid={`tryon-garment-${p.sku}`}
      onClick={onPick}
      aria-pressed={selected}
      className={`text-left rounded overflow-hidden border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        selected ? "border-primary shadow-md" : "border-border hover:border-foreground/40"
      }`}
    >
      <div className="aspect-[3/4] bg-secondary relative">
        <img src={p.image_url} alt={p.name} loading="lazy" className="w-full h-full object-contain" />
        {selected && (
          <span className="absolute top-2 left-2 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
            <Check size={13} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="p-2.5 bg-card">
        <div className="text-[12px] font-medium text-foreground leading-snug line-clamp-2">{p.name}</div>
        {p.price > 0 && <div className="text-[12px] text-primary-ink font-medium mt-0.5">{kes(p.price)}</div>}
      </div>
    </button>
  );
}

function LookThumb({ look, onOpen }) {
  const url = useAuthImage(look.status === "done" ? `/tryon/looks/${look.id}/image` : "");
  return (
    <button
      type="button"
      data-testid={`tryon-look-card-${look.id}`}
      onClick={onOpen}
      className="shrink-0 w-32 text-left rounded overflow-hidden border border-border hover:border-foreground/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="aspect-[3/4] bg-secondary relative">
        {look.status === "done" && url ? (
          <img src={url} alt={look.product_name} className="w-full h-full object-cover" />
        ) : look.status === "pending" ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-[10px] uppercase tracking-wider font-semibold">Styling…</span>
          </div>
        ) : look.status === "failed" ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-muted-foreground p-2 text-center">
            <X size={16} />
            <span className="text-[10px] leading-snug">Didn't work — not counted</span>
          </div>
        ) : (
          <div className="w-full h-full bg-secondary animate-pulse" />
        )}
        {look.is_shared && (
          <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-background/90 border border-border flex items-center justify-center text-primary-ink">
            <Share2 size={11} />
          </span>
        )}
        {look.demo && look.status === "done" && (
          <span className="absolute bottom-1.5 left-1.5 bg-foreground/85 text-background text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm">
            Demo
          </span>
        )}
      </div>
      <div className="p-2 bg-card">
        <div className="text-[11px] font-medium text-foreground leading-snug line-clamp-2">{look.product_name}</div>
      </div>
    </button>
  );
}

// "Add to Bag" from the result card: sizes are fetched fresh (the look may be
// days old) and the line goes through the same CartContext the PDP uses.
function AddToBagPanel({ sku, onClose }) {
  const { add } = useCart();
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    let alive = true;
    api.product(sku)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [sku]);

  const doAdd = () => {
    if (!sel || !detail) return;
    add({
      key: sel.sku,
      sku: detail.sku,
      name: detail.name,
      color: detail.color,
      size: displaySize(sel.size),
      qty: 1,
      price: detail.price,
      image: detail.images?.[0] || "",
      maxStock: 5,
    });
    setAdded(true);
    setTimeout(onClose, 900);
  };

  return (
    <div data-testid="tryon-bag-panel" className="rounded border border-border bg-secondary/40 p-4 space-y-3">
      {err ? (
        <p className="text-[13px] text-muted-foreground">Couldn't load sizes — {err}</p>
      ) : !detail ? (
        <div className="h-11 bg-secondary rounded animate-pulse" />
      ) : (
        <>
          <div className="text-[12px] font-bold uppercase tracking-wider text-foreground">Pick your size</div>
          <div className="flex flex-wrap gap-2">
            {(detail.sizes || []).map((s) => {
              const dead = !s.in_stock;
              const on = sel?.sku === s.sku;
              return (
                <button
                  key={s.sku}
                  type="button"
                  data-testid={`tryon-size-${s.size}`}
                  disabled={dead}
                  aria-pressed={on}
                  onClick={() => setSel(s)}
                  className={`min-w-[48px] h-10 px-3 rounded border text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    dead
                      ? "border-border/60 bg-secondary/40 text-muted-foreground/50 line-through cursor-not-allowed"
                      : on
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background text-foreground hover:border-foreground"
                  }`}
                >
                  {displaySize(s.size)}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button type="button" data-testid="tryon-bag-confirm" onClick={doAdd} disabled={!sel || added} className={btnPrimary}>
              {added ? <><Check size={15} /> In your Bag</> : <><ShoppingBag size={15} /> Add to Bag</>}
            </button>
            <button type="button" onClick={onClose} aria-label="Close size picker" className="h-11 px-4 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <X size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function TryOnView({ onBack, member }) {
  const [allowance, setAllowance] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [looks, setLooks] = useState([]);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState("photo"); // photo | garment | generating | result
  const [selPhotoId, setSelPhotoId] = useState(null);
  const [garment, setGarment] = useState(null); // {sku, name, price, image_url}
  const [browse, setBrowse] = useState({ items: [], cats: [], filter: "All", hasMore: false, loading: false });
  const [currentLookId, setCurrentLookId] = useState(null);
  const [currentLook, setCurrentLook] = useState(null);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deletingPhoto, setDeletingPhoto] = useState(null);
  const [loadLine, setLoadLine] = useState(0);
  const [shareConfirm, setShareConfirm] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  // Per-item marketing consent for the shared look — never pre-ticked (DPA).
  const [shareMarketing, setShareMarketing] = useState(false);
  const [bagOpen, setBagOpen] = useState(false);
  const [deleteArm, setDeleteArm] = useState(false);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const refreshAllowance = useCallback(() => {
    api.tryonAllowance().then(setAllowance).catch(() => {});
  }, []);
  const refreshLooks = useCallback(() => {
    api.tryonLooks().then((d) => setLooks(d.items || [])).catch(() => {});
  }, []);

  // Mount: allowance + photos + looks in parallel, plus the PDP hand-off SKU
  // (sessionStorage — the shell's URL param set is fixed, and the SKU only
  // matters for this one entry).
  useEffect(() => {
    let alive = true;
    let handoff = "";
    try {
      handoff = sessionStorage.getItem(HANDOFF_KEY) || "";
      sessionStorage.removeItem(HANDOFF_KEY);
    } catch { /* private mode */ }
    Promise.all([
      api.tryonAllowance().catch(() => null),
      api.tryonPhotos().catch(() => ({ items: [] })),
      api.tryonLooks().catch(() => ({ items: [] })),
      handoff ? api.product(handoff).catch(() => null) : Promise.resolve(null),
    ]).then(([a, p, l, prod]) => {
      if (!alive) return;
      if (a) setAllowance(a);
      setPhotos(p.items || []);
      setLooks(l.items || []);
      if ((p.items || []).length > 0) setSelPhotoId(p.items[0].id);
      if (prod) {
        setGarment({ sku: prod.sku, name: prod.name, price: prod.price, image_url: prod.images?.[0] || "" });
      }
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  // Garment browse grid (lazy — first time the garment step is shown).
  const loadBrowse = useCallback((filter, offset) => {
    setBrowse((b) => ({ ...b, loading: true, filter }));
    api.products({ category: filter === "All" ? "" : filter, limit: 12, offset })
      .then((d) => setBrowse((b) => ({
        items: offset ? [...b.items, ...d.items] : d.items,
        cats: d.categories || b.cats,
        filter,
        hasMore: !!d.has_more,
        loading: false,
      })))
      .catch(() => setBrowse((b) => ({ ...b, loading: false })));
  }, []);
  useEffect(() => {
    if (step === "garment" && browse.items.length === 0 && !browse.loading) loadBrowse("All", 0);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the pending look. Failed attempts are never counted (server rule),
  // so on failure we send her back to the garment step with the reason.
  useEffect(() => {
    if (step !== "generating" || !currentLookId) return undefined;
    let alive = true;
    let timer = null;
    const t0 = Date.now();
    const tick = async () => {
      try {
        const d = await api.tryonLook(currentLookId);
        if (!alive) return;
        if (d.status === "done") {
          setCurrentLook(d);
          setStep("result");
          setShareConfirm(false); setBagOpen(false); setDeleteArm(false);
          refreshLooks(); refreshAllowance();
          return;
        }
        if (d.status === "failed") {
          setErr(d.error || "Styling didn't work this time — please try again.");
          setStep("garment");
          refreshLooks(); refreshAllowance();
          return;
        }
      } catch { /* transient — keep polling */ }
      if (Date.now() - t0 > 150000) {
        if (alive) {
          setErr("This is taking longer than usual — your look will appear in My Looks when it's ready.");
          setStep("garment");
        }
        return;
      }
      timer = setTimeout(tick, 2500);
    };
    timer = setTimeout(tick, 2500);
    return () => { alive = false; clearTimeout(timer); };
  }, [step, currentLookId, refreshLooks, refreshAllowance]);

  // Warm rotating copy while she waits.
  useEffect(() => {
    if (step !== "generating") return undefined;
    setLoadLine(0);
    const t = setInterval(() => setLoadLine((n) => (n + 1) % LOADING_LINES.length), 3200);
    return () => clearInterval(t);
  }, [step]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    setUploading(true);
    try {
      const b64 = await fileToB64(file);
      const d = await api.tryonUploadPhoto(b64);
      const p = { id: d.id, mime: "image/jpeg", created_at: d.created_at };
      setPhotos((prev) => [p, ...prev]);
      setSelPhotoId(d.id);
    } catch (ex) {
      setErr(ex.message);
    }
    setUploading(false);
  };

  const deletePhoto = async (id) => {
    setDeletingPhoto(id);
    try {
      await api.tryonDeletePhoto(id);
      dropAuthImage(`/tryon/photos/${id}/image`);
      setPhotos((prev) => prev.filter((p) => p.id !== id));
      if (selPhotoId === id) setSelPhotoId(null);
    } catch (ex) {
      setErr(ex.message);
    }
    setDeletingPhoto(null);
  };

  const generate = async () => {
    if (!selPhotoId || !garment) return;
    setErr("");
    try {
      const d = await api.tryonCreateLook(selPhotoId, garment.sku);
      setCurrentLookId(d.id);
      setCurrentLook(null);
      setStep("generating");
      setAllowance((a) => (a ? { ...a, used: a.used + 1, remaining: d.remaining } : a));
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const openLook = (look) => {
    setErr("");
    if (look.status === "done") {
      setCurrentLookId(look.id);
      setCurrentLook(look);
      setStep("result");
      setShareConfirm(false); setBagOpen(false); setDeleteArm(false);
    } else if (look.status === "pending") {
      setCurrentLookId(look.id);
      setCurrentLook(null);
      setStep("generating");
    }
  };

  const toggleShare = async (share) => {
    if (!currentLook) return;
    setShareBusy(true);
    try {
      // Consent travels only on share (when the box was shown); unshare
      // leaves the marketing choice untouched — they're independent.
      await api.tryonShare(currentLook.id, share, share ? shareMarketing : undefined);
      setCurrentLook((l) => ({ ...l, is_shared: share }));
      setShareConfirm(false);
      refreshLooks();
    } catch (ex) {
      setErr(ex.message);
    }
    setShareBusy(false);
  };

  const deleteLook = async () => {
    if (!currentLook) return;
    try {
      await api.tryonDeleteLook(currentLook.id);
      dropAuthImage(`/tryon/looks/${currentLook.id}/image`);
      setCurrentLook(null);
      setCurrentLookId(null);
      setDeleteArm(false);
      refreshLooks();
      setStep(photos.length ? "garment" : "photo");
    } catch (ex) {
      setErr(ex.message);
    }
  };

  const resultUrl = useAuthImage(
    step === "result" && currentLook ? `/tryon/looks/${currentLook.id}/image` : ""
  );

  const remaining = allowance ? Math.max(0, allowance.limit - allowance.used) : null;
  const outOfTries = remaining !== null && remaining <= 0;

  if (!ready) {
    return (
      <div data-testid="tryon-view" className="max-w-2xl mx-auto animate-in fade-in duration-300">
        <div className="h-11 w-24 bg-secondary rounded animate-pulse mb-6" />
        <div className="h-8 w-2/3 bg-secondary rounded animate-pulse mb-4" />
        <div className="aspect-[3/2] bg-secondary rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div data-testid="tryon-view" className="max-w-2xl mx-auto animate-in fade-in duration-500 pb-10">
      <div className="flex items-center justify-between mb-4">
        <button
          data-testid="tryon-back"
          onClick={step === "result" ? () => { setStep(photos.length ? "garment" : "photo"); setCurrentLook(null); setCurrentLookId(null); } : onBack}
          className="flex items-center gap-2 min-h-[44px] text-[12px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <ArrowLeft size={15} /> {step === "result" ? "Try-On" : "Back"}
        </button>
        {allowance && step !== "generating" && (
          <span data-testid="tryon-remaining" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {remaining} of {allowance.limit} left this week
          </span>
        )}
      </div>

      {step !== "result" && (
        <div className="mb-8">
          <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5 flex items-center gap-1.5">
            <Sparkles size={11} /> Virtual Try-On
          </div>
          <h2 className="font-serif text-2xl sm:text-3xl text-foreground leading-tight">See it on you</h2>
          <p className="text-[13px] text-muted-foreground mt-1.5 max-w-md">{FRAMING_COPY}</p>
        </div>
      )}

      {allowance?.demo && step !== "result" && (
        <div data-testid="tryon-demo-banner" className="mb-6 rounded border border-border bg-secondary/60 px-4 py-3 text-[13px] text-foreground/80">
          <span className="font-semibold uppercase tracking-wider text-[11px] mr-2">Demo mode</span>
          Previews are illustrative composites while AI styling is switched off.
        </div>
      )}

      {err && (
        <div data-testid="tryon-error" className="mb-6 rounded bg-destructive/5 border border-destructive/20 text-destructive text-[13px] font-medium px-4 py-3 flex items-start justify-between gap-3">
          <span>{err}</span>
          <button type="button" onClick={() => setErr("")} aria-label="Dismiss" className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X size={14} /></button>
        </div>
      )}

      {/* ---------- STEP: photo ---------- */}
      {step === "photo" && (
        <div className="space-y-6">
          <div className={`${cardCls} p-5 sm:p-6`}>
            <div className="flex items-start gap-3 mb-4">
              <span className="w-9 h-9 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
                <User size={16} strokeWidth={1.5} />
              </span>
              <div>
                <div className="font-medium text-foreground text-[15px]">1 · Your photo</div>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  Best results: full-length, facing the camera, in good light.
                </p>
              </div>
            </div>

            {photos.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-4">
                {photos.map((p) => (
                  <PhotoTile
                    key={p.id}
                    photo={p}
                    selected={selPhotoId === p.id}
                    onSelect={() => setSelPhotoId(p.id)}
                    onDelete={() => deletePhoto(p.id)}
                    deleting={deletingPhoto === p.id}
                  />
                ))}
              </div>
            )}

            <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={onFile} data-testid="tryon-upload-input" />
            <input ref={cameraRef} type="file" accept="image/*" capture="user" className="hidden" onChange={onFile} />
            <div className="flex flex-col sm:flex-row gap-2.5">
              <button type="button" data-testid="tryon-upload-btn" onClick={() => fileRef.current?.click()} disabled={uploading} className={btnSecondary}>
                {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} Upload a photo
              </button>
              <button type="button" data-testid="tryon-camera-btn" onClick={() => cameraRef.current?.click()} disabled={uploading} className={btnSecondary}>
                <Camera size={15} /> Take a photo
              </button>
            </div>
            <p className="text-[12px] text-muted-foreground mt-3.5 flex items-start gap-1.5 leading-relaxed">
              <Lock size={12} className="shrink-0 mt-0.5" /> {PRIVACY_COPY}
            </p>
          </div>

          <button
            type="button"
            data-testid="tryon-continue-btn"
            onClick={() => setStep("garment")}
            disabled={!selPhotoId}
            className={btnPrimary}
          >
            Continue <ChevronRight size={15} />
          </button>

          {looks.length > 0 && (
            <section data-testid="tryon-my-looks">
              <h3 className="font-serif text-lg text-foreground mb-3">My looks</h3>
              <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
                {looks.map((l) => <LookThumb key={l.id} look={l} onOpen={() => openLook(l)} />)}
              </div>
              <p className="text-[12px] text-muted-foreground mt-1.5 flex items-center gap-1.5">
                <Lock size={11} /> Your lookbook is private unless you share a look.
              </p>
            </section>
          )}
        </div>
      )}

      {/* ---------- STEP: garment ---------- */}
      {step === "garment" && (
        <div className="space-y-6">
          <div className={`${cardCls} p-5 sm:p-6`}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
                  <Sparkles size={16} strokeWidth={1.5} />
                </span>
                <div>
                  <div className="font-medium text-foreground text-[15px]">2 · Pick the piece</div>
                  <p className="text-[13px] text-muted-foreground mt-0.5">Choose what you'd like to see on you.</p>
                </div>
              </div>
              <button
                type="button"
                data-testid="tryon-change-photo"
                onClick={() => setStep("photo")}
                className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors min-h-[44px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Change photo
              </button>
            </div>

            {garment && (
              <div data-testid="tryon-picked-garment" className="flex items-center gap-3 rounded border border-primary/40 bg-secondary/40 p-3 mb-4">
                <img src={garment.image_url} alt="" className="w-14 h-14 object-contain rounded border border-border bg-background shrink-0" />
                <div className="flex-grow min-w-0">
                  <div className="text-[14px] font-medium text-foreground truncate">{garment.name}</div>
                  {garment.price > 0 && <div className="text-[12px] text-primary-ink font-medium">{kes(garment.price)}</div>}
                </div>
                <button type="button" onClick={() => setGarment(null)} aria-label="Clear selection" className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <X size={15} />
                </button>
              </div>
            )}

            <div className="flex gap-2 mb-4 overflow-x-auto hide-scrollbar pb-1">
              {["All", ...browse.cats.slice(0, 6).map((c) => c.name)].map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => loadBrowse(b, 0)}
                  className={`px-4 py-1.5 rounded-sm text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    browse.filter === b
                      ? "bg-foreground text-background"
                      : "bg-background text-muted-foreground hover:bg-secondary border border-border"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-3">
              {browse.items.map((p) => (
                <GarmentCard
                  key={p.sku}
                  p={{ sku: p.sku, name: p.style_name, price: p.price, image_url: p.image_url }}
                  selected={garment?.sku === p.sku}
                  onPick={() => setGarment({ sku: p.sku, name: p.style_name, price: p.price, image_url: p.image_url })}
                />
              ))}
              {browse.loading && browse.items.length === 0 &&
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="aspect-[3/4] bg-secondary rounded animate-pulse" />
                ))}
            </div>
            {browse.hasMore && !browse.loading && (
              <button
                type="button"
                onClick={() => loadBrowse(browse.filter, browse.items.length)}
                className="mt-4 w-full h-10 rounded border border-border text-[12px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                More pieces
              </button>
            )}
          </div>

          <button
            type="button"
            data-testid="tryon-generate-btn"
            onClick={generate}
            disabled={!garment || !selPhotoId || outOfTries}
            className={btnPrimary}
          >
            <Sparkles size={15} /> Style me in this
          </button>
          {outOfTries && allowance && (
            <p data-testid="tryon-out-of-tries" className="text-[13px] text-muted-foreground text-center -mt-2">
              You've used all {allowance.limit} try-ons this week — your allowance resets on Monday.
              {allowance.tier !== "Tanzanite" && " Ruby members get 5 a week, Tanzanite 10."}
            </p>
          )}
        </div>
      )}

      {/* ---------- STEP: generating ---------- */}
      {step === "generating" && (
        <div data-testid="tryon-generating" className={`${cardCls} p-8 sm:p-12 text-center`}>
          <div className="relative w-20 h-20 mx-auto mb-6">
            <div className="absolute inset-0 rounded-full border-2 border-border" />
            <div className="absolute inset-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <span className="absolute inset-0 flex items-center justify-center text-primary-ink">
              <Sparkles size={22} />
            </span>
          </div>
          <div data-testid="tryon-status" aria-live="polite" className="font-serif text-xl text-foreground mb-2">
            {LOADING_LINES[loadLine]}
          </div>
          <p className="text-[13px] text-muted-foreground">This usually takes 10–30 seconds — worth the wait.</p>
        </div>
      )}

      {/* ---------- STEP: result ---------- */}
      {step === "result" && currentLook && (
        <div className="space-y-5">
          <div className={`${cardCls} overflow-hidden`}>
            <div className="relative bg-secondary">
              {resultUrl ? (
                <img data-testid="tryon-result-img" src={resultUrl} alt={`You in ${currentLook.product_name}`} className="w-full max-h-[70vh] object-contain" />
              ) : (
                <div className="aspect-[3/4] animate-pulse" />
              )}
              {currentLook.demo && (
                <span data-testid="tryon-demo-badge" className="absolute top-3 left-3 bg-foreground/85 text-background text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-sm">
                  Demo preview
                </span>
              )}
            </div>
            <div className="p-5 sm:p-6">
              <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">Styled on you</div>
              <h2 className="font-serif text-2xl text-foreground leading-tight mb-2">{currentLook.product_name}</h2>
              <p className="text-[13px] text-muted-foreground leading-relaxed">{FRAMING_COPY}</p>
              <p className="text-[12px] text-muted-foreground mt-3 flex items-center gap-1.5">
                {currentLook.is_shared
                  ? <><Share2 size={12} className="text-primary-ink" /> Shared to the community feed</>
                  : <><Lock size={12} /> Saved to your private lookbook — only you can see it</>}
              </p>
            </div>
          </div>

          <div className="space-y-2.5">
            <button type="button" data-testid="tryon-try-another" onClick={() => { setStep("garment"); setGarment(null); setCurrentLook(null); setCurrentLookId(null); }} className={btnPrimary}>
              <Sparkles size={15} /> Try another piece
            </button>

            {bagOpen ? (
              <AddToBagPanel sku={currentLook.product_sku} onClose={() => setBagOpen(false)} />
            ) : (
              <button type="button" data-testid="tryon-add-bag" onClick={() => setBagOpen(true)} className={btnSecondary}>
                <ShoppingBag size={15} /> Add to Bag
              </button>
            )}

            {shareConfirm ? (
              <div data-testid="tryon-share-confirm" className="rounded border border-border bg-secondary/40 p-4 space-y-3">
                <p className="text-[13px] text-foreground/85 leading-relaxed">
                  Share this look with the community? Members will see the image and your username. You can remove it anytime.
                </p>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    data-testid="tryon-share-marketing"
                    type="checkbox"
                    checked={shareMarketing}
                    onChange={(e) => setShareMarketing(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-primary cursor-pointer shrink-0"
                  />
                  <span className="text-[12px] leading-relaxed text-muted-foreground">
                    Vivo may also feature this look in Vivo&apos;s marketing (social media, website).
                    <span className="block text-[11px] mt-0.5 opacity-80">
                      Optional — sharing works the same either way, and you can change this anytime in Profile → My data.
                    </span>
                  </span>
                </label>
                <div className="flex gap-2">
                  <button type="button" data-testid="tryon-share-yes" onClick={() => toggleShare(true)} disabled={shareBusy} className={btnPrimary}>
                    {shareBusy ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />} Share it
                  </button>
                  <button type="button" data-testid="tryon-share-no" onClick={() => setShareConfirm(false)} className={btnSecondary}>
                    Not now
                  </button>
                </div>
              </div>
            ) : currentLook.is_shared ? (
              <button type="button" data-testid="tryon-unshare-btn" onClick={() => toggleShare(false)} disabled={shareBusy} className={btnSecondary}>
                <X size={15} /> Remove from the feed
              </button>
            ) : (
              // Consent is never pre-ticked (DPA) — reset every time the panel opens.
              <button type="button" data-testid="tryon-share-btn" onClick={() => { setShareMarketing(false); setShareConfirm(true); }} className={btnSecondary}>
                <Share2 size={15} /> Share to the community feed
              </button>
            )}

            <button
              type="button"
              data-testid="tryon-delete-look"
              onClick={deleteArm ? deleteLook : () => setDeleteArm(true)}
              className="w-full h-11 rounded text-[13px] font-medium text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Trash2 size={14} /> {deleteArm ? "Tap again to delete this look" : "Delete this look"}
            </button>
          </div>

          {allowance && (
            <p className="text-[12px] text-muted-foreground text-center">
              {remaining} of {allowance.limit} try-ons left this week — a {allowance.tier} Johari perk.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
