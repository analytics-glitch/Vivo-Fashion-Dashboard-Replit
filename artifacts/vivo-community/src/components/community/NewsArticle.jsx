import React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { NEWS, newsFromPageId, newsPageId } from "./newsData";
import { NewsCover, NewsCardCompact } from "./NewsSection";

/* Simple article view for a Vivo News story. Routed like the legal pages via
   ?page=news-{id} (see CommunityShell), so browser back works naturally. */
export default function NewsArticle({ pageId, onBack, onOpenPage, onOpenEvents, onOpenEvent }) {
  const article = newsFromPageId(pageId);

  if (!article) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <p className="text-muted-foreground mb-6">That story isn't available any more.</p>
        <button data-testid="news-article-back" onClick={onBack} className="text-[13px] font-semibold uppercase tracking-wider text-foreground inline-flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <ArrowLeft size={15} /> Back
        </button>
      </div>
    );
  }

  const others = NEWS.filter((n) => n.id !== article.id).slice(0, 2);

  return (
    <article data-testid={`news-article-${article.id}`} className="max-w-2xl mx-auto animate-in fade-in duration-300">
      <button
        data-testid="news-article-back"
        onClick={onBack}
        className="mb-8 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5 min-h-[44px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <div className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-widest mb-4">
        <span className="text-primary-ink">{article.kicker}</span>
        <span className="w-1 h-1 rounded-full bg-border" aria-hidden="true" />
        <span className="text-muted-foreground font-semibold">{article.date}</span>
      </div>

      <h1 className="font-serif text-3xl sm:text-4xl leading-tight text-foreground mb-4">{article.headline}</h1>
      <p className="text-lg text-muted-foreground leading-relaxed mb-8">{article.teaser}</p>

      <div className="aspect-[16/9] rounded overflow-hidden mb-10">
        <NewsCover article={article} size="lg" />
      </div>

      <div className="space-y-5 text-[15px] leading-relaxed text-foreground/90 mb-14">
        {article.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {article.event_id && (
        <div data-testid="news-event-link" className="bg-secondary border border-border rounded p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4 justify-between -mt-6 mb-14">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">Join us</div>
            <div className="font-serif text-[17px] text-foreground leading-snug">
              There's a gathering for this story — spots are limited, so save yours.
            </div>
          </div>
          <button
            data-testid="news-event-cta"
            onClick={() => (article.event_id && onOpenEvent ? onOpenEvent(article.event_id) : onOpenEvents?.())}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 bg-foreground text-background hover:bg-foreground/90 transition-colors text-[13px] font-medium px-5 h-10 rounded active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            See the event <ArrowRight size={14} />
          </button>
        </div>
      )}

      {others.length > 0 && (
        <div className="border-t border-border pt-10">
          <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-4">More from Vivo</div>
          <div className="space-y-4">
            {others.map((o) => (
              <NewsCardCompact key={o.id} article={o} onOpen={(id) => onOpenPage(newsPageId(id))} />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
