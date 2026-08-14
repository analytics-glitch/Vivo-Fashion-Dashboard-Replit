import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Camera, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, API } from "@/lib/api";
import { fetchAuthedBlob } from "@/components/ProductThumbnail";

export function TierBadge({ tier, className = "" }) {
  const gradients = {
    Tsavorite: "from-[#d7eedd] to-[#aeddbe] text-[#1e5b3c]",
    Ruby: "from-[#e8b9c0] to-[#dfa3b0] text-[#701c31]",
    Tanzanite: "from-[#d5daf6] to-[#b4bdf0] text-[#383c82]",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gradient-to-br ${gradients[tier] || gradients.Tsavorite} shadow-sm ${className}`}>
      {tier}
    </span>
  );
}

export function PointsAction({ onClick, children, points = 10, className = "" }) {
  const [floats, setFloats] = useState([]);

  const handleClick = (e) => {
    const id = Date.now();
    setFloats(prev => [...prev, id]);
    setTimeout(() => {
      setFloats(prev => prev.filter(f => f !== id));
    }, 1000);
    if(onClick) onClick(e);
  };

  return (
    <div className={`relative inline-block ${className}`}>
      <div onClick={handleClick} className="cursor-pointer">{children}</div>
      {floats.map(id => (
        <div key={id} className="absolute -top-6 left-1/2 -translate-x-1/2 text-[#C43E00] font-bold text-sm pointer-events-none animate-float-up whitespace-nowrap z-50 drop-shadow-md">
          +{points} pts
        </div>
      ))}
    </div>
  );
}

export function Avatar({ initials, tier, size = "md" }) {
  const sizes = {
    sm: "w-8 h-8 text-xs",
    md: "w-12 h-12 text-sm",
    lg: "w-20 h-20 text-xl",
  };
  const borders = {
    Tsavorite: "border-[#aeddbe]",
    Ruby: "border-[#dfa3b0]",
    Tanzanite: "border-[#bfc7f1]",
  };
  return (
    <div className={`${sizes[size]} rounded-full flex items-center justify-center bg-[#e8dfd5] text-[#2c2a29] font-bold border-2 ${borders[tier] || "border-transparent"}`}>
      {initials}
    </div>
  );
}

// ─── slot images ──────────────────────────────────────────────────────
// Every 📸 picture spot on the Community App prototype is an addressable
// "slot". Uploaded photos persist in Postgres (BYTEA) behind the
// session-gated /api/community-app/images* endpoints; this layer fetches
// the filled-slot manifest ONCE per page visit and lets any placeholder
// upload / replace / remove its own photo in place, so the team can dress
// the prototype with real imagery without code changes.

const SLOT_MAX_BYTES = 5 * 1024 * 1024; // keep in lockstep with the backend cap
const SLOT_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
const SLOT_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];

const SlotImagesContext = createContext(null);

export function SlotImagesProvider({ children }) {
  const [slots, setSlots] = useState({});
  const refresh = useCallback(async () => {
    try {
      // forceFresh: the shared GET cache would otherwise serve a manifest
      // from up to 5 minutes ago on a quick page revisit, hiding photos
      // that were just uploaded (by this user or a colleague).
      const { data } = await api.get("/community-app/images", { forceFresh: true });
      setSlots(data?.slots || {});
    } catch {
      // Manifest unavailable → placeholders still render; uploads will toast.
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const setSlot = useCallback((slotId, meta) => {
    setSlots((prev) => {
      const next = { ...prev };
      if (meta) next[slotId] = meta;
      else delete next[slotId];
      return next;
    });
  }, []);
  return (
    <SlotImagesContext.Provider value={{ slots, refresh, setSlot }}>
      {children}
    </SlotImagesContext.Provider>
  );
}

const NO_SLOTS = { slots: {}, refresh: () => {}, setSlot: () => {} };
export function useSlotImages() {
  return useContext(SlotImagesContext) || NO_SLOTS;
}

export const slotImageUrl = (slotId, meta) =>
  `${API}/community-app/images/${encodeURIComponent(slotId)}?v=${meta?.version || 0}`;

// Direct <img src> first; if it fails (the httpOnly cookie is absent in the
// workspace preview iframe / Safari with third-party cookies blocked), retry
// once through the authed axios client and swap in an object URL — the same
// shared fallback ProductThumbnail uses, so every image surface shares one
// blob cache + failure memory.
function useAuthedImageSrc(url) {
  const [src, setSrc] = useState(url);
  useEffect(() => { setSrc(url); }, [url]);
  const onError = useCallback(() => {
    if (!url) { setSrc(null); return; }
    setSrc(null); // hide the broken <img> while the authed retry runs
    fetchAuthedBlob(url).then((obj) => {
      setSrc((cur) => (cur === null ? obj : cur));
    });
  }, [url]);
  return [src, onError];
}

// Display-only slot image (e.g. the tiny product chips inside a shoppable
// look, which mirror the shop product-card slots). Renders the photo when
// the slot is filled, else the fallback node.
export function SlotImage({ slotId, className = "", fallback = null }) {
  const { slots } = useSlotImages();
  const meta = slotId ? slots[slotId] : null;
  const url = meta ? slotImageUrl(slotId, meta) : null;
  const [src, onError] = useAuthedImageSrc(url);
  if (!meta || !src) return fallback;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={className}
      onError={onError}
      data-testid={`slot-img-${slotId}`}
    />
  );
}

// The prototype's picture spot. Without `slotId` it is the plain beige 📸
// box it always was. With `slotId` it becomes a live slot: shows the
// uploaded photo when the manifest has one, and reveals upload / replace /
// remove controls on hover for everyone who can view the page.
// `fit="cover"` (default) crops to the spot's aspect; `fit="contain"`
// letterboxes the full photo on the beige background — use it for product
// shots so garments are never cropped. `imgClassName` styles the photo only
// (useful when the old container styles — dim/zoom effects — would also hit
// the controls).
export function ImagePlaceholder({
  aspectRatio = "aspect-[4/5]",
  className = "",
  slotId,
  imgClassName = "",
  controlPos = "bottom-right",
  fit = "cover",
}) {
  const { slots, setSlot } = useSlotImages();
  const meta = slotId ? slots[slotId] : null;
  const url = meta ? slotImageUrl(slotId, meta) : null;
  const [src, onImgError] = useAuthedImageSrc(url);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const pick = (e) => {
    e.preventDefault();
    e.stopPropagation(); // placeholders sit inside clickable cards
    fileRef.current?.click();
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file || !slotId || busy) return;
    if (file.type && !SLOT_TYPES.includes(file.type.toLowerCase())) {
      toast.error("That file isn't a supported image — use JPG, PNG, GIF or WebP.");
      return;
    }
    if (file.size > SLOT_MAX_BYTES) {
      toast.error("Image is too large — 5 MB max.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name || "photo");
      const { data } = await api.post(
        `/community-app/images/${encodeURIComponent(slotId)}`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setSlot(slotId, {
        version: data?.version || Date.now(),
        content_type: data?.content_type,
        size_bytes: data?.size_bytes,
      });
      toast.success("Photo uploaded");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't upload that image — try another file.");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!slotId || busy) return;
    setBusy(true);
    try {
      await api.delete(`/community-app/images/${encodeURIComponent(slotId)}`);
      setSlot(slotId, null);
      toast.success("Photo removed");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't remove the photo.");
    } finally {
      setBusy(false);
    }
  };

  const hasImage = !!(meta && src);
  const posCls = controlPos === "top-right" ? "top-2 right-2" : "bottom-2 right-2";

  return (
    <div
      className={`w-full bg-[#ebdcd0] rounded-xl flex items-center justify-center text-[#c9b4a1] ${aspectRatio} ${className} ${slotId ? "relative overflow-hidden group/slot" : ""}`}
      data-testid={slotId ? `slot-${slotId}` : undefined}
    >
      {!hasImage && <Camera size={34} weight="light" />}
      {hasImage && (
        <img
          src={src}
          onError={onImgError}
          alt=""
          loading="lazy"
          className={`absolute inset-0 w-full h-full ${fit === "contain" ? "object-contain" : "object-cover"} ${imgClassName}`}
          data-testid={`slot-img-${slotId}`}
        />
      )}
      {slotId && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept={SLOT_ACCEPT}
            className="hidden"
            onChange={onFile}
            onClick={(e) => e.stopPropagation()}
            data-testid={`slot-file-${slotId}`}
          />
          {/* Reveal on hover of the surrounding card (`group`) OR of the
              placeholder itself (`group/slot`, for spots with no card
              hover) — some cards paint their own full-cover hover overlay
              over the placeholder, which would swallow its :hover. z-20
              keeps the controls clickable above those overlays. */}
          <div
            className={`absolute ${posCls} z-20 flex items-center gap-1.5 transition-opacity ${
              busy
                ? "opacity-100"
                : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-hover/slot:opacity-100 group-hover/slot:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={pick}
              disabled={busy}
              title={meta ? "Replace photo" : "Upload photo"}
              aria-label={meta ? "Replace photo" : "Upload photo"}
              className="w-8 h-8 rounded-full bg-white/90 backdrop-blur text-[#2c2a29] shadow-md flex items-center justify-center hover:bg-white disabled:opacity-60"
              data-testid={`slot-upload-${slotId}`}
            >
              {busy
                ? <span className="w-3.5 h-3.5 border-2 border-[#FE5000] border-t-transparent rounded-full animate-spin" />
                : <Camera size={16} weight="bold" />}
            </button>
            {meta && !busy && (
              <button
                type="button"
                onClick={onRemove}
                title="Remove photo"
                aria-label="Remove photo"
                className="w-8 h-8 rounded-full bg-white/90 backdrop-blur text-red-600 shadow-md flex items-center justify-center hover:bg-white"
                data-testid={`slot-remove-${slotId}`}
              >
                <Trash size={16} weight="bold" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
