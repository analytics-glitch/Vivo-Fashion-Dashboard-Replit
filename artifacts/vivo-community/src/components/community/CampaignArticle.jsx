import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, Heart, Send, Flag, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Avatar, TierBadge } from "./ui";
import { timeAgo } from "./PostBits";

/* Campaign article — the hero's "Join the Conversation" destination.
   Cover image + campaign story + a real comment wall tied to member
   accounts (same @handle/avatar pattern as the community feed). Reads are
   guest-open; guests see a sign-in invite instead of the composer. First
   comment on an article earns +5 pts (server-enforced, once per article). */

function articleDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-KE", { day: "numeric", month: "long", year: "numeric" }).format(parsed);
}

function CommentRow({ c, onLike, onReport, reported, member }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex gap-3 items-start" data-testid={`article-comment-${c.id}`}>
      <Avatar initials={c.initials} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-foreground">@{c.username}</span>
          {c.tier && <TierBadge tier={c.tier} />}
          <span className="text-[11px] text-muted-foreground">{timeAgo(c.created_at)}</span>
        </div>
        <p className="text-[14px] text-foreground/90 leading-relaxed break-words whitespace-pre-wrap">{c.body}</p>
        <div className="flex items-center gap-4 mt-1 min-h-[24px]">
          {member && (
            <button
              type="button"
              onClick={() => onLike(c)}
              aria-label={c.my_liked ? "Unlike this comment" : "Like this comment"}
              aria-pressed={!!c.my_liked}
              className={`flex items-center gap-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm ${
                c.my_liked ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Heart size={13} className={c.my_liked ? "fill-primary text-primary-ink" : ""} strokeWidth={1.5} />
              {c.like_count > 0 && <span>{c.like_count}</span>}
            </button>
          )}
          {!member && c.like_count > 0 && (
            <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
              <Heart size={13} strokeWidth={1.5} /> {c.like_count}
            </span>
          )}
          {member && (reported ? (
            <span className="text-[11px] text-muted-foreground italic">Thank you — our team will take a look.</span>
          ) : confirming ? (
            <span className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">Report this comment?</span>
              <button
                type="button"
                onClick={() => { setConfirming(false); onReport(c); }}
                className="font-semibold text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
              >
                Yes, report
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
              >
                Cancel
              </button>
            </span>
          ) : (
            !c.mine && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label="Report this comment"
                className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
              >
                <Flag size={11} strokeWidth={1.5} /> Report
              </button>
            )
          ))}
        </div>
      </div>
    </div>
  );
}

export default function CampaignArticle({ slug, member, onBack, onJoin }) {
  const [article, setArticle] = useState(null);
  const [err, setErr] = useState("");
  const [comments, setComments] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState("");
  const [awardToast, setAwardToast] = useState(0);
  const [reportedIds, setReportedIds] = useState(() => new Set());
  const threadTopRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setArticle(null); setErr("");
    api.article(slug)
      .then((d) => { if (alive) setArticle(d.article); })
      .catch((e) => { if (alive) setErr(e?.message || "Could not load this story."); });
    api.articleComments(slug)
      .then((d) => { if (alive) setComments(d.items || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [slug]);

  const patch = (id, delta) =>
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, ...delta } : c)));

  const toggleLike = (c) => {
    const was = { my_liked: c.my_liked, like_count: c.like_count };
    patch(c.id, { my_liked: !c.my_liked, like_count: c.like_count + (c.my_liked ? -1 : 1) });
    api.articleLikeComment(c.id)
      .then((r) => patch(c.id, { my_liked: r.liked, like_count: r.like_count }))
      .catch(() => patch(c.id, was));
  };

  const report = (c) => {
    setReportedIds((s) => new Set(s).add(c.id));
    api.articleReportComment(c.id).catch(() => {});
  };

  const submit = (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true); setSendErr("");
    api.articleAddComment(slug, body)
      .then((r) => {
        setComments((cs) => [r.comment, ...cs]);
        setDraft("");
        if (r.awarded) setAwardToast(r.awarded_points || 5);
        threadTopRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      })
      .catch((e2) => setSendErr(e2?.message || "Could not post — try again."))
      .finally(() => setSending(false));
  };

  if (err) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center">
        <p className="text-[14px] text-muted-foreground mb-6">{err}</p>
        <button onClick={onBack} className="text-[13px] font-medium text-primary-ink underline underline-offset-2">Back</button>
      </div>
    );
  }
  if (!article) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 py-6" aria-busy="true">
        <div className="h-64 rounded bg-secondary animate-pulse" />
        <div className="h-6 w-2/3 rounded bg-secondary animate-pulse" />
        <div className="h-4 w-full rounded bg-secondary animate-pulse" />
      </div>
    );
  }

  return (
    <article className="max-w-2xl mx-auto" data-testid="campaign-article">
      <button
        onClick={onBack}
        data-testid="article-back"
        className="inline-flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground mb-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ChevronLeft size={15} /> Back
      </button>

      {article.cover_image && (
        <div className="relative aspect-[4/5] sm:aspect-[16/10] rounded overflow-hidden bg-secondary mb-6">
          <img src={article.cover_image} alt="" className="absolute inset-0 w-full h-full object-cover object-[center_20%]" draggable={false} />
        </div>
      )}
      {article.tag && (
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-primary-ink mb-2">{article.tag}</div>
      )}
      <h1 className="font-serif text-3xl sm:text-4xl leading-tight text-foreground mb-3">{article.title}</h1>
      {(article.subject || article.byline || article.published_at) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground mb-5">
          {article.subject && <span>{article.article_type === "spotlight" ? `In the spotlight: ${article.subject}` : article.subject}</span>}
          {article.byline && <span>{article.byline}</span>}
          {articleDate(article.published_at) && <span>{articleDate(article.published_at)}</span>}
        </div>
      )}
      {article.subheading && (
        <p className="text-[15px] text-muted-foreground leading-relaxed mb-6">{article.subheading}</p>
      )}
      <div className="space-y-4 mb-12">
        {(article.body || []).map((p, i) => (
          <p key={i} className="text-[15px] text-foreground/90 leading-relaxed">{p}</p>
        ))}
      </div>
      {Array.isArray(article.gallery) && article.gallery.length > 0 && (
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12" aria-label="Looks from this story">
          {article.gallery.map((image, index) => (
            <figure key={`${image.image}-${index}`} className={index === 0 ? "sm:col-span-2" : ""}>
              <div className={`relative overflow-hidden rounded bg-secondary ${index === 0 ? "aspect-[16/9]" : "aspect-[4/5]"}`}>
                <img
                  src={image.image}
                  alt={image.alt || "Vivo style moment"}
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />
              </div>
              {image.caption && <figcaption className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{image.caption}</figcaption>}
            </figure>
          ))}
        </section>
      )}

      {/* ---- The conversation ---- */}
      <section className="border-t border-border pt-8" data-testid="article-comments">
        <h2 className="font-serif text-xl text-foreground mb-1">The conversation</h2>
        <p className="text-[13px] text-muted-foreground mb-6">
          {comments.length > 0
            ? `${comments.length} ${comments.length === 1 ? "voice" : "voices"} so far — add yours.`
            : "No comments yet — be the first voice."}
        </p>

        {awardToast > 0 && (
          <div data-testid="article-award-toast" className="flex items-center gap-2 rounded bg-secondary px-4 py-3 mb-5 text-[13px] text-foreground">
            <Sparkles size={15} className="text-primary-ink shrink-0" />
            +{awardToast} points for joining the conversation — asante!
          </div>
        )}

        {member ? (
          <form onSubmit={submit} className="flex gap-3 items-start mb-8">
            <Avatar initials={(member.initials || member.full_name || member.username || "?").slice(0, 2).toUpperCase()} />
            <div className="flex-1">
              <div className="flex gap-2">
                <input
                  data-testid="article-comment-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={500}
                  placeholder="What does this season mean to you?"
                  className="flex-1 h-11 px-4 rounded border border-border bg-background text-[14px] focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  type="submit"
                  data-testid="article-comment-send"
                  disabled={!draft.trim() || sending}
                  aria-label="Post comment"
                  className="h-11 w-11 shrink-0 rounded bg-foreground text-background flex items-center justify-center disabled:opacity-40 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Send size={16} />
                </button>
              </div>
              {sendErr && <p className="text-[12px] text-destructive mt-2">{sendErr}</p>}
            </div>
          </form>
        ) : (
          <div className="rounded bg-secondary px-5 py-4 mb-8 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <p className="text-[13px] text-foreground">Sign in to join the conversation — comments are tied to your Vivo account.</p>
            <button
              data-testid="article-signin-cta"
              onClick={onJoin}
              className="shrink-0 h-10 px-6 rounded bg-primary text-primary-foreground font-medium text-[13px] hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Sign in
            </button>
          </div>
        )}

        <div ref={threadTopRef} />
        <div className="space-y-6">
          {comments.map((c) => (
            <CommentRow key={c.id} c={c} member={member} onLike={toggleLike} onReport={report} reported={reportedIds.has(c.id)} />
          ))}
        </div>
      </section>
    </article>
  );
}
