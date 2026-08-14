import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ArrowLeft, UploadCloud, Store, Truck, Check } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { inputCls } from "./ui";

/* Redemption flow for the Personalised Embroidered Tank — the one reward
   with a real fulfilment pipeline behind it. Portaled to <body> (a
   transform/filter ancestor must never trap the fixed overlay) and laid out
   as a bottom sheet on mobile, centred panel on desktop, like ProductDetail.

   The design preview is the heart of it: the member's artwork (or monogram)
   sits composited on the chest of the actual tank photo, not in a bare
   file-upload form. */

const MONO_FONTS = {
  serif: { cls: "font-serif italic", style: {} },
  block: { cls: "font-sans font-bold uppercase tracking-[0.2em]", style: {} },
  script: { cls: "italic", style: { fontFamily: "'Segoe Script','Brush Script MT',cursive" } },
};

/* Read + gently downscale an uploaded design so previews stay snappy and
   the stored file stays well under the server's 3MB cap. PNG keeps its
   transparency — ideal for chest placement. */
async function fileToDesign(file) {
  if (!/^image\/(png|jpe?g)$/.test(file.type)) {
    throw new Error("PNG or JPG designs only");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Keep the file under 8MB — a photo-size export is plenty");
  }
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Couldn't read that file — please try again"));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("That image couldn't be opened — try a different file"));
    i.src = dataUrl;
  });
  const MAX = 1000;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  let out = dataUrl;
  if (scale < 1) {
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL(mime, 0.92);
  }
  return { dataUrl: out, b64: out.split(",")[1], mime };
}

/* Member-owned design thumbnail. The endpoint is Bearer-gated and native
   <img> loads can't carry the token, so this fetches to a blob URL. */
export function DesignThumb({ id, className = "" }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    let url = null;
    fetch(`/api/community/rewards/redemptions/${id}/design`, {
      headers: { Authorization: "Bearer " + getToken() },
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!alive || !b) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (!src) return <div className={`${className} animate-pulse`} aria-hidden="true" />;
  return <img src={src} alt="Your design" className={className} />;
}

/* The tank photo with the member's design composited on the chest area.
   mix-blend-multiply lets the rib texture show through, which is exactly
   how a stitch reads on fabric. */
function TankPreview({ image, design, className = "" }) {
  const monoPx = design?.kind === "monogram" && design.text
    ? Math.max(12, Math.min(28, Math.round(192 / Math.max(6, design.text.length))))
    : 0;
  const font = design?.kind === "monogram" ? (MONO_FONTS[design.style] || MONO_FONTS.serif) : null;
  return (
    <div className={`relative overflow-hidden rounded bg-secondary ${className}`}>
      {image ? (
        <img src={image} alt="Vivo Chela rib tank" className="w-full h-full object-cover object-top" />
      ) : (
        <div className="w-full h-full animate-pulse" />
      )}
      {design && (
        <div className="absolute left-1/2 top-[24%] -translate-x-1/2 w-[30%] aspect-square flex items-start justify-center pointer-events-none">
          {design.kind === "upload" && design.src ? (
            <img
              src={design.src}
              alt="Your design, placed on the chest"
              className="max-w-full max-h-full object-contain mix-blend-multiply opacity-90"
            />
          ) : design.kind === "monogram" && design.text ? (
            <span
              className={`text-foreground/85 mix-blend-multiply text-center leading-tight ${font.cls}`}
              style={{ ...font.style, fontSize: `${monoPx}px` }}
            >
              {design.text}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function TankRedeemFlow({ member, tank, mode = "new", redemption, onClose, onRedeemed }) {
  const adjust = mode === "adjust";
  const steps = adjust ? ["design", "review"] : ["tank", "design", "collect", "review"];
  const [step, setStep] = useState(steps[0]);
  const [tankData, setTankData] = useState(tank || null);
  const [loadErr, setLoadErr] = useState("");

  const [colourIdx, setColourIdx] = useState(0);
  const [sizeSku, setSizeSku] = useState(null);
  const [embMode, setEmbMode] = useState("upload");
  const [upload, setUpload] = useState(null);          // {dataUrl, b64, mime, name}
  const [monoText, setMonoText] = useState("");
  const [monoStyle, setMonoStyle] = useState("serif");
  const [collectMethod, setCollectMethod] = useState(null);
  const [collectStore, setCollectStore] = useState("");
  const [fileErr, setFileErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const fileRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!tankData) {
      api.rewardsTank().then(setTankData).catch(() => setLoadErr("Couldn't load the tank right now — please try again in a moment"));
    }
  }, [tankData]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const cost = tankData?.reward?.points ?? 1600;
  const balance = member?.points ?? 0;
  const shortfall = Math.max(0, cost - balance);
  const colourways = tankData?.colourways || [];
  const colourway = adjust
    ? (colourways.find((c) => c.colour === redemption?.colour) || colourways[0] || null)
    : (colourways[colourIdx] || null);
  const selSize = colourway?.sizes?.find((s) => s.sku === sizeSku) || null;

  const design = embMode === "upload"
    ? (upload ? { kind: "upload", src: upload.dataUrl } : null)
    : (monoText.trim().length >= 2 ? { kind: "monogram", text: monoText.trim(), style: monoStyle } : null);

  const designReady = embMode === "upload" ? !!upload : (monoText.trim().length >= 2 && !!monoStyle);
  const stepIdx = steps.indexOf(step);

  const pickColour = (idx) => {
    const currentLabel = selSize?.size;
    setColourIdx(idx);
    const next = (colourways[idx]?.sizes || []).find((s) => s.size === currentLabel && s.in_stock);
    setSizeSku(next ? next.sku : null);
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setFileErr("");
    try {
      const d = await fileToDesign(f);
      setUpload({ ...d, name: f.name });
    } catch (err) {
      setFileErr(err.message);
    }
  };

  // Per-item marketing consent for uploaded artwork — never pre-ticked (DPA).
  const [marketingOk, setMarketingOk] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const embroidery = embMode === "upload"
        ? { type: "upload", image_b64: upload.b64, mime: upload.mime }
        : { type: "monogram", text: monoText.trim(), style: monoStyle };
      let r;
      if (adjust) {
        r = await api.updateRedemptionDesign(redemption.id, { embroidery });
      } else {
        r = await api.redeemTank({
          sku: sizeSku,
          embroidery,
          // Consent travels only when the box was shown (upload mode);
          // absence means "never asked" and the ledger must not record it.
          ...(embMode === "upload" ? { marketing_ok: marketingOk } : {}),
          collection: collectMethod === "pickup"
            ? { method: "pickup", store: collectStore }
            : { method: "delivery" },
        });
      }
      setResult(r);
      setStep("done");
      onRedeemed && onRedeemed();
    } catch (e) {
      setError(e.message || "Something went wrong — please try again");
    } finally {
      setSubmitting(false);
    }
  };

  const canContinue =
    step === "tank" ? !!selSize :
    step === "design" ? designReady :
    step === "collect" ? (collectMethod === "delivery" || (collectMethod === "pickup" && !!collectStore)) :
    true;

  const next = () => setStep(steps[Math.min(stepIdx + 1, steps.length - 1)]);
  const back = () => (stepIdx === 0 ? onClose() : setStep(steps[stepIdx - 1]));

  const stepTitle = {
    tank: "Pick your tank",
    design: adjust ? "Adjust your design" : "Your design",
    collect: "Collection",
    review: adjust ? "Send for review" : "Review & redeem",
    done: "All set",
  }[step];

  return createPortal(
    <div
      data-testid="tank-flow"
      role="dialog"
      aria-modal="true"
      aria-label="Personalised Embroidered Tank"
      className="fixed inset-0 z-[80] bg-foreground/40 backdrop-blur-sm flex items-end sm:items-center justify-center animate-in fade-in duration-200"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-background w-full sm:max-w-3xl max-h-[94vh] sm:max-h-[92vh] rounded-t sm:rounded flex flex-col animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200 shadow-xl">

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-6 sm:px-8 pt-5 pb-4 border-b border-border">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">
              {step === "done" ? "Personalised Embroidered Tank" : `Step ${stepIdx + 1} of ${steps.length} — Personalised Embroidered Tank`}
            </div>
            <h2 className="font-serif text-xl text-foreground">{stepTitle}</h2>
          </div>
          <button
            ref={closeRef}
            data-testid="flow-close"
            aria-label="Close"
            onClick={onClose}
            className="w-10 h-10 shrink-0 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-6">
          {loadErr ? (
            <p className="text-[14px] text-foreground">{loadErr}</p>
          ) : !tankData ? (
            <div className="grid sm:grid-cols-2 gap-6">
              <div className="aspect-[4/5] rounded bg-secondary animate-pulse" />
              <div className="space-y-3">
                <div className="h-5 w-2/3 rounded bg-secondary animate-pulse" />
                <div className="h-5 w-1/2 rounded bg-secondary animate-pulse" />
              </div>
            </div>
          ) : step === "done" ? (
            <div data-testid="flow-success" className="max-w-md mx-auto text-center py-6">
              <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 border border-primary/20 text-primary-ink flex items-center justify-center mb-5">
                <Check size={24} strokeWidth={1.5} />
              </div>
              <h3 className="font-serif text-2xl text-foreground mb-3">It's in the queue</h3>
              <p className="text-[14px] text-muted-foreground leading-relaxed mb-2">
                {result?.message || "We'll review your design and get stitching — we'll let you know when your tank is ready."}
              </p>
              {!adjust && (
                <p className="text-[13px] text-muted-foreground">
                  {collectMethod === "pickup"
                    ? `Collect at ${collectStore} once it's ready.`
                    : "We'll arrange delivery once it's ready."}
                </p>
              )}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-6 sm:gap-8">
              {/* Live preview column */}
              <TankPreview
                image={colourway?.image}
                design={step === "tank" ? null : design}
                className="aspect-[4/5] w-full max-w-sm mx-auto sm:mx-0"
              />

              {/* Controls column */}
              <div className="min-w-0">
                {step === "tank" && (
                  <div className="space-y-6">
                    {colourways.length > 1 && (
                      <div>
                        <div className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground mb-3">Colour — {colourway?.colour}</div>
                        <div className="flex gap-3">
                          {colourways.map((c, i) => (
                            <button
                              key={c.colour}
                              data-testid={`colour-${c.colour}`}
                              onClick={() => pickColour(i)}
                              className={`w-20 text-left group focus-visible:outline-none ${i === colourIdx ? "" : "opacity-80 hover:opacity-100"}`}
                            >
                              <div className={`aspect-[3/4] rounded overflow-hidden border transition-colors ${i === colourIdx ? "border-primary ring-1 ring-primary" : "border-border"}`}>
                                <img src={c.image} alt={c.colour} className="w-full h-full object-cover object-top" />
                              </div>
                              <div className={`mt-1.5 text-[11px] leading-tight ${i === colourIdx ? "text-foreground font-medium" : "text-muted-foreground"}`}>{c.colour}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground mb-3">Size</div>
                      <div className="flex flex-wrap gap-2">
                        {(colourway?.sizes || []).map((s) => (
                          <button
                            key={s.sku}
                            data-testid={`size-${s.size}`}
                            disabled={!s.in_stock}
                            title={s.in_stock ? undefined : "Out of stock"}
                            onClick={() => setSizeSku(s.sku)}
                            className={`min-w-[3.25rem] h-11 px-3 rounded border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                              s.sku === sizeSku
                                ? "bg-foreground text-background border-foreground"
                                : s.in_stock
                                  ? "bg-background text-foreground border-border hover:border-foreground"
                                  : "bg-background text-muted-foreground/50 border-border line-through cursor-not-allowed"
                            }`}
                          >
                            {s.size}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-3">Crossed-out sizes are out of stock right now.</p>
                    </div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      Vivo's ribbed Chela tank — soft stretch rib, made to carry a little embroidery beautifully.
                    </p>
                  </div>
                )}

                {step === "design" && (
                  <div className="space-y-5">
                    {adjust && redemption?.status_note && (
                      <div className="rounded border border-primary/30 bg-primary/5 px-4 py-3 text-[13px] text-foreground leading-relaxed">
                        <span className="font-medium">From the studio:</span> {redemption.status_note}
                      </div>
                    )}
                    <div className="grid grid-cols-2 rounded border border-border overflow-hidden text-[13px] font-medium">
                      <button
                        data-testid="emb-mode-upload"
                        onClick={() => setEmbMode("upload")}
                        className={`py-2.5 transition-colors ${embMode === "upload" ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:text-foreground"}`}
                      >
                        Upload a design
                      </button>
                      <button
                        data-testid="emb-mode-monogram"
                        onClick={() => setEmbMode("monogram")}
                        className={`py-2.5 transition-colors ${embMode === "monogram" ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:text-foreground"}`}
                      >
                        Monogram
                      </button>
                    </div>

                    {/* key'd branches: without keys React reuses the same
                        <input> fiber across the mode switch (file ↔ text),
                        logging a controlled/uncontrolled warning. */}
                    {embMode === "upload" ? (
                      <div key="emb-upload">
                        <input ref={fileRef} data-testid="tank-design-file" type="file" accept="image/png,image/jpeg" className="hidden" onChange={onFile} />
                        {!upload ? (
                          <button
                            onClick={() => fileRef.current?.click()}
                            className="w-full rounded border border-border bg-secondary/60 hover:border-primary/50 transition-colors p-8 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <div className="w-12 h-12 mx-auto rounded-full bg-primary/10 border border-primary/20 text-primary-ink flex items-center justify-center mb-4">
                              <UploadCloud size={20} strokeWidth={1.5} />
                            </div>
                            <div className="font-serif text-lg text-foreground mb-1">Add your artwork</div>
                            <div className="text-[12px] text-muted-foreground">PNG or JPG — we'll place it on the chest</div>
                          </button>
                        ) : (
                          <div className="flex items-center gap-3 rounded border border-border p-3">
                            <img src={upload.dataUrl} alt="" className="w-12 h-12 object-contain rounded-sm bg-secondary shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-[13px] text-foreground truncate">{upload.name}</div>
                              <div className="text-[11px] text-muted-foreground">Placed on the chest — see the preview</div>
                            </div>
                            <button
                              data-testid="design-swap"
                              onClick={() => fileRef.current?.click()}
                              className="shrink-0 text-[12px] font-medium text-primary-ink hover:underline"
                            >
                              Swap
                            </button>
                          </div>
                        )}
                        {fileErr && <p className="text-[12px] text-primary-ink mt-2">{fileErr}</p>}
                      </div>
                    ) : (
                      <div key="emb-monogram" className="space-y-4">
                        <input
                          data-testid="mono-text"
                          value={monoText}
                          onChange={(e) => setMonoText(e.target.value)}
                          maxLength={14}
                          placeholder="e.g. A.W. or AMANI"
                          className={`${inputCls} w-full`}
                        />
                        <div className="grid grid-cols-3 gap-2">
                          {(tankData.monogram_styles || []).map((s) => {
                            const f = MONO_FONTS[s.id] || MONO_FONTS.serif;
                            return (
                              <button
                                key={s.id}
                                data-testid={`mono-style-${s.id}`}
                                onClick={() => setMonoStyle(s.id)}
                                className={`rounded border p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                                  monoStyle === s.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground"
                                }`}
                              >
                                <div className={`text-lg text-foreground leading-none mb-2 ${f.cls}`} style={f.style}>
                                  {monoText.trim() || "A.W."}
                                </div>
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                      Small, chest-placed designs work best — simple shapes and a few colours are the most embroidery-friendly. The final stitch can vary slightly from the preview.
                    </p>
                  </div>
                )}

                {step === "collect" && (
                  <div className="space-y-4">
                    <button
                      data-testid="collect-pickup"
                      onClick={() => setCollectMethod("pickup")}
                      className={`w-full flex items-start gap-4 rounded border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                        collectMethod === "pickup" ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground"
                      }`}
                    >
                      <Store size={20} strokeWidth={1.5} className="mt-0.5 text-muted-foreground shrink-0" />
                      <span>
                        <span className="block text-[14px] font-medium text-foreground">Pick up in store</span>
                        <span className="block text-[12px] text-muted-foreground mt-0.5">Choose your Vivo store — we'll message you when it's ready.</span>
                      </span>
                    </button>
                    {collectMethod === "pickup" && (
                      <select
                        data-testid="pickup-store"
                        value={collectStore}
                        onChange={(e) => setCollectStore(e.target.value)}
                        className={`${inputCls} w-full appearance-none`}
                      >
                        <option value="">Choose a store…</option>
                        {(tankData.pickup_stores || []).map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    )}
                    <button
                      data-testid="collect-delivery"
                      onClick={() => setCollectMethod("delivery")}
                      className={`w-full flex items-start gap-4 rounded border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                        collectMethod === "delivery" ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground"
                      }`}
                    >
                      <Truck size={20} strokeWidth={1.5} className="mt-0.5 text-muted-foreground shrink-0" />
                      <span>
                        <span className="block text-[14px] font-medium text-foreground">Delivery</span>
                        <span className="block text-[12px] text-muted-foreground mt-0.5">We'll message you to arrange delivery once your tank is ready.</span>
                      </span>
                    </button>
                  </div>
                )}

                {step === "review" && (
                  <div className="space-y-5">
                    <div className="divide-y divide-border rounded border border-border">
                      {!adjust && (
                        <div className="flex justify-between gap-4 px-4 py-3 text-[13px]">
                          <span className="text-muted-foreground">Tank</span>
                          <span className="text-foreground text-right">{colourway?.colour} · Size {selSize?.size}</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-4 px-4 py-3 text-[13px]">
                        <span className="text-muted-foreground">Embroidery</span>
                        <span className="text-foreground text-right">
                          {embMode === "upload"
                            ? "Your uploaded design"
                            : `Monogram "${monoText.trim()}" — ${(tankData.monogram_styles || []).find((s) => s.id === monoStyle)?.label || ""}`}
                        </span>
                      </div>
                      {!adjust && (
                        <div className="flex justify-between gap-4 px-4 py-3 text-[13px]">
                          <span className="text-muted-foreground">Collection</span>
                          <span className="text-foreground text-right">
                            {collectMethod === "pickup" ? `Pick up — ${collectStore}` : "Delivery"}
                          </span>
                        </div>
                      )}
                    </div>

                    {!adjust && (
                      <div className="rounded bg-secondary/70 border border-border px-4 py-3 text-[13px] space-y-1.5">
                        <div className="flex justify-between"><span className="text-muted-foreground">This reward</span><span className="text-foreground font-medium">{cost.toLocaleString()} pts</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Your balance</span><span className="text-foreground">{balance.toLocaleString()} pts</span></div>
                        {shortfall === 0 && (
                          <div className="flex justify-between border-t border-border pt-1.5"><span className="text-muted-foreground">After redeeming</span><span className="text-foreground font-medium">{(balance - cost).toLocaleString()} pts</span></div>
                        )}
                      </div>
                    )}

                    {!adjust && shortfall > 0 && (
                      <p data-testid="flow-shortfall" className="text-[13px] text-primary-ink leading-relaxed">
                        You need {shortfall.toLocaleString()} more points — keep earning and this one's yours.
                      </p>
                    )}

                    {!adjust && embMode === "upload" && upload && (
                      <label className="flex items-start gap-2.5 cursor-pointer rounded border border-border bg-secondary/40 p-3">
                        <input
                          data-testid="tank-marketing-consent"
                          type="checkbox"
                          checked={marketingOk}
                          onChange={(e) => setMarketingOk(e.target.checked)}
                          className="mt-0.5 w-4 h-4 accent-primary cursor-pointer shrink-0"
                        />
                        <span className="text-[12px] leading-relaxed text-muted-foreground">
                          Vivo may feature my design in Vivo&apos;s marketing (social media, website).
                          <span className="block text-[11px] mt-0.5 opacity-80">
                            Optional — your order is the same either way, and you can change this anytime in Profile → My data.
                          </span>
                        </span>
                      </label>
                    )}

                    <p className="text-[12px] text-muted-foreground leading-relaxed">
                      Every design is reviewed before stitching. If yours is tricky to embroider we'll ask you to adjust it — your points stay safe. T&Cs apply.
                    </p>

                    {error && <p data-testid="flow-error" className="text-[13px] text-primary-ink">{error}</p>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="shrink-0 border-t border-border px-6 sm:px-8 py-4 flex items-center justify-between gap-3">
          {step === "done" ? (
            <button
              data-testid="flow-done"
              onClick={onClose}
              className="ml-auto px-8 py-2.5 bg-foreground text-background text-[13px] font-medium rounded hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          ) : (
            <>
              <button
                data-testid="flow-back"
                onClick={back}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft size={15} /> {stepIdx === 0 ? "Cancel" : "Back"}
              </button>
              {step === "review" ? (
                <button
                  data-testid="flow-confirm"
                  disabled={submitting || (!adjust && shortfall > 0) || !tankData}
                  onClick={submit}
                  className="px-6 sm:px-8 py-2.5 bg-primary text-primary-foreground text-[13px] font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? "Sending…" : adjust ? "Send for review" : `Confirm & redeem ${cost.toLocaleString()} pts`}
                </button>
              ) : (
                <button
                  data-testid="flow-continue"
                  disabled={!canContinue || !tankData}
                  onClick={next}
                  className="px-8 py-2.5 bg-foreground text-background text-[13px] font-medium rounded hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
