import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X, ChevronLeft, ChevronRight, Heart, MessageCircle, Send, Flag, Trophy, Clock,
  Vote as VoteIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { Avatar, TierBadge } from "./ui";
import { PostVisual, timeAgo } from "./PostBits";

/* Full post view — lightbox on desktop, full-screen sheet on mobile.
   Opens from any feed card (Community feed grid + Home feed). The feed
   list stays mounted behind the portal overlay, so closing naturally
   returns to the same scroll position.

   Likes and comments are real per-member state; comments publish
   immediately and every comment carries a discreet Report action.
   Deliberately NO points for likes or comments (anti-spam) — so this
   modal never shows a points chip. */

function CommentRow({ c, onLike, onReport, reported }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex gap-3 items-start" data-testid={`comment-${c.id}`}>
      <Avatar initials={c.initials} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-foreground">@{c.username}</span>
          <span className="text-[11px] text-muted-foreground">{timeAgo(c.created_at)}</span>
        </div>
        <p className="text-[14px] text-foreground/90 leading-relaxed break-words whitespace-pre-wrap">{c.body}</p>
        <div className="flex items-center gap-4 mt-1 min-h-[24px]">
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
          {reported ? (
            <span className="text-[11px] text-muted-foreground italic">
              Thank you — our team will take a look.
            </span>
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
          )}
        </div>
      </div>
    </div>
  );
}

export default function PostDetailModal({
  posts, index, onIndex, onClose, onOpenProduct, onCounts, restoreY, voteCtl,
}) {
  const post = posts?.[index];
  const panelRef = useRef(null);
  const threadRef = useRef(null);
  const touchRef = useRef(null);
  const dragRef = useRef(null);
  const seqRef = useRef(0);

  const [comments, setComments] = useState(null); // null = loading
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [reportedIds, setReportedIds] = useState(() => new Set());
  const [likeBump, setLikeBump] = useState(0);

  const hasPrev = index > 0;
  const hasNext = index < (posts?.length || 0) - 1;

  /* Modal manners (same as the shop filter sheet): lock and later restore
     body scroll, move focus in, trap Tab, hand focus back on close. */
  /* Mount-only scroll lock. useLayoutEffect: on mobile the browser clamps
     window scroll to 0 as soon as the full-screen portal commits — BEFORE a
     passive effect runs — so scrollY must be captured synchronously and the
     body held with the position-fixed lock (the canonical mobile-safe
     scroll lock). Everything is restored on close. */
  useLayoutEffect(() => {
    const prevFocus = document.activeElement;
    // Parents capture scrollY in the tap handler itself (restoreY) —
    // on mobile the browser can zero window scroll before ANY modal
    // code (even a layout effect) gets to observe it.
    const y = typeof restoreY === "number" ? restoreY : window.scrollY;
    const b = document.body.style;
    const prev = { position: b.position, top: b.top, left: b.left,
                   right: b.right, width: b.width, overflow: b.overflow };
    b.position = "fixed"; b.top = `-${y}px`; b.left = "0"; b.right = "0";
    b.width = "100%"; b.overflow = "hidden";
    const t = setTimeout(() => { panelRef.current?.focus?.({ preventScroll: true }); }, 0);
    return () => {
      clearTimeout(t);
      b.position = prev.position; b.top = prev.top; b.left = prev.left;
      b.right = prev.right; b.width = prev.width; b.overflow = prev.overflow;
      prevFocus?.focus?.({ preventScroll: true });
      window.scrollTo(0, y);
      // The browser can adjust scroll on the frame AFTER the portal
      // unmounts (scroll anchoring / layout settle) — re-assert once.
      requestAnimationFrame(() => window.scrollTo(0, y));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Keyboard handling tracks the live index/handlers. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
      if (!typing && e.key === "ArrowLeft") { e.preventDefault(); if (index > 0) onIndex(index - 1); }
      if (!typing && e.key === "ArrowRight") { e.preventDefault(); if (index < posts.length - 1) onIndex(index + 1); }
      if (e.key === "Tab" && panelRef.current) {
        const els = panelRef.current.querySelectorAll(
          'button, input, [href], [tabindex]:not([tabindex="-1"])'
        );
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!panelRef.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onIndex, index, posts?.length]);

  /* Comments load per post; a sequence guard drops stale responses when
     she pages through posts faster than the network answers. */
  useEffect(() => {
    if (!post?.id) return;
    const seq = ++seqRef.current;
    setComments(null);
    setSendError("");
    api.postComments(post.id)
      .then((d) => {
        if (seqRef.current !== seq) return;
        const items = d.items || [];
        setComments(items);
        // The thread endpoint returns every visible comment, so its length
        // is the truth — reconcile the card count (heals staleness after a
        // staff removal in the CRM).
        onCounts?.(post.id, { comment_count: items.length });
      })
      .catch(() => { if (seqRef.current === seq) setComments([]); });
  }, [post?.id]);

  if (!post) return null;

  const patchPost = (patch) => onCounts?.(post.id, patch);

  const toggleLike = () => {
    const wasLiked = post.my_liked;
    const wasCount = post.like_count;
    patchPost({ my_liked: !wasLiked, like_count: wasCount + (wasLiked ? -1 : 1) });
    if (!wasLiked) setLikeBump((b) => b + 1);
    api.likePost(post.id)
      .then((r) => patchPost({ my_liked: r.liked, like_count: r.like_count }))
      .catch(() => patchPost({ my_liked: wasLiked, like_count: wasCount }));
  };

  const toggleCommentLike = (c) => {
    setComments((list) => (list || []).map((x) => x.id === c.id
      ? { ...x, my_liked: !x.my_liked, like_count: x.like_count + (x.my_liked ? -1 : 1) }
      : x));
    api.likeComment(c.id)
      .then((r) => setComments((list) => (list || []).map((x) => x.id === c.id
        ? { ...x, my_liked: r.liked, like_count: r.like_count }
        : x)))
      .catch(() => setComments((list) => (list || []).map((x) => x.id === c.id
        ? { ...x, my_liked: c.my_liked, like_count: c.like_count }
        : x)));
  };

  const reportComment = (c) => {
    setReportedIds((s) => new Set(s).add(c.id));
    api.reportComment(c.id).catch(() => {});
  };

  const submitComment = (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError("");
    const pidAtSend = post.id;
    const seqAtSend = seqRef.current;
    api.addComment(pidAtSend, body)
      .then((r) => {
        onCounts?.(pidAtSend, { comment_count: r.comment_count });
        setDraft("");
        if (seqRef.current !== seqAtSend) return; // she moved on; server has it
        seqRef.current += 1; // invalidate any in-flight thread fetch
        setComments((list) => [...(list || []), r.comment]);
        setTimeout(() => {
          threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight, behavior: "smooth" });
        }, 50);
      })
      .catch((err) => setSendError(err?.message || "Couldn't post that — try again."))
      .finally(() => setSending(false));
  };

  const onTouchStart = (e) => {
    const t = e.touches?.[0];
    if (t) touchRef.current = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY };
  };
  const onTouchMove = (e) => {
    const t = e.touches?.[0];
    if (t && touchRef.current) { touchRef.current.lx = t.clientX; touchRef.current.ly = t.clientY; }
  };
  const onTouchEnd = (e) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const t = e.changedTouches?.[0];
    const dx = (t ? t.clientX : start.lx) - start.x;
    const dy = (t ? t.clientY : start.ly) - start.y;
    if (Math.abs(dx) > 64 && Math.abs(dx) > 2 * Math.abs(dy)) {
      if (dx > 0 && hasPrev) onIndex(index - 1);
      else if (dx < 0 && hasNext) onIndex(index + 1);
    }
  };
  const onPointerDown = (e) => {
    if (e.pointerType !== "touch") dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e) => {
    const s = dragRef.current;
    dragRef.current = null;
    if (!s || e.pointerType === "touch") return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 64 && Math.abs(dx) > 2 * Math.abs(dy)) {
      if (dx > 0 && hasPrev) onIndex(index - 1);
      else if (dx < 0 && hasNext) onIndex(index + 1);
    }
  };

  const isQuote = post.variant === "quote";
  const shopTag = (t) => { onClose(); onOpenProduct?.(t.sku); };

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true"
         aria-label={`Post by @${post.author.username}`} data-testid="post-detail">
      <div className="absolute inset-0 bg-foreground/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      {/* Desktop prev/next — outside the panel, vertically centred */}
      {hasPrev && (
        <button type="button" onClick={() => onIndex(index - 1)} aria-label="Previous post"
                data-testid="post-prev"
                className="hidden sm:flex absolute left-3 lg:left-6 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-background/90 border border-border shadow-md items-center justify-center text-foreground hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <ChevronLeft size={22} strokeWidth={1.5} />
        </button>
      )}
      {hasNext && (
        <button type="button" onClick={() => onIndex(index + 1)} aria-label="Next post"
                data-testid="post-next"
                className="hidden sm:flex absolute right-3 lg:right-6 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-background/90 border border-border shadow-md items-center justify-center text-foreground hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <ChevronRight size={22} strokeWidth={1.5} />
        </button>
      )}

      <div className="absolute inset-0 flex items-stretch sm:items-center justify-center sm:p-8"
           onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          ref={panelRef}
          tabIndex={-1}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          className={`relative w-full h-full sm:h-auto sm:max-h-[88vh] [touch-action:pan-y] bg-background sm:rounded sm:border sm:border-border sm:shadow-2xl outline-none overflow-y-auto sm:overflow-hidden flex flex-col ${
            isQuote ? "sm:max-w-xl" : "sm:max-w-4xl sm:flex-row"
          } animate-in fade-in sm:zoom-in-95 duration-200`}
        >
          <button type="button" onClick={onClose} aria-label="Close post" data-testid="post-close"
                  className="absolute top-3 right-3 z-20 w-10 h-10 rounded-full bg-background/85 backdrop-blur-sm border border-border flex items-center justify-center text-foreground hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <X size={18} strokeWidth={1.5} />
          </button>

          {/* Visual pane — full, uncropped */}
          {!isQuote && (
            <div onPointerDown={onPointerDown} onPointerUp={onPointerUp}
                 className="sm:w-[52%] sm:shrink-0 bg-secondary/50 flex items-center justify-center sm:p-6 select-none [touch-action:pan-y]">
              <div className="w-full">
                <PostVisual post={post} className="mb-0 w-full" />
              </div>
            </div>
          )}

          {/* Content pane */}
          <div className="flex-1 flex flex-col sm:min-h-0">
            <div className="p-5 sm:p-6 pb-0 sm:pb-0">
              <div className="flex items-center gap-3 pr-10">
                <Avatar initials={post.author.initials} tier={post.author.show_tier ? post.author.tier : undefined} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground text-[15px] truncate">@{post.author.username}</span>
                    {post.author.show_tier && <TierBadge tier={post.author.tier} />}
                  </div>
                  <span className="text-xs text-muted-foreground">{timeAgo(post.created_at)}</span>
                </div>
              </div>

              {post.entry_status === "pending" && (
                <div className="mt-4 flex items-start gap-2.5 bg-amber-50 border border-amber-200 text-amber-900 rounded p-3 text-[13px] leading-relaxed"
                     data-testid="own-pending-banner">
                  <Clock size={15} className="mt-0.5 shrink-0" strokeWidth={1.5} />
                  <span>In review — only you can see this right now. We'll pop it into the feed once our team has had a look.</span>
                </div>
              )}

              {post.winner_position >= 1 && (
                <div className="mt-4 inline-flex items-center gap-1.5 bg-gradient-to-r from-amber-100 to-yellow-50 border border-amber-200 text-amber-900 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                     data-testid="winner-ribbon">
                  <Trophy size={13} strokeWidth={1.5} />
                  Challenge winner{["1st", "2nd", "3rd"][post.winner_position - 1] ? ` · ${["1st", "2nd", "3rd"][post.winner_position - 1]} place` : ""}
                </div>
              )}

              {isQuote ? (
                <blockquote className="font-serif text-xl sm:text-2xl italic leading-snug text-foreground/90 border-l-2 border-primary pl-5 py-1.5 mt-5">
                  "{post.caption}"
                </blockquote>
              ) : (
                <p className="text-foreground/90 text-[15px] leading-relaxed mt-4">{post.caption}</p>
              )}

              {post.tagged?.length > 0 && (
                <div className="mt-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Shop this look</div>
                  <div className="flex flex-wrap gap-2">
                    {post.tagged.map((t) => (
                      <button key={t.sku} type="button" onClick={() => shopTag(t)}
                              data-testid={`shop-tag-${t.sku}`}
                              className="bg-secondary border border-border text-foreground text-xs font-medium px-3 min-h-[36px] rounded-full hover:bg-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {post.fit_note?.fit && (
                <p className="mt-3.5 text-[12.5px] text-muted-foreground" data-testid="fit-note">
                  <span className="font-semibold text-foreground/80">Fit:</span>{" "}
                  {{ small: "runs small", true: "true to size", large: "runs large" }[post.fit_note.fit] || post.fit_note.fit}
                  {post.fit_note.size ? ` · wears ${post.fit_note.size}` : ""}
                </p>
              )}

              <div className="flex items-center gap-6 py-4 mt-4 border-t border-border">
                <button type="button" onClick={toggleLike} data-testid="detail-like-btn"
                        aria-label={post.my_liked ? "Unlike this post" : "Like this post"}
                        aria-pressed={!!post.my_liked}
                        className={`flex items-center gap-1.5 min-h-[44px] rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          post.my_liked ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"
                        }`}>
                  <span key={likeBump} className={likeBump ? "inline-flex animate-in zoom-in-50 duration-300" : "inline-flex"}>
                    <Heart size={20} className={post.my_liked ? "fill-primary text-primary-ink" : ""} strokeWidth={1.5} />
                  </span>
                  <span className="text-sm" data-testid="detail-like-count">{post.like_count}</span>
                </button>
                <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                  <MessageCircle size={20} strokeWidth={1.5} />
                  <span className="text-sm" data-testid="detail-comment-count">{post.comment_count}</span>
                </span>
                {/* One vote per member, changeable anytime; tallies stay
                    private — the button only ever shows YOUR state. */}
                {voteCtl?.enabled && post.entry_status !== "pending" && (
                  <button
                    type="button"
                    data-testid="detail-vote-btn"
                    onClick={() => voteCtl.onVote?.(post)}
                    aria-pressed={voteCtl.myVote === post.id}
                    className={`ml-auto flex items-center gap-1.5 min-h-[44px] px-3.5 rounded font-medium text-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      voteCtl.myVote === post.id
                        ? "bg-primary/10 border-primary/30 text-primary-ink"
                        : "bg-background border-border text-foreground hover:bg-secondary"
                    }`}
                  >
                    <VoteIcon size={16} strokeWidth={1.5} />
                    {voteCtl.myVote === post.id ? "Your vote" : "Vote for this look"}
                  </button>
                )}
              </div>
            </div>

            {/* Comments thread */}
            <div ref={threadRef} data-testid="comments-thread"
                 className="flex-1 sm:overflow-y-auto px-5 sm:px-6 py-4 space-y-4 sm:min-h-[120px] border-t border-border">
              {comments === null ? (
                <div className="space-y-3" aria-hidden="true">
                  {[0, 1].map((i) => (
                    <div key={i} className="flex gap-3 items-start animate-pulse">
                      <div className="w-9 h-9 rounded-full bg-secondary" />
                      <div className="flex-1 space-y-2 pt-1">
                        <div className="h-2.5 bg-secondary rounded w-24" />
                        <div className="h-2.5 bg-secondary rounded w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : comments.length === 0 ? (
                <p data-testid="comments-empty" className="font-serif italic text-muted-foreground text-[15px] py-2">
                  Be the first to say something lovely.
                </p>
              ) : (
                comments.map((c) => (
                  <CommentRow key={c.id} c={c}
                              onLike={toggleCommentLike}
                              onReport={reportComment}
                              reported={reportedIds.has(c.id)} />
                ))
              )}
            </div>

            {/* Composer — comments publish immediately; no points, ever */}
            <form onSubmit={submitComment}
                  className="flex items-center gap-2 border-t border-border p-3 sm:p-4 bg-background sticky bottom-0 sm:static">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add your voice…"
                maxLength={500}
                aria-label="Add a comment"
                data-testid="comment-input"
                className="flex-1 h-11 px-3.5 rounded-sm border border-border bg-background text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <button type="submit" disabled={!draft.trim() || sending}
                      aria-label="Send comment" data-testid="comment-send"
                      className="h-11 w-11 shrink-0 rounded-sm bg-foreground text-background flex items-center justify-center hover:opacity-90 transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
                <Send size={17} strokeWidth={1.5} />
              </button>
            </form>
            {sendError && (
              <p className="text-[12px] text-destructive px-4 pb-3 -mt-1" role="alert">{sendError}</p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
