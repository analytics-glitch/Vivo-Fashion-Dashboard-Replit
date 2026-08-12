import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/lib/auth";
import { api, API } from "@/lib/api";
import { invalidateThumbnail, primeThumbnail } from "@/lib/useThumbnails";
import { toast } from "sonner";
import { Camera, CaretLeft, CaretRight, Pencil, Trash, UploadSimple, X } from "@phosphor-icons/react";

// ─── authed-blob image fallback ───────────────────────────────────────
// API-served images (/api/product-image/…) sit behind the auth middleware.
// A plain <img src> relies on the httpOnly session cookie, which is absent
// in cookie-blocked contexts (workspace preview iframe, Safari third-party
// cookie blocking) even though the user IS signed in via the Bearer token.
// When a direct load fails for an API URL we retry ONCE through the axios
// client (which attaches the Bearer header) and swap in an object URL.
// Bounded, session-scoped caches so list views never refetch the same image
// and long browsing sessions can't grow blob memory without limit.
const BLOB_CACHE = new Map();    // url -> object URL (Map = insertion order → LRU)
const BLOB_INFLIGHT = new Map(); // url -> Promise<string|null>
const BLOB_FAILED = new Set();   // urls that failed even with auth
const BLOB_CACHE_MAX = 150;      // ~a few screenfuls of thumbnails
const BLOB_FAILED_MAX = 500;

const isApiImageUrl = (u) =>
  typeof u === "string" && (u.startsWith(`${API}/`) || u.startsWith("/api/"));

// LRU read: bump the entry to most-recently-used on hit.
const blobCacheGet = (url) => {
  const v = BLOB_CACHE.get(url);
  if (v) {
    BLOB_CACHE.delete(url);
    BLOB_CACHE.set(url, v);
  }
  return v || null;
};

const blobCachePut = (url, obj) => {
  BLOB_CACHE.set(url, obj);
  while (BLOB_CACHE.size > BLOB_CACHE_MAX) {
    const [oldUrl, oldObj] = BLOB_CACHE.entries().next().value;
    BLOB_CACHE.delete(oldUrl);
    try { URL.revokeObjectURL(oldObj); } catch { /* noop */ }
  }
};

const blobMarkFailed = (url) => {
  BLOB_FAILED.add(url);
  while (BLOB_FAILED.size > BLOB_FAILED_MAX) {
    BLOB_FAILED.delete(BLOB_FAILED.values().next().value);
  }
};

const fetchAuthedBlob = (url) => {
  const cached = blobCacheGet(url);
  if (cached) return Promise.resolve(cached);
  if (BLOB_FAILED.has(url)) return Promise.resolve(null);
  if (BLOB_INFLIGHT.has(url)) return BLOB_INFLIGHT.get(url);
  // The axios baseURL is already `${API}` — strip the prefix to avoid doubling.
  const path = url.startsWith(`${API}/`)
    ? url.slice(API.length)
    : url.replace(/^\/api\//, "/");
  const p = api
    .get(path, { responseType: "blob" })
    .then(({ data }) => {
      const obj = URL.createObjectURL(data);
      blobCachePut(url, obj);
      return obj;
    })
    .catch(() => {
      blobMarkFailed(url);
      return null;
    })
    .finally(() => BLOB_INFLIGHT.delete(url));
  BLOB_INFLIGHT.set(url, p);
  return p;
};

// ─── deterministic placeholder ────────────────────────────────────────
// Hash the style name once, pick a colour from the Vivo palette, and
// show the first two meaningful characters. Prevents the "AI slop"
// generic-grey-box look while staying on-brand.
const PALETTE = [
  // orange / amber family (brand)
  "#F97316", "#FB923C", "#F59E0B",
  // green family (brand accent)
  "#16A34A", "#059669", "#10B981",
  // supportive neutrals / jewel tones
  "#7C3AED", "#DB2777", "#0EA5E9", "#EF4444",
  "#8B5CF6", "#0891B2", "#CA8A04",
];

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
};

const initialsFor = (s) => {
  const cleaned = (s || "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (cleaned.length === 0) return "?";
  if (cleaned.length === 1) return cleaned[0].slice(0, 2).toUpperCase();
  return (cleaned[0][0] + cleaned[1][0]).toUpperCase();
};

export const Placeholder = ({ style, size }) => {
  const h = hash(style || "");
  const bg = PALETTE[h % PALETTE.length];
  const letters = initialsFor(style);
  const fontSize = Math.round(size * 0.38);
  return (
    <div
      className="flex items-center justify-center font-bold text-white select-none"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${bg} 0%, ${bg}dd 100%)`,
        fontSize,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
      aria-label={`Placeholder for ${style}`}
    >
      {letters}
    </div>
  );
};

// ─── admin editor ─────────────────────────────────────────────────────
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_UPLOAD_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const Editor = ({ style, currentUrl, onClose, onChanged }) => {
  const [url, setUrl] = useState(currentUrl || "");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(currentUrl || "");
  const fileInputRef = useRef(null);

  const save = async () => {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      toast.error("Paste a full https:// URL");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/thumbnails/${encodeURIComponent(style)}`, { style_name: style, image_url: trimmed });
      primeThumbnail(style, trimmed);
      toast.success("Thumbnail saved");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save — check the URL");
    } finally {
      setSaving(false);
    }
  };

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });

  const onFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (!ACCEPTED_UPLOAD_TYPES.includes(file.type)) {
      toast.error("Choose a JPG, PNG or WebP image");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("Image is too large (max 5 MB)");
      return;
    }
    setSaving(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const { data } = await api.post(`/thumbnails/${encodeURIComponent(style)}/upload`, {
        style_name: style,
        content_type: file.type,
        data_base64: dataUrl,
      });
      const served = data?.image_url || "";
      if (served) primeThumbnail(style, served);
      toast.success("Thumbnail uploaded");
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't upload — try another image");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!currentUrl) { onClose(); return; }
    setSaving(true);
    try {
      await api.delete(`/thumbnails/${encodeURIComponent(style)}`);
      invalidateThumbnail(style);
      toast.success("Thumbnail removed");
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error("Couldn't remove");
    } finally {
      setSaving(false);
    }
  };

  // esc to close
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="thumbnail-editor-backdrop"
    >
      <div
        className="card-white p-5 w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Product thumbnail</div>
            <div className="font-semibold text-[15px] mt-0.5 break-words">{style}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-panel"
            data-testid="thumbnail-editor-close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="rounded-lg overflow-hidden border border-border" style={{ width: 96, height: 96 }}>
            {preview ? (
              <img
                src={preview}
                alt="preview"
                className="w-full h-full object-cover"
                onError={() => setPreview("")}
              />
            ) : (
              <Placeholder style={style} size={96} />
            )}
          </div>
          <div className="flex-1 space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-muted">Image URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setPreview(e.target.value.trim()); }}
              placeholder="https://cdn.example.com/sku.jpg"
              className="w-full border border-border rounded px-2 py-1.5 text-[13px] outline-none focus:border-brand"
              data-testid="thumbnail-editor-url"
              autoFocus
            />
            <p className="text-[10.5px] text-muted">
              Must be a direct https:// link to a web-safe image (JPG/PNG/WebP).
            </p>
            <div className="flex items-center gap-2 pt-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-wider text-muted">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onFilePicked}
              data-testid="thumbnail-editor-file"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
              className="w-full text-[12px] px-3 py-1.5 rounded border border-border hover:bg-panel inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
              data-testid="thumbnail-editor-upload"
            >
              <UploadSimple size={14} /> Upload from device
            </button>
            <p className="text-[10.5px] text-muted">
              JPG, PNG or WebP, up to 5 MB.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={remove}
            disabled={saving || !currentUrl}
            className="text-[12px] text-red-700 hover:bg-red-50 px-2 py-1 rounded inline-flex items-center gap-1 disabled:opacity-30"
            data-testid="thumbnail-editor-remove"
          >
            <Trash size={13} /> Remove
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-[12px] px-3 py-1.5 rounded hover:bg-panel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !url.trim()}
              className="text-[12px] px-3 py-1.5 rounded bg-brand text-white hover:bg-brand-deep disabled:opacity-40"
              data-testid="thumbnail-editor-save"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ─── lightbox ─────────────────────────────────────────────────────────
// Click any product image (anywhere it appears) to expand it to a large
// centred overlay. Esc / click-outside / the X button all close it.
// When `onPrev`/`onNext` are supplied, on-screen arrows + the left/right
// arrow keys step between images without leaving the enlarged view.
const LIGHTBOX_MAX_SCALE = 4;
const LIGHTBOX_DOUBLE_TAP_SCALE = 2.5;
const SWIPE_THRESHOLD = 50; // px
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 30; // px — how far the two taps can be apart / how far a tap can drift

export const Lightbox = ({
  url, caption, onClose, onPrev, onNext,
  thumbnails, activeIndex, onSelect,
}) => {
  // ─── zoom / pan state ──────────────────────────────────────────────
  // `scale` 1 = fit-to-screen (swipe navigates), > 1 = zoomed (drag pans
  // and horizontal swipe-to-navigate is suppressed). Kept in a ref mirror
  // so the native (non-passive) touch listeners always read the latest.
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const stateRef = useRef(transform);
  stateRef.current = transform;
  const gesturingRef = useRef(false);
  const figureRef = useRef(null);
  const imgRef = useRef(null);
  const gesture = useRef(null);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });

  const reset = useCallback(() => setTransform({ scale: 1, x: 0, y: 0 }), []);

  // Reset zoom whenever the displayed image changes (arrow / swipe nav).
  useEffect(() => { reset(); }, [url, reset]);

  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && onPrev) { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight" && onNext) { e.preventDefault(); onNext(); }
    };
    window.addEventListener("keydown", h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = prev;
    };
  }, [onClose, onPrev, onNext]);

  // Clamp a pan offset so the (scaled) image edges never pull inside the
  // visible bounds. Transform origin is the image centre.
  const clampPan = useCallback((x, y, scale) => {
    const img = imgRef.current;
    if (!img) return { x, y };
    const maxX = Math.max(0, (img.offsetWidth * (scale - 1)) / 2);
    const maxY = Math.max(0, (img.offsetHeight * (scale - 1)) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  }, []);

  // Zoom in centred on a tap point (used for double-tap). Only called from
  // a fit state, so the img rect is the unscaled size.
  const zoomToPoint = useCallback((clientX, clientY) => {
    const img = imgRef.current;
    const scale = LIGHTBOX_DOUBLE_TAP_SCALE;
    if (!img) { setTransform({ scale, x: 0, y: 0 }); return; }
    const rect = img.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const c = clampPan(-(scale - 1) * (clientX - cx), -(scale - 1) * (clientY - cy), scale);
    setTransform({ scale, x: c.x, y: c.y });
  }, [clampPan]);

  // ─── touch gestures (pinch-zoom, pan, double-tap, swipe-nav) ────────
  // Attached natively with { passive: false } so we can preventDefault and
  // stop the browser's own pinch-to-zoom / scroll from hijacking the
  // gesture. React's synthetic touch handlers are passive and can't.
  useEffect(() => {
    const el = figureRef.current;
    if (!el) return;

    const dist = (touches) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );

    const onStart = (e) => {
      const cur = stateRef.current;
      if (e.touches.length === 2) {
        gesturingRef.current = true;
        gesture.current = {
          mode: "pinch",
          startDist: dist(e.touches) || 1,
          startScale: cur.scale,
          startX: cur.x,
          startY: cur.y,
        };
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        gesturingRef.current = true;
        gesture.current = {
          mode: cur.scale > 1 ? "pan" : "swipe",
          startClientX: t.clientX,
          startClientY: t.clientY,
          startX: cur.x,
          startY: cur.y,
          moved: false,
        };
      }
    };

    const onMove = (e) => {
      const g = gesture.current;
      if (!g) return;
      if (g.mode === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const ratio = dist(e.touches) / g.startDist;
        const scale = Math.min(LIGHTBOX_MAX_SCALE, Math.max(1, g.startScale * ratio));
        if (scale <= 1.01) {
          setTransform({ scale: 1, x: 0, y: 0 });
        } else {
          const c = clampPan(g.startX, g.startY, scale);
          setTransform({ scale, x: c.x, y: c.y });
        }
      } else if (g.mode === "pan" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        g.moved = true;
        const c = clampPan(
          g.startX + (t.clientX - g.startClientX),
          g.startY + (t.clientY - g.startClientY),
          stateRef.current.scale,
        );
        setTransform((p) => ({ ...p, x: c.x, y: c.y }));
      } else if (g.mode === "swipe" && e.touches.length === 1) {
        const t = e.touches[0];
        if (Math.abs(t.clientX - g.startClientX) > 10 || Math.abs(t.clientY - g.startClientY) > 10) {
          g.moved = true;
        }
      }
    };

    const detectDoubleTap = (t, onDouble) => {
      const now = Date.now();
      const lt = lastTap.current;
      if (
        now - lt.time < DOUBLE_TAP_MS &&
        Math.abs(t.clientX - lt.x) < TAP_SLOP &&
        Math.abs(t.clientY - lt.y) < TAP_SLOP
      ) {
        lastTap.current = { time: 0, x: 0, y: 0 };
        onDouble();
      } else {
        lastTap.current = { time: now, x: t.clientX, y: t.clientY };
      }
    };

    const onEnd = (e) => {
      const g = gesture.current;
      if (e.touches.length === 0) {
        gesture.current = null;
        gesturingRef.current = false;
      }
      if (!g) return;

      const t = e.changedTouches[0];
      if (g.mode === "swipe") {
        const dx = t.clientX - g.startClientX;
        const dy = t.clientY - g.startClientY;
        if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0 && onNext) onNext();
          else if (dx > 0 && onPrev) onPrev();
          return;
        }
        if (!g.moved) detectDoubleTap(t, () => zoomToPoint(t.clientX, t.clientY));
      } else if (g.mode === "pan" && !g.moved) {
        // A stationary tap while zoomed: double-tap to zoom back out.
        detectDoubleTap(t, reset);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onEnd, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [onPrev, onNext, reset, clampPan, zoomToPoint]);

  const zoomed = transform.scale > 1;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="product-lightbox"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        title="Close"
        data-testid="product-lightbox-close"
      >
        <X size={22} />
      </button>
      {onPrev && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          className="absolute left-3 sm:left-5 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          title="Previous (←)"
          data-testid="product-lightbox-prev"
        >
          <CaretLeft size={26} />
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          className="absolute right-3 sm:right-5 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          title="Next (→)"
          data-testid="product-lightbox-next"
        >
          <CaretRight size={26} />
        </button>
      )}
      <figure
        ref={figureRef}
        className="flex flex-col items-center gap-3"
        style={{ touchAction: "none" }}
        onClick={(e) => e.stopPropagation()}
        data-testid="product-lightbox-figure"
      >
        <img
          ref={imgRef}
          src={url}
          alt={caption || "product"}
          draggable={false}
          className="max-w-[92vw] max-h-[80vh] object-contain rounded-lg shadow-2xl bg-white select-none"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transition: gesturingRef.current ? "none" : "transform 0.2s ease",
            cursor: zoomed ? "grab" : "zoom-in",
            willChange: "transform",
          }}
        />
        {caption ? (
          <figcaption className="text-white/90 text-sm text-center max-w-[92vw] break-words">
            {caption}
          </figcaption>
        ) : null}
        {Array.isArray(thumbnails) && thumbnails.length > 1 ? (
          <div
            className="flex gap-2 overflow-x-auto max-w-[92vw] pb-1"
            data-testid="product-lightbox-thumbs"
          >
            {thumbnails.map((t, i) => (
              <button
                key={`${t}|${i}`}
                type="button"
                onClick={(e) => { e.stopPropagation(); onSelect && onSelect(i); }}
                className={`shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 transition-all ${
                  i === activeIndex
                    ? "border-white"
                    : "border-white/20 opacity-60 hover:opacity-100"
                }`}
                title={`Image ${i + 1}`}
                data-testid="product-lightbox-thumb"
              >
                <img
                  src={t}
                  alt={`thumbnail ${i + 1}`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        ) : null}
      </figure>
    </div>,
    document.body,
  );
};

// ─── main component ──────────────────────────────────────────────────
/**
 * <ProductThumbnail style="Linen Wrap Dress" url={urlFor(style)} />
 *
 * Renders a square thumbnail for a style. If `url` is falsy, a
 * deterministic coloured placeholder with 2-letter monogram is shown.
 * Clicking a real image expands it to a full-screen lightbox. Admins see
 * a small corner edit affordance on hover to attach / change the image.
 */
const ProductThumbnail = ({
  style,
  url,
  size = 40,
  allowEdit = true,
  expandable = true,
  className = "",
}) => {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" && allowEdit;
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [blobUrl, setBlobUrl] = useState(() => (url && blobCacheGet(url)) || null);

  // Refs so a deferred blob resolution can verify it still applies: the
  // component may have been reused for a different URL (list rows) or
  // unmounted while the request was in flight.
  const urlRef = useRef(url);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Reset failure/blob state when the component is reused with a new URL.
  useEffect(() => {
    urlRef.current = url;
    setFailed(false);
    setBlobUrl((url && blobCacheGet(url)) || null);
  }, [url]);

  const effectiveUrl = !failed ? (blobUrl || url || "") : "";
  const canExpand = expandable && !!effectiveUrl;

  const onImgError = useCallback(() => {
    // Direct load failed — likely a 401 from a cookie-less <img> request.
    // Retry once with the Bearer-authenticated client before giving up.
    const failedFor = url;
    if (!blobUrl && isApiImageUrl(failedFor)) {
      fetchAuthedBlob(failedFor).then((obj) => {
        // Stale resolution guard: only apply if still mounted AND still
        // showing the URL this fetch was started for.
        if (!mountedRef.current || urlRef.current !== failedFor) return;
        if (obj) setBlobUrl(obj);
        else setFailed(true);
      });
    } else {
      // The object URL itself failed (evicted/revoked) — drop the dead
      // cache entry so the next mount refetches, and show the placeholder.
      if (blobUrl) BLOB_CACHE.delete(failedFor);
      setFailed(true);
    }
  }, [url, blobUrl]);

  const onChanged = useCallback(() => {
    setFailed(false);
  }, []);

  return (
    <>
      <div
        className={`group relative inline-block rounded-md overflow-hidden border border-border shrink-0 align-middle ${className}`}
        style={{ width: size, height: size }}
        data-testid={`product-thumbnail-${style}`}
      >
        {effectiveUrl ? (
          <img
            src={effectiveUrl}
            alt={style}
            className={`w-full h-full object-cover ${canExpand ? "cursor-zoom-in" : ""}`}
            loading="lazy"
            onError={onImgError}
            onClick={canExpand ? (e) => { e.stopPropagation(); setLightbox(true); } : undefined}
          />
        ) : (
          <Placeholder style={style} size={size} />
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="absolute top-0 right-0 m-0.5 p-1 rounded bg-black/55 text-white opacity-0 group-hover:opacity-100 transition-opacity"
            title={effectiveUrl ? "Change thumbnail" : "Add thumbnail"}
            data-testid={`product-thumbnail-edit-${style}`}
          >
            {effectiveUrl ? <Pencil size={Math.max(10, Math.round(size * 0.3))} /> : <Camera size={Math.max(10, Math.round(size * 0.3))} />}
          </button>
        )}
      </div>
      {editing && (
        <Editor
          style={style}
          currentUrl={url}
          onClose={() => setEditing(false)}
          onChanged={onChanged}
        />
      )}
      {lightbox && effectiveUrl && (
        <Lightbox
          url={effectiveUrl}
          caption={style}
          onClose={() => setLightbox(false)}
        />
      )}
    </>
  );
};

export default ProductThumbnail;
