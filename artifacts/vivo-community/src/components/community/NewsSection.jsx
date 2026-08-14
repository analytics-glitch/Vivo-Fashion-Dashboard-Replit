import React from "react";
import { ChevronRight } from "lucide-react";
import { NEWS } from "./newsData";
import { SectionHeader, cardCls } from "./ui";

const COVER_TONES = {
  orange: "bg-[#FE5000] text-white",
  charcoal: "bg-foreground text-background",
  cream: "bg-secondary text-foreground",
};

/* Editorial cover: real photo when marketing supplies `image`, otherwise the
   house-style typographic treatment driven by `cover` in newsData.js. */
export function NewsCover({ article, size = "md", className = "" }) {
  if (article.image) {
    return <img src={article.image} alt="" loading="lazy" className={`w-full h-full object-cover ${className}`} />;
  }
  const tone = COVER_TONES[article.cover?.tone] || COVER_TONES.cream;
  const mark = { sm: "text-2xl", md: "text-3xl sm:text-4xl", lg: "text-5xl sm:text-6xl" }[size] || "text-3xl";
  return (
    <div className={`w-full h-full relative flex flex-col items-center justify-center text-center p-4 overflow-hidden ${tone} ${className}`}>
      <div className={`absolute -top-6 -right-6 w-24 h-24 sm:w-36 sm:h-36 rounded-full blur-2xl pointer-events-none ${article.cover?.tone === "cream" ? "bg-primary/10" : "bg-white/10"}`} />
      <div className={`font-serif leading-none ${mark}`}>{article.cover?.mark}</div>
      {size !== "sm" && article.cover?.sub && (
        <div className="mt-3 text-[9px] sm:text-[10px] font-bold uppercase tracking-widest opacity-75">{article.cover.sub}</div>
      )}
    </div>
  );
}

function KickerRow({ article }) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest mb-1.5">
      <span className="text-primary-ink">{article.kicker}</span>
      <span className="w-1 h-1 rounded-full bg-border" aria-hidden="true" />
      <span className="text-muted-foreground font-semibold">{article.date}</span>
    </div>
  );
}

function NewsCardFeatured({ article, onOpen }) {
  return (
    <button
      data-testid={`news-card-${article.id}`}
      onClick={() => onOpen(article.id)}
      className={`${cardCls} w-full text-left overflow-hidden group hover:-translate-y-0.5 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="aspect-[16/9] overflow-hidden">
        <NewsCover article={article} size="lg" />
      </div>
      <div className="p-5 sm:p-6">
        <KickerRow article={article} />
        <h4 className="font-serif text-xl sm:text-2xl leading-snug text-foreground mb-2">{article.headline}</h4>
        <p className="text-[14px] text-muted-foreground leading-relaxed line-clamp-2 mb-3">{article.teaser}</p>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors inline-flex items-center gap-0.5">
          Read the story <ChevronRight size={11} />
        </span>
      </div>
    </button>
  );
}

function NewsCardMini({ article, onOpen }) {
  return (
    <button
      data-testid={`news-card-${article.id}`}
      onClick={() => onOpen(article.id)}
      className={`${cardCls} w-full text-left overflow-hidden group hover:-translate-y-0.5 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="aspect-[4/3] overflow-hidden">
        <NewsCover article={article} size="md" />
      </div>
      <div className="p-4">
        <KickerRow article={article} />
        <h4 className="font-serif text-[16px] leading-snug text-foreground line-clamp-2">{article.headline}</h4>
      </div>
    </button>
  );
}

/* Compact horizontal card — used interleaved in the feed and as "More from
   Vivo" on the article page. */
export function NewsCardCompact({ article, onOpen }) {
  return (
    <button
      data-testid={`news-card-${article.id}`}
      onClick={() => onOpen(article.id)}
      className={`${cardCls} w-full text-left p-4 flex items-center gap-4 hover:-translate-y-0.5 transition-transform group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="w-24 h-24 shrink-0 rounded overflow-hidden">
        <NewsCover article={article} size="sm" />
      </div>
      <div className="flex-grow min-w-0">
        <KickerRow article={article} />
        <div className="font-serif text-[16px] leading-snug text-foreground line-clamp-2">{article.headline}</div>
        <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors flex items-center gap-0.5">
          Read the story <ChevronRight size={11} />
        </div>
      </div>
    </button>
  );
}

/* "What's new at Vivo" — featured story + two minis. The remaining stories
   appear interleaved further down the feed (see TabHome). */
export default function NewsSection({ onOpenNews }) {
  const [featured, a, b] = NEWS;
  if (!featured) return null;
  return (
    <section data-testid="news-section">
      <SectionHeader kicker="Vivo News" title="What's new at Vivo" />
      <div className="space-y-4">
        <NewsCardFeatured article={featured} onOpen={onOpenNews} />
        {(a || b) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {a && <NewsCardMini article={a} onOpen={onOpenNews} />}
            {b && <NewsCardMini article={b} onOpen={onOpenNews} />}
          </div>
        )}
      </div>
    </section>
  );
}
