import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X, ImagePlus, Film, Search } from "lucide-react";
import { api } from "@/lib/api";
import { btnPrimary, btnSecondary } from "./ui";

// ---------------------------------------------------------------------------
// The community composer — one modal, three doors:
//   · challenge entry (challenge prop set): media-first, challenge points
//   · "Share a look" (postType="look"): photo or video REQUIRED,
//     50 pts photo / 100 pts video — points land on publish, never submit
//   · "Ask the community" (postType="question"): words are enough, and
//     questions deliberately never earn or mention points (keeps advice pure)
// Every submission goes through the same review-then-publish lane.
// ---------------------------------------------------------------------------

// Warm, non-punitive status labels for a member's own entries. Server sends
// pending/published/rejected; legacy keys kept for anything mid-flight.
export const ENTRY_STATUS_COPY = {
  pending: "In review",
  in_review: "In review",
  published: "Published",
  rejected: "Not published this time",
  not_published: "Not published this time",
};

// Legacy demo store — retired. The Style Journal reads api.myEntries() now.
export function getEntries() { return []; }

const MAX_IMAGE_MB = 5;
const MAX_VIDEO_MB = 8;

const FIT_LABELS = { small: "Runs small", true: "True to size", large: "Runs large" };

export default function EntryModal({ challenge, postType, onClose, onSubmitted }) {
  const standalone = !challenge;
  const open = !!challenge || !!postType;

  const [type, setType] = useState(postType === "question" ? "question" : "look");
  const [step, setStep] = useState("form");
  const [caption, setCaption] = useState("");
  const [media, setMedia] = useState(null); // { b64, kind, name }
  const [mediaErr, setMediaErr] = useState("");
  const [tags, setTags] = useState([]); // [{sku, name}]
  const [tagOpen, setTagOpen] = useState(false);
  const [products, setProducts] = useState(null); // null = not fetched
  const [prodQ, setProdQ] = useState("");
  const [fit, setFit] = useState("");
  const [fitSize, setFitSize] = useState("");
  // Marketing-reuse consent is OPT-IN and separate from membership terms:
  // it must never be pre-checked, and sharing works identically without it.
  const [marketingOk, setMarketingOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [doneNote, setDoneNote] = useState("");

  const dialogRef = useRef(null);
  const prevFocusRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (open) {
      setType(postType === "question" ? "question" : "look");
      setStep("form");
      setCaption("");
      setMedia(null);
      setMediaErr("");
      setTags([]);
      setTagOpen(false);
      setProdQ("");
      setFit("");
      setFitSize("");
      setMarketingOk(false);
      setBusy(false);
      setError("");
      setDoneNote("");
    }
  }, [open, challenge?.id, postType]);

  // Remember the invoker and hand focus back when the dialog closes.
  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement;
    return () => {
      if (prevFocusRef.current && typeof prevFocusRef.current.focus === "function") {
        prevFocusRef.current.focus();
      }
      prevFocusRef.current = null;
    };
  }, [open]);

  // Move focus into the dialog on open and when the step changes.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector(
        step === "form" ? "#entry-caption" : '[data-testid="btn-entry-done"]'
      );
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lazy product list for the tag picker — first open only.
  useEffect(() => {
    if (!tagOpen || products !== null) return;
    let alive = true;
    api.products({ limit: 48 })
      .then((d) => { if (alive) setProducts(d.items || d.products || []); })
      .catch(() => { if (alive) setProducts([]); });
    return () => { alive = false; };
  }, [tagOpen, products]);

  if (!open) return null;

  const isQuestion = standalone && type === "question";
  const needsMedia = !isQuestion; // challenge entries and looks are media-first
  const pts = challenge
    ? challenge.points
    : media?.kind === "video" ? 100 : 50;

  // Keep Tab cycling inside the dialog while it is open.
  const trapTab = (e) => {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll(
      'button, textarea, input, select, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes).filter((n) => !n.disabled);
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // same file re-selectable after remove
    if (!f) return;
    setMediaErr("");
    const isVideo = (f.type || "").startsWith("video/");
    const capMb = isVideo ? MAX_VIDEO_MB : MAX_IMAGE_MB;
    if (f.size > capMb * 1024 * 1024) {
      setMediaErr(
        isVideo
          ? `That video is a little heavy — keep it under ${MAX_VIDEO_MB}MB (a short clip is perfect).`
          : `That photo is a little heavy — keep it under ${MAX_IMAGE_MB}MB.`
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setMedia({ b64: String(reader.result), kind: isVideo ? "video" : "photo", name: f.name });
    };
    reader.onerror = () => setMediaErr("Couldn't read that file — try another one.");
    reader.readAsDataURL(f);
  };

  const toggleTag = (p) => {
    setTags((cur) => {
      if (cur.some((t) => t.sku === p.sku)) return cur.filter((t) => t.sku !== p.sku);
      if (cur.length >= 3) return cur; // quietly capped at 3
      return [...cur, { sku: p.sku, name: p.name }];
    });
  };

  const canSubmit = !busy
    && (isQuestion ? caption.trim().length > 0 : !!media);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    const fitNote = !isQuestion && fit
      ? { fit, ...(fitSize.trim() ? { size: fitSize.trim() } : {}) }
      : undefined;
    const payload = {
      caption: caption.trim(),
      ...(media ? { media_b64: media.b64 } : {}),
      ...(tags.length ? { tags: tags.map((t) => t.sku) } : {}),
      ...(fitNote ? { fit_note: fitNote } : {}),
      marketing_ok: marketingOk,
    };
    try {
      let resp;
      if (challenge) {
        resp = await api.enterChallenge(challenge.id, payload);
      } else {
        resp = await api.createPost({ post_type: type, ...payload });
      }
      setDoneNote(resp?.note || "");
      setStep("done");
      if (onSubmitted) onSubmitted(resp);
    } catch (err) {
      setError(err?.message || "Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const filteredProducts = (products || []).filter((p) =>
    !prodQ.trim() || (p.name || "").toLowerCase().includes(prodQ.trim().toLowerCase())
  );

  const title = challenge
    ? `Enter ${challenge.title}`
    : isQuestion ? "Ask the community" : "Share your look";

  const segBtn = (active) =>
    `flex-1 h-10 rounded text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
      active ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground"
    }`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
      data-testid="entry-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-modal-title"
        className="bg-background rounded border border-border shadow-xl w-full max-w-md max-h-[92vh] overflow-y-auto p-6 sm:p-8 relative animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <button aria-label="Close" onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors">
          <X size={18} strokeWidth={1.5} />
        </button>

        {step === "form" ? (
          <>
            <h3 id="entry-modal-title" className="text-xl font-serif text-foreground mb-1.5 pr-8">
              {title}
            </h3>

            {standalone && (
              <div className="flex gap-2 mt-3 mb-4" role="tablist" aria-label="What are you sharing?">
                <button type="button" role="tab" aria-selected={type === "look"}
                  data-testid="post-type-look" onClick={() => setType("look")}
                  className={segBtn(type === "look")}>
                  Share a look
                </button>
                <button type="button" role="tab" aria-selected={type === "question"}
                  data-testid="post-type-question" onClick={() => setType("question")}
                  className={segBtn(type === "question")}>
                  Ask the community
                </button>
              </div>
            )}

            {isQuestion ? (
              <p className="text-[13px] text-muted-foreground mb-5">
                Fit, styling, sizing — the community loves to help. A photo is welcome but words are enough.
              </p>
            ) : (
              <p className="text-[13px] text-primary-ink font-medium mb-5" data-testid="points-copy">
                {challenge
                  ? `Earn ${challenge.points} pts when your entry is published`
                  : media?.kind === "video"
                    ? "Earn 100 pts when your video look is published"
                    : media
                      ? "Earn 50 pts when your look is published"
                      : "Earn 50 pts with a photo — or 100 with a video — once published"}
              </p>
            )}

            {/* Media — first thing on the form for looks and entries */}
            <div className="mb-4">
              {media ? (
                <div className="relative rounded border border-border overflow-hidden bg-secondary/40" data-testid="media-preview">
                  {media.kind === "video" ? (
                    <video src={media.b64} controls playsInline className="w-full max-h-72 object-contain bg-foreground/95" />
                  ) : (
                    <img src={media.b64} alt="Your upload" className="w-full max-h-72 object-contain" />
                  )}
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-background border-t border-border">
                    <span className="text-[12px] text-muted-foreground truncate">{media.name}</span>
                    <div className="flex gap-3 shrink-0">
                      <button type="button" onClick={() => fileRef.current?.click()}
                        className="text-[12px] font-semibold text-foreground underline underline-offset-2">
                        Replace
                      </button>
                      <button type="button" data-testid="btn-media-remove" onClick={() => setMedia(null)}
                        className="text-[12px] font-semibold text-muted-foreground hover:text-foreground">
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="btn-media-pick"
                  onClick={() => fileRef.current?.click()}
                  className={`w-full rounded border border-dashed flex flex-col items-center justify-center gap-2 py-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    needsMedia ? "border-primary/50 bg-primary/[0.03] hover:bg-primary/[0.06]" : "border-border bg-secondary/30 hover:bg-secondary/50"
                  }`}
                >
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <ImagePlus size={22} strokeWidth={1.5} />
                    <Film size={22} strokeWidth={1.5} />
                  </span>
                  <span className="text-[13px] font-medium text-foreground">
                    {needsMedia ? "Add your photo or video" : "Add a photo or video (optional)"}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Photo up to {MAX_IMAGE_MB}MB · video up to {MAX_VIDEO_MB}MB
                  </span>
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*,video/mp4,video/webm"
                className="hidden" onChange={onFile} data-testid="media-input" />
              {mediaErr && <p className="text-[12px] text-destructive mt-2" role="alert">{mediaErr}</p>}
            </div>

            <label htmlFor="entry-caption" className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              {isQuestion ? "Your question" : "Your story"}
            </label>
            <textarea
              id="entry-caption"
              data-testid="input-entry-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={
                challenge?.caption_prompt
                  || (isQuestion
                    ? "e.g. Between sizes in the wrap dress — size up or down?"
                    : "Tell us the story behind your look…")
              }
              className="w-full rounded border border-border bg-secondary/30 p-3 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary resize-none mb-4"
            />

            {!isQuestion && (
              <>
                {/* Tag the pieces — up to three, straight from the shop */}
                <div className="mb-4">
                  <button type="button" data-testid="btn-tag-toggle"
                    onClick={() => setTagOpen((v) => !v)}
                    className="text-[12px] font-semibold text-foreground underline underline-offset-2">
                    {tagOpen ? "Hide product tags" : tags.length ? "Edit product tags" : "Tag the Vivo pieces you're wearing (up to 3)"}
                  </button>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2.5">
                      {tags.map((t) => (
                        <span key={t.sku} data-testid={`tag-chip-${t.sku}`}
                          className="inline-flex items-center gap-1.5 bg-secondary border border-border rounded-full pl-3 pr-1.5 py-1 text-[12px] font-medium text-foreground">
                          {t.name}
                          <button type="button" aria-label={`Remove ${t.name}`}
                            onClick={() => setTags((cur) => cur.filter((x) => x.sku !== t.sku))}
                            className="w-5 h-5 rounded-full hover:bg-border flex items-center justify-center">
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {tagOpen && (
                    <div className="mt-2.5 border border-border rounded p-3 bg-secondary/20">
                      <div className="relative mb-2">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <input
                          value={prodQ}
                          onChange={(e) => setProdQ(e.target.value)}
                          placeholder="Search pieces…"
                          data-testid="tag-search"
                          className="w-full h-10 pl-9 pr-3 rounded-sm border border-border bg-background text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        />
                      </div>
                      <div className="max-h-44 overflow-y-auto space-y-1" data-testid="tag-options">
                        {products === null ? (
                          <p className="text-[12px] text-muted-foreground py-2 px-1">Fetching the collection…</p>
                        ) : filteredProducts.length === 0 ? (
                          <p className="text-[12px] text-muted-foreground py-2 px-1">Nothing matching — try another word.</p>
                        ) : (
                          filteredProducts.slice(0, 30).map((p) => {
                            const on = tags.some((t) => t.sku === p.sku);
                            const full = !on && tags.length >= 3;
                            return (
                              <button key={p.sku} type="button" data-testid={`tag-option-${p.sku}`}
                                onClick={() => toggleTag(p)} disabled={full}
                                className={`w-full flex items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40 ${
                                  on ? "bg-foreground text-background" : "hover:bg-secondary text-foreground"
                                }`}>
                                <span className="truncate">{p.name}</span>
                                {on && <Check size={14} className="shrink-0" />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Fit note — the detail that makes a look useful to others */}
                <div className="mb-4">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                    How's the fit? <span className="font-normal normal-case tracking-normal">(optional — so helpful)</span>
                  </div>
                  <div className="flex gap-2">
                    {["small", "true", "large"].map((f) => (
                      <button key={f} type="button" data-testid={`fit-${f}`}
                        onClick={() => setFit((cur) => (cur === f ? "" : f))}
                        className={`flex-1 h-10 rounded text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          fit === f ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground"
                        }`}>
                        {FIT_LABELS[f]}
                      </button>
                    ))}
                  </div>
                  {fit && (
                    <input
                      value={fitSize}
                      onChange={(e) => setFitSize(e.target.value)}
                      maxLength={8}
                      placeholder="Size you're wearing (e.g. M or 12)"
                      data-testid="fit-size-input"
                      className="mt-2 w-full h-10 px-3 rounded-sm border border-border bg-background text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    />
                  )}
                </div>
              </>
            )}

            <label className="flex items-start gap-3 cursor-pointer group mb-4">
              <div className="relative flex items-center justify-center shrink-0 mt-0.5">
                <input
                  data-testid="check-marketing-consent"
                  type="checkbox"
                  checked={marketingOk}
                  onChange={(e) => setMarketingOk(e.target.checked)}
                  className="peer appearance-none w-5 h-5 border border-border rounded bg-background checked:bg-primary checked:border-primary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                <Check size={14} className="absolute text-primary-foreground opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" />
              </div>
              <span className="text-[13px] leading-relaxed text-muted-foreground group-hover:text-foreground transition-colors">
                Vivo may feature my post in Vivo's marketing (social media, website).
                <span className="block text-[11px] mt-1 opacity-80">Optional — sharing works the same either way. This only covers use outside the app.</span>
              </span>
            </label>

            <p className="text-[12px] text-muted-foreground leading-relaxed bg-secondary/50 border border-border rounded p-3.5 mb-5">
              Our team reviews every {isQuestion ? "question" : challenge ? "entry" : "share"} before it goes live in the community — it's how we keep this space lovely.{!isQuestion && ` Your ${pts} points are added the moment it's published.`}
            </p>

            {error && (
              <p className="text-[13px] text-destructive mb-4" role="alert" data-testid="entry-error">{error}</p>
            )}

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button onClick={onClose} className={btnSecondary}>Not now</button>
              <button data-testid="btn-entry-submit" onClick={submit} disabled={!canSubmit} className={btnPrimary}>
                {busy ? "Sharing…" : isQuestion ? "Ask the community" : challenge ? "Share my entry" : "Share my look"}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center pt-2" data-testid="entry-confirmation">
            <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 border border-primary/20 text-primary-ink flex items-center justify-center mb-5">
              <Check size={26} strokeWidth={2} />
            </div>
            <h3 className="text-xl font-serif text-foreground mb-3">
              {isQuestion ? "Question sent!" : "Thanks for sharing!"}
            </h3>
            <p className="text-[14px] text-muted-foreground leading-relaxed mb-2">
              {isQuestion
                ? "It's with our team for a quick look — we'll pop it into the feed shortly, and the community will take it from there."
                : challenge
                  ? `Your entry is under review — you'll earn your ${challenge.points} points the moment it's published.`
                  : `Your look is under review — you'll earn your ${pts} points the moment it's published.`}
            </p>
            <p className="text-[12px] text-muted-foreground leading-relaxed mb-7">
              {doneNote || "You can follow it in your Style Journal — it's only visible to you until it goes live."}
            </p>
            <button data-testid="btn-entry-done" onClick={onClose} className={btnPrimary}>Done</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
