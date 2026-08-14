import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { FABULAS_SERIES, FABULAS_STORIES } from "./fabulasStories";

/* #FabulasAtAnyAge — the most editorial surface in the app. Serif headlines,
   generous imagery, magazine pacing. Stories are selected by the Vivo team
   from consented submissions; the invitation at the end feeds the
   #MyVivoStory ritual. */

const PALETTES = {
  terracotta: "bg-gradient-to-br from-[#c96f4a] via-[#b85c3e] to-[#8f3f2c]",
  sage: "bg-gradient-to-br from-[#8a9b7d] via-[#75885f] to-[#55663f]",
  rose: "bg-gradient-to-br from-[#c98a95] via-[#b06e7d] to-[#8a4f60]",
};

/* Editorial image slot — real campaign photo when the team has uploaded it,
   warm tonal placeholder (age + quote overlaid) until then. */
export function FabulasImage({ story, className = "", sizes = "lg" }) {
  const [failed, setFailed] = useState(false);
  const quoteCls = sizes === "sm" ? "text-[13px] leading-snug line-clamp-3" : "text-[17px] sm:text-[19px] leading-snug";
  const ageCls = sizes === "sm" ? "text-3xl" : "text-5xl sm:text-6xl";
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {!failed ? (
        <img
          src={story.image}
          alt={`${story.headline} — ${story.outfit}`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className={`w-full h-full ${PALETTES[story.palette] || PALETTES.terracotta} flex flex-col justify-between p-5 sm:p-6 text-white`}>
          <div className={`font-serif ${ageCls} leading-none opacity-95`}>{story.age}</div>
          <div>
            <p className={`font-serif italic ${quoteCls} opacity-95`}>&ldquo;{story.quote}&rdquo;</p>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] mt-3 opacity-80">{FABULAS_SERIES.hashtag}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* Full story — magazine mini-feature in a full-screen editorial overlay. */
export function FabulasStoryView({ storyId, onClose, onShareStory }) {
  const idx = Math.max(0, FABULAS_STORIES.findIndex((s) => s.id === storyId));
  const [i, setI] = useState(idx);
  const story = FABULAS_STORIES[i] || FABULAS_STORIES[0];

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-background overflow-y-auto overscroll-contain" role="dialog" aria-modal="true" aria-label={story.headline} data-testid={`fabulas-story-${story.id}`}>
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-3xl px-4 sm:px-8 h-14 flex items-center justify-between gap-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary-ink truncate">{FABULAS_SERIES.hashtag}</span>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous story" data-testid="fabulas-prev"
                    onClick={() => setI((v) => (v - 1 + FABULAS_STORIES.length) % FABULAS_STORIES.length)}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <ChevronLeft size={18} />
            </button>
            <button type="button" aria-label="Next story" data-testid="fabulas-next"
                    onClick={() => setI((v) => (v + 1) % FABULAS_STORIES.length)}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <ChevronRight size={18} />
            </button>
            <button type="button" aria-label="Close story" data-testid="fabulas-close" onClick={onClose}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <X size={18} />
            </button>
          </div>
        </div>
      </div>

      <article className="mx-auto max-w-3xl px-4 sm:px-8 pb-20">
        <header className="pt-10 sm:pt-14 pb-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-muted-foreground mb-4">
            With {FABULAS_SERIES.partner}
          </p>
          <h1 className="font-serif text-4xl sm:text-5xl text-foreground leading-tight" data-testid="fabulas-headline">{story.headline}</h1>
        </header>

        <FabulasImage story={story} className="aspect-[4/5] sm:aspect-[3/4] max-h-[70vh] rounded" />
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground text-center mt-3 mb-10">
          Styled: {story.outfit}
        </p>

        <blockquote className="font-serif italic text-2xl sm:text-[28px] leading-snug text-foreground text-center max-w-xl mx-auto mb-10">
          &ldquo;{story.quote}&rdquo;
        </blockquote>

        <div className="space-y-5 max-w-xl mx-auto">
          {story.body.map((p, k) => (
            <p key={k} className="text-[16px] leading-relaxed text-foreground/85">{p}</p>
          ))}
          <p className="text-[12px] text-muted-foreground pt-2">
            From the {FABULAS_SERIES.hashtag} campaign with {FABULAS_SERIES.partner} — celebrating women over 50 wearing Vivo.
          </p>
        </div>

        {/* The editorial series and the community ritual feed each other. */}
        <div className="mt-14 border-t border-border pt-10 text-center max-w-xl mx-auto">
          <h2 className="font-serif text-2xl text-foreground mb-2">Every woman has a story. Share yours.</h2>
          <p className="text-[13px] text-muted-foreground leading-relaxed mb-6">
            Share it through #MyVivoStory — the Vivo team chooses future features from consented
            submissions, and we&apos;ll reach out personally if yours is one of them. Sharing never
            auto-publishes a feature.
          </p>
          <button
            type="button"
            data-testid="fabulas-share-cta"
            onClick={() => { onClose(); onShareStory?.(); }}
            className="inline-flex items-center gap-2 bg-foreground text-background h-11 px-7 rounded font-medium text-[14px] hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Share my story <ArrowRight size={15} />
          </button>
        </div>
      </article>
    </div>,
    document.body
  );
}

/* Elegant editorial collection — horizontal snap carousel for the
   celebration wall. */
export function FabulasCarousel({ onOpenStory }) {
  return (
    <section data-testid="fabulas-carousel">
      <div className="mb-4">
        <h3 className="text-lg font-serif text-foreground leading-snug">{FABULAS_SERIES.header}</h3>
        <p className="text-[12px] text-muted-foreground mt-1 max-w-2xl leading-relaxed">{FABULAS_SERIES.intro}</p>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x snap-mandatory [-webkit-overflow-scrolling:touch]">
        {FABULAS_STORIES.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`fabulas-card-${s.id}`}
            onClick={() => onOpenStory(s.id)}
            className="snap-start shrink-0 w-52 sm:w-60 text-left rounded overflow-hidden border border-border bg-card hover:shadow-md transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <FabulasImage story={s} sizes="sm" className="aspect-[4/5]" />
            <div className="p-3.5">
              <div className="font-serif text-[15px] text-foreground">{s.headline}</div>
              <div className="text-[11px] text-muted-foreground mt-1 line-clamp-1">{s.outfit}</div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

/* Home feed slot — one rotating feature, editorial treatment. */
export function FabulasHomeCard({ story, onOpenStory }) {
  if (!story) return null;
  return (
    <div data-testid="home-fabulas-card" className="rounded overflow-hidden border border-border bg-card">
      <button
        type="button"
        onClick={() => onOpenStory(story.id)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid="home-fabulas-open"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2">
          <FabulasImage story={story} className="aspect-[4/3] sm:aspect-auto sm:min-h-[260px]" />
          <div className="p-6 sm:p-7 flex flex-col justify-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-primary-ink mb-3">Her Story · {FABULAS_SERIES.hashtag}</p>
            <h3 className="font-serif text-2xl text-foreground leading-tight mb-3">{story.headline}</h3>
            <p className="font-serif italic text-[16px] text-foreground/80 leading-snug mb-4">&ldquo;{story.quote}&rdquo;</p>
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary-ink">
              Read her story <ArrowRight size={14} />
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}
