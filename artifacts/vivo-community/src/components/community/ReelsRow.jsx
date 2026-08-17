import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, Heart, X, Volume2, VolumeX, ChevronUp, ChevronDown, Share2, Check } from "lucide-react";
import { REELS } from "./reelsData";
import { SectionHeader } from "./ui";

// Per-member reel likes, kept client-side (same demo-local pattern as the
// entry store). Guest fallback keeps the player working pre-hydration.
const likeKey = (memberId) => `vivo_reel_likes:${memberId || "guest"}`;
const loadLikes = (memberId) => {
  try {
    const raw = JSON.parse(localStorage.getItem(likeKey(memberId)) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
};
const saveLikes = (memberId, set) => {
  try { localStorage.setItem(likeKey(memberId), JSON.stringify([...set])); } catch { /* private mode */ }
};

const TILE_TONES = {
  charcoal: "bg-foreground text-background",
  cream: "bg-secondary text-foreground border border-border",
  orange: "bg-[#FE5000] text-white",
};

function ReelTile({ reel, onOpen }) {
  const tone = TILE_TONES[reel.tone] || TILE_TONES.charcoal;
  return (
    <button
      data-testid={`reel-card-${reel.id}`}
      onClick={onOpen}
      aria-label={`Play reel: ${reel.title}`}
      className={`relative w-[150px] sm:w-[168px] aspect-[9/16] shrink-0 snap-start rounded overflow-hidden text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${reel.poster ? "bg-foreground text-white" : tone}`}
    >
      {reel.poster && (
        <img src={reel.poster} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover opacity-90" />
      )}
      {!reel.poster && (
        <div className={`absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl pointer-events-none ${reel.tone === "cream" ? "bg-primary/10" : "bg-white/10"}`} />
      )}
      <div className={`absolute top-3 left-3 text-[9px] font-bold uppercase tracking-widest ${reel.poster ? "text-white/90" : "opacity-70"}`}>Reel</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="w-11 h-11 rounded-full bg-background/90 text-foreground flex items-center justify-center shadow-md transition-transform group-hover:scale-105">
          <Play size={16} className="fill-current ml-0.5" />
        </span>
      </div>
      <div className={`absolute inset-x-0 bottom-0 p-3 ${reel.poster ? "bg-gradient-to-t from-black/70 to-transparent" : ""}`}>
        <div className="font-serif text-[13px] leading-snug line-clamp-3">{reel.title}</div>
        <div className={`mt-1.5 text-[10px] font-semibold tabular-nums ${reel.poster ? "text-white/70" : "opacity-60"}`}>{reel.duration}</div>
      </div>
    </button>
  );
}

function ReelPlayer({ reels, index, onClose, onStep, liked, onToggleLike }) {
  const reel = reels[index];
  const videoRef = useRef(null);
  const touchY = useRef(null);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);

  // Lock page scroll while the player is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") onStep(1);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") onStep(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  // Reels play WITH sound — opening the player is a user gesture, so unmuted
  // autoplay is normally allowed. If the browser still refuses, fall back to
  // muted playback (the mute control lets her turn sound on).
  useEffect(() => {
    setPaused(false);
    setCopied(false);
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    const attempt = v.play();
    if (attempt?.catch) {
      attempt.catch(() => {
        setMuted(true);
        v.muted = true;
        v.play().catch(() => setPaused(true));
      });
    }
  }, [reel.id]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted, reel.id]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPaused(false); }
    else { v.pause(); setPaused(true); }
  };

  const share = async () => {
    const url = window.location.origin + import.meta.env.BASE_URL;
    const text = `${reel.title} — ${reel.caption}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Fresh from Vivo", text, url }); } catch { /* dismissed */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const tone = TILE_TONES[reel.tone] || TILE_TONES.charcoal;
  const likeCount = (reel.likes || 0) + (liked ? 1 : 0);
  // Action-rail labels sit over the stage: white everywhere except the cream
  // placeholder tile, where charcoal keeps them readable.
  const railText = reel.video_url || reel.poster || reel.tone !== "cream" ? "text-white" : "text-foreground";

  return createPortal(
    <div
      data-testid="reel-player"
      role="dialog"
      aria-modal="true"
      aria-label={`Reel: ${reel.title}`}
      className="fixed inset-0 z-[100] bg-[#161311]/[0.98] flex items-center justify-center animate-in fade-in duration-200"
      onTouchStart={(e) => { touchY.current = e.touches[0].clientY; }}
      onTouchEnd={(e) => {
        if (touchY.current === null) return;
        const dy = e.changedTouches[0].clientY - touchY.current;
        touchY.current = null;
        if (dy < -60) onStep(1);
        else if (dy > 60) onStep(-1);
      }}
    >
      <button
        data-testid="reel-close"
        onClick={onClose}
        aria-label="Close reel"
        className="absolute top-4 right-4 z-10 w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <X size={20} />
      </button>

      {/* Desktop prev/next; on touch, swipe up/down */}
      <div className="hidden sm:flex flex-col gap-3 absolute right-6 top-1/2 -translate-y-1/2 z-10">
        <button data-testid="reel-prev" onClick={() => onStep(-1)} disabled={index === 0} aria-label="Previous reel" className="w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 disabled:opacity-30 disabled:pointer-events-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          <ChevronUp size={20} />
        </button>
        <button data-testid="reel-next" onClick={() => onStep(1)} disabled={index === reels.length - 1} aria-label="Next reel" className="w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 disabled:opacity-30 disabled:pointer-events-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          <ChevronDown size={20} />
        </button>
      </div>

      <div className="relative h-[92dvh] aspect-[9/16] max-w-[94vw] rounded overflow-hidden shadow-2xl">
        {reel.video_url ? (
          <>
            <video
              ref={videoRef}
              key={reel.id}
              src={reel.video_url}
              poster={reel.poster || undefined}
              loop
              playsInline
              onClick={togglePlay}
              className="w-full h-full object-cover bg-black cursor-pointer"
            />
            {paused && (
              <button onClick={togglePlay} aria-label="Play" className="absolute inset-0 flex items-center justify-center bg-black/30">
                <span className="w-16 h-16 rounded-full bg-white/90 text-foreground flex items-center justify-center">
                  <Play size={24} className="fill-current ml-1" />
                </span>
              </button>
            )}
            <div className="absolute inset-x-0 bottom-0 p-4 pr-16 bg-gradient-to-t from-black/75 via-black/30 to-transparent text-white pointer-events-none">
              <div className="font-serif text-lg leading-snug mb-1">{reel.title}</div>
              <p className="text-[13px] text-white/80 leading-relaxed">{reel.caption}</p>
            </div>
          </>
        ) : (
          <div className={`w-full h-full relative flex flex-col items-center justify-center text-center p-8 ${tone}`}>
            <div className={`absolute -top-10 -right-10 w-44 h-44 rounded-full blur-3xl pointer-events-none ${reel.tone === "cream" ? "bg-primary/10" : "bg-white/10"}`} />
            <div className="text-[10px] font-bold uppercase tracking-widest opacity-70 mb-4">Fresh from Vivo</div>
            <div className="font-serif text-2xl leading-snug mb-3 max-w-[16ch]">{reel.title}</div>
            <p className="text-sm opacity-80 leading-relaxed max-w-[26ch]">{reel.caption}</p>
            <div className="mt-8 text-[11px] uppercase tracking-wider font-semibold opacity-60">This reel is on its way</div>
          </div>
        )}

        {/* Action rail */}
        <div className="absolute right-3 bottom-4 flex flex-col items-center gap-4">
          <button data-testid="reel-like" onClick={onToggleLike} aria-pressed={liked} aria-label="Like this reel" className={`flex flex-col items-center gap-1 ${railText} rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white`}>
            <span className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${liked ? "bg-primary text-primary-foreground" : "bg-black/40 text-white backdrop-blur"}`}>
              <Heart size={18} className={liked ? "fill-current" : ""} />
            </span>
            <span className="text-[11px] font-semibold tabular-nums drop-shadow">{likeCount}</span>
          </button>
          <button data-testid="reel-share" onClick={share} aria-label="Share this reel" className={`flex flex-col items-center gap-1 ${railText} rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white`}>
            <span className="w-11 h-11 rounded-full bg-black/40 text-white backdrop-blur flex items-center justify-center">
              {copied ? <Check size={18} /> : <Share2 size={18} />}
            </span>
            <span className="text-[11px] font-semibold drop-shadow">{copied ? "Copied" : "Share"}</span>
          </button>
          {reel.video_url && (
            <button data-testid="reel-mute" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Turn sound on" : "Mute"} className={`flex flex-col items-center gap-1 ${railText} rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white`}>
              <span className="w-11 h-11 rounded-full bg-black/40 text-white backdrop-blur flex items-center justify-center">
                {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Position dots */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
        {reels.map((r, i) => (
          <span key={r.id} className={`h-1 rounded-full transition-all ${i === index ? "w-5 bg-white" : "w-1.5 bg-white/40"}`} />
        ))}
      </div>
    </div>,
    document.body
  );
}

export default function ReelsRow({ member, limit, onViewAll }) {
  const [openIdx, setOpenIdx] = useState(-1);
  const [likes, setLikes] = useState(() => loadLikes(member?.id));
  useEffect(() => { setLikes(loadLikes(member?.id)); }, [member?.id]);

  const toggleLike = useCallback((id) => {
    setLikes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveLikes(member?.id, next);
      return next;
    });
  }, [member?.id]);

  /* Home shows a capped strip (limit + View All); Community shows all. */
  const shown = limit ? REELS.slice(0, limit) : REELS;

  const step = useCallback((d) => {
    setOpenIdx((i) => Math.min(shown.length - 1, Math.max(0, i + d)));
  }, [shown.length]);

  const open = openIdx >= 0 ? shown[openIdx] : null;

  if (!shown.length) return null;
  return (
    <section data-testid="reels-row">
      <div className="flex items-end justify-between gap-4">
        <SectionHeader
          kicker="Fresh from Vivo"
          title="Reels we can't stop replaying"
          sub="Straight from our TikTok and Instagram — tap to watch with sound."
        />
        {onViewAll && (
          <button
            data-testid="reels-view-all"
            onClick={onViewAll}
            className="shrink-0 mb-6 text-[13px] font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            View All
          </button>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto hide-scrollbar snap-x snap-mandatory -mx-4 px-4 sm:mx-0 sm:px-0 pb-1">
        {shown.map((r, i) => (
          <ReelTile key={r.id} reel={r} onOpen={() => setOpenIdx(i)} />
        ))}
      </div>
      {open && (
        <ReelPlayer
          reels={shown}
          index={openIdx}
          onClose={() => setOpenIdx(-1)}
          onStep={step}
          liked={likes.has(open.id)}
          onToggleLike={() => toggleLike(open.id)}
        />
      )}
    </section>
  );
}
