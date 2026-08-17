import React, { useEffect, useMemo, useState } from 'react';
import { Heart, MessageCircle, Share, ArrowRight, ChevronRight, Cake, Gift, Ruler, Layers, X, Sparkles, ClipboardList, Trophy, HandHeart } from "lucide-react";
import { styleBoards, fitFor } from "./mockData";
import PostDetailModal from "./PostDetailModal";
import { PostVisual, timeAgo } from "./PostBits";
import { TierBadge, Avatar, cardCls, brandAsset, SectionHeader } from "./ui";
import { api } from "@/lib/api";
import { NEWS, newsPageId } from "./newsData";
import ReelsRow from "./ReelsRow";
import NewsSection, { NewsCardCompact } from "./NewsSection";
import { FabulasHomeCard } from "./FabulasStory";
import { fabulasOfTheDay } from "./fabulasStories";

const initialsOf = (u) =>
  (u || "?").split(/[._\s-]+/).filter(Boolean).slice(0, 2)
    .map((x) => x[0].toUpperCase()).join("") || "?";

/* Post visual — placeholder art in two tones so a photo-less demo feed still
   has rhythm. Aspect ratio comes from the post's layout variant. */
function PostCard({ post, onShopTap, onOpenProduct, onOpen, onCounts }) {
  const [likeBump, setLikeBump] = useState(0);
  if (!post) return null;

  /* Liked state lives on the shared feed list (via onCounts) so the card
     and the detail modal stay in sync. Optimistic flip, server truth on
     answer, revert on error. Deliberately NO points for likes. */
  const toggleLike = () => {
    const wasLiked = post.my_liked;
    const wasCount = post.like_count;
    onCounts?.(post.id, { my_liked: !wasLiked, like_count: wasCount + (wasLiked ? -1 : 1) });
    if (!wasLiked) setLikeBump((b) => b + 1);
    api.likePost(post.id)
      .then((r) => onCounts?.(post.id, { my_liked: r.liked, like_count: r.like_count }))
      .catch(() => onCounts?.(post.id, { my_liked: wasLiked, like_count: wasCount }));
  };
  const open = () => onOpen?.(post);
  const onOpenKey = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  };

  return (
    <div className={`${cardCls} p-5 transition-transform hover:-translate-y-0.5 duration-300`} data-testid={`post-card-${post.id}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {/* Privacy: public surfaces show username only; tier appears only if opted in */}
          <Avatar initials={post.author.initials} tier={post.author.show_tier ? post.author.tier : undefined} />
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-semibold text-foreground text-[15px]">@{post.author.username}</span>
              {post.author.show_tier && <TierBadge tier={post.author.tier} />}
            </div>
            <span className="text-xs text-muted-foreground">{timeAgo(post.created_at)}</span>
          </div>
        </div>
      </div>

      {post.variant === "quote" ? (
        <blockquote role="button" tabIndex={0} onClick={open} onKeyDown={onOpenKey}
                    onPointerDown={(e) => e.preventDefault()}
                    aria-label="Open post"
                    className="font-serif text-xl sm:text-2xl italic leading-snug text-foreground/90 border-l-2 border-primary pl-5 py-1.5 mb-5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
          "{post.caption}"
        </blockquote>
      ) : (
        <div role="button" tabIndex={0} onClick={open} onKeyDown={onOpenKey}
             onPointerDown={(e) => e.preventDefault()}
             aria-label="Open post"
             className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          <PostVisual post={post} />
          <p className="text-foreground/90 text-[15px] leading-relaxed mb-4">
            {post.caption}
          </p>
        </div>
      )}

      {post.tagged?.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {post.tagged.map(t => (
            <button
              key={t.sku}
              onClick={() => (onOpenProduct ? onOpenProduct(t.sku) : onShopTap?.())}
              className="bg-secondary border border-border text-foreground text-xs font-medium px-3 min-h-[36px] rounded-full hover:bg-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-6 pt-4 border-t border-border">
        <button type="button" onClick={toggleLike} data-testid="like-btn"
                aria-label={post.my_liked ? "Unlike this post" : "Like this post"}
                aria-pressed={!!post.my_liked}
                className={`flex items-center gap-1.5 min-h-[44px] rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${post.my_liked ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"}`}>
          <span key={likeBump} className={likeBump ? "inline-flex animate-in zoom-in-50 duration-300" : "inline-flex"}>
            <Heart size={20} className={post.my_liked ? "fill-primary text-primary-ink" : ""} strokeWidth={1.5} />
          </span>
          <span className="text-sm">{post.like_count}</span>
        </button>
        <button type="button" onClick={open} aria-label="View comments"
                className="flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          <MessageCircle size={20} strokeWidth={1.5} />
          <span className="text-sm">{post.comment_count}</span>
        </button>
        <button className="flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground transition-colors ml-auto">
          <Share size={20} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

/* One-shot celebration moments — never more than one per event, in the
   Johari voice: the sign-up karibu (flag set by AuthFlow) or a tier-up
   vigelegele. Last-seen tier lives in localStorage so the cheer fires
   exactly once, in the session that crossed the threshold. */
const TIER_RANK = {
  Tsavorite: 0, Ruby: 1, Tanzanite: 2,
  // Legacy pre-gem-rename names can linger in johari_tier_seen — rank them
  // like their successors so the rename itself never fires a false vigelegele.
  Pearl: 0, Diamond: 2,
};
function CelebrationCard({ member }) {
  const [moment, setMoment] = useState(null); // null | {kind:"welcome"} | {kind:"tier", tier}
  useEffect(() => {
    const tier = member?.tier;
    if (!tier) return;
    let welcome = false;
    try {
      welcome = sessionStorage.getItem("johari_welcome") === "1";
      if (welcome) sessionStorage.removeItem("johari_welcome");
    } catch { /* storage unavailable — skip the moment, never break Home */ }
    let prev = null;
    try {
      prev = localStorage.getItem("johari_tier_seen");
      localStorage.setItem("johari_tier_seen", tier);
    } catch { /* ditto */ }
    if (welcome) setMoment({ kind: "welcome" });
    else if (prev && prev !== tier && (TIER_RANK[tier] ?? 0) > (TIER_RANK[prev] ?? 0)) setMoment({ kind: "tier", tier });
  }, [member?.tier]);

  if (!moment) return null;
  const welcome = moment.kind === "welcome";
  return (
    <div data-testid="celebration-card" data-variant={welcome ? "welcome" : "tier-up"}
      className={`${cardCls} border-l-2 border-l-primary p-5 flex items-center gap-4`}>
      <div className="flex-grow min-w-0">
        <div className="font-serif text-lg text-foreground leading-snug">
          {welcome ? "Karibu Vivo Johari — we shine together." : `You're now ${moment.tier} ✦ — vigelegele!`}
        </div>
        <p className="text-[13px] text-muted-foreground mt-0.5">
          {welcome
            ? "We shine together. Your welcome points are already on your card."
            : "A new tier of rewards has opened up — see what your points reach now."}
        </p>
      </div>
      <button data-testid="celebration-dismiss" onClick={() => setMoment(null)} aria-label="Dismiss"
        className="w-9 h-9 shrink-0 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <X size={14} />
      </button>
    </div>
  );
}

/* Challenge-winner vigelegele — self-fetching; shows the member's newest
   un-celebrated win, once. The +200 bonus itself landed server-side when the
   team picked her — this card is purely the cheer. */
function WinnerCongratsCard() {
  const [win, setWin] = useState(null);
  useEffect(() => {
    let alive = true;
    api.myEntries().then((d) => {
      if (!alive) return;
      const w = (d.items || []).find((e) => {
        if ((e.winner_position || 0) < 1 || !e.challenge_title) return false;
        try { return localStorage.getItem(`johari_winner_seen_${e.post_id}`) !== "1"; }
        catch { return false; }
      });
      if (w) setWin(w);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!win) return null;
  const dismiss = () => {
    try { localStorage.setItem(`johari_winner_seen_${win.post_id}`, "1"); } catch { /* private mode */ }
    setWin(null);
  };
  const place = { 1: "took 1st place", 2: "took 2nd place", 3: "took 3rd place" }[win.winner_position] || "won";
  return (
    <div data-testid="winner-congrats" className={`${cardCls} border-l-2 border-l-primary p-5 flex items-center gap-4`}>
      <span className="w-11 h-11 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary-ink shrink-0">
        <Trophy size={18} strokeWidth={1.5} />
      </span>
      <div className="flex-grow min-w-0">
        <div className="font-serif text-lg text-foreground leading-snug">
          Vigelegele — your look {place} in {win.challenge_title}!
        </div>
        <p className="text-[13px] text-muted-foreground mt-0.5">Your 200-point winner's bonus is already on your card.</p>
      </div>
      <button data-testid="winner-congrats-dismiss" onClick={dismiss} aria-label="Dismiss"
              className="w-9 h-9 shrink-0 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <X size={14} />
      </button>
    </div>
  );
}

/* Give Your Vivo a Second Life — quiet, warm entry into the giving page. */
function SecondLifeCard({ onOpenPage }) {
  return (
    <div data-testid="home-secondlife-card" className={`${cardCls} p-5 sm:p-6 flex items-start gap-4`}>
      <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
        <HandHeart size={18} strokeWidth={1.5} />
      </span>
      <div className="flex-grow min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1">Give back</div>
        <h3 className="font-serif text-[17px] text-foreground leading-snug mb-1">Give your Vivo a second life</h3>
        <p className="text-[13px] text-muted-foreground leading-relaxed mb-3">
          Pieces you've outgrown can lift another woman up — bring them to any Vivo store.
        </p>
        <button data-testid="home-secondlife-cta" onClick={() => onOpenPage?.("givingback")}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">
          How it works <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

/* Personal touch slot — renders only when relevant to the signed-in member:
   birthday month first, otherwise progress to the next tier, otherwise
   nothing (the feed simply flows on). */
function PersonalCard({ member, onNavigate }) {
  const now = new Date();
  // Guests have no tier journey — the card is a member moment only.
  if (!member) return null;
  const dobMonth = member?.dob ? parseInt(String(member.dob).slice(5, 7), 10) : NaN;
  const birthday = !Number.isNaN(dobMonth) && dobMonth === now.getMonth() + 1;
  // Tier progress runs on lifetime earn — redeeming a reward never walks it backwards.
  const lifetime = member?.lifetime_points ?? member?.points ?? 0;
  const next = lifetime < 500 ? { tier: "Ruby", at: 500 } : lifetime < 1000 ? { tier: "Tanzanite", at: 1000 } : null;
  const firstName = String(member?.full_name || member?.name || "").trim().split(/\s+/)[0] || "";

  if (birthday) {
    const month = now.toLocaleString("en-KE", { month: "long" });
    return (
      <div data-testid="personal-card" data-variant="birthday" className={`${cardCls} border-l-2 border-l-primary p-5 flex items-center gap-4`}>
        <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
          <Cake size={18} strokeWidth={1.5} />
        </span>
        <div className="flex-grow min-w-0">
          <div className="font-serif text-lg text-foreground leading-snug">A very happy birthday month{firstName ? `, ${firstName}` : ""}.</div>
          <p className="text-[13px] text-muted-foreground mt-0.5">{month} deserves a standout look — come treat yourself.</p>
        </div>
        <button
          data-testid="personal-cta"
          onClick={() => onNavigate("shop")}
          aria-label="Browse the collection"
          className="w-11 h-11 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    );
  }

  if (next) {
    const pct = Math.min(100, Math.round((lifetime / next.at) * 100));
    return (
      <div data-testid="personal-card" data-variant="tier" className={`${cardCls} border-l-2 border-l-primary p-5`}>
        <div className="flex items-center gap-4">
          <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
            <Gift size={18} strokeWidth={1.5} />
          </span>
          <div className="flex-grow min-w-0">
            <div className="font-serif text-lg text-foreground leading-snug">
              {(next.at - lifetime).toLocaleString()} pts to {next.tier}{firstName ? `, ${firstName}` : ""}
            </div>
            <p className="text-[13px] text-muted-foreground mt-0.5">Points land when you share, review and shop.</p>
          </div>
          <button
            data-testid="personal-cta"
            onClick={() => onNavigate("rewards")}
            aria-label="See your rewards"
            className="w-11 h-11 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="mt-4 h-1 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  return null;
}

function MissionCard({ challenge, onNavigate }) {
  if (!challenge) return null;
  return (
    <div data-testid="mission-card" className={`${cardCls} p-5 sm:p-6 relative overflow-hidden`}>
      <div className="absolute top-0 right-0 w-36 h-36 bg-primary/5 rounded-full blur-2xl pointer-events-none" />
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <div className="flex-grow min-w-0">
          <div className="inline-block px-2 py-1 bg-primary-ink text-primary-foreground text-[10px] font-bold uppercase tracking-wider rounded-sm mb-3">
            This week's mission
          </div>
          <h3 className="font-serif text-xl text-foreground mb-1.5">Post a look, tell your story</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {challenge.title} is live — earn {challenge.points} pts when your entry is published.{challenge.entries_display ? ` ${challenge.entries_display} so far.` : ""}
          </p>
        </div>
        <button
          data-testid="mission-cta"
          onClick={() => onNavigate("community")}
          className="shrink-0 h-11 px-6 rounded bg-foreground text-background font-medium text-[14px] flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Enter now <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

/* Community fit-note highlight for a live piece — taps through to its PDP. */
function FitNoteHighlight({ product, onOpenProduct }) {
  if (!product) return null;
  const fit = fitFor(product.sku);
  const phrase =
    fit.verdict === "True to size" ? "runs true to size" :
    fit.verdict === "Runs small — size up" ? "runs small — most size up" :
    "runs generous";
  const c = fit.comments[0];
  return (
    <button
      data-testid="fit-highlight"
      onClick={() => onOpenProduct?.(product.sku)}
      className={`${cardCls} w-full text-left p-4 sm:p-5 flex items-center gap-4 hover:-translate-y-0.5 transition-transform group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="w-20 sm:w-24 shrink-0 aspect-[3/4] rounded bg-secondary overflow-hidden">
        <img src={product.image_url} alt="" loading="lazy" className="w-full h-full object-contain" />
      </div>
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">
          <Ruler size={11} /> Community fit notes
        </div>
        <div className="font-serif text-[17px] leading-snug text-foreground mb-1.5">
          Members say the {product.style_name} {phrase}
        </div>
        {c && (
          <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2">
            "{c.text}" — @{c.username}, size {c.size}
          </p>
        )}
      </div>
      <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
    </button>
  );
}

function BoardHighlight({ board, onNavigate }) {
  if (!board) return null;
  return (
    <button
      data-testid="board-highlight"
      onClick={() => onNavigate("community")}
      className={`${cardCls} w-full text-left p-5 flex items-center gap-5 hover:-translate-y-0.5 transition-transform group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="grid grid-cols-2 gap-1 w-20 shrink-0" aria-hidden="true">
        <div className="aspect-square rounded-sm bg-foreground" />
        <div className="aspect-square rounded-sm bg-secondary border border-border" />
        <div className="aspect-square rounded-sm bg-secondary border border-border" />
        <div className="aspect-square rounded-sm bg-primary" />
      </div>
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">
          <Layers size={11} /> Board we love
        </div>
        <div className="font-serif text-[17px] text-foreground">{board.title}</div>
        <div className="text-[12px] text-muted-foreground mt-0.5">{board.items} looks · {board.followers} following</div>
      </div>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors flex items-center gap-0.5 shrink-0">
        Explore <ChevronRight size={12} />
      </span>
    </button>
  );
}

/* A second member voice, distinct from the sidebar spotlight. */
function CommunityVoice() {
  return (
    <div data-testid="voice-card" className="bg-foreground text-background rounded p-6 sm:p-8 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-40 h-40 bg-white/5 rounded-full blur-3xl pointer-events-none" />
      <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mb-4">Community voices</div>
      <blockquote className="font-serif text-xl sm:text-2xl leading-snug italic mb-5">
        "I came for the dresses. I stayed for the women."
      </blockquote>
      <div className="flex items-center gap-3">
        <Avatar initials="AH" size="sm" />
        <span className="text-[13px] font-medium text-background/80">@amina_h</span>
      </div>
    </div>
  );
}

function EndCap({ onNavigate }) {
  return (
    <div data-testid="feed-endcap" className="text-center py-10 border-t border-border">
      <div className="font-serif text-xl text-foreground mb-1.5">You're all caught up</div>
      <p className="text-[13px] text-muted-foreground mb-6">New stories, reels and drops land every week.</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          data-testid="endcap-shop"
          onClick={() => onNavigate("shop")}
          className="h-11 px-6 rounded bg-foreground text-background text-[14px] font-medium hover:opacity-90 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Browse the collection
        </button>
        <button
          data-testid="endcap-community"
          onClick={() => onNavigate("community")}
          className="h-11 px-6 rounded border border-border bg-background text-foreground text-[14px] font-medium hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          This week's challenge
        </button>
      </div>
    </div>
  );
}

/* "What's on" — the soonest upcoming member event as one compact calendar
   card in the feed. Tapping it opens that event's detail page. */
function UpcomingEventCard({ ev, onOpen }) {
  if (!ev) return null;
  const mine = ev.my_rsvp?.status;
  const note =
    mine === "confirmed" ? "· You're in"
    : mine === "waitlisted" ? `· #${ev.my_rsvp.position} on waitlist`
    : ev.full ? "· Fully booked"
    : (ev.spots_left ?? 99) <= 8 ? `· ${ev.spots_left} spot${ev.spots_left === 1 ? "" : "s"} left`
    : null;
  return (
    <button
      data-testid="home-event-card"
      onClick={() => onOpen?.(ev.id)}
      className={`${cardCls} w-full text-left p-4 sm:p-5 flex items-center gap-4 sm:gap-5 transition-transform hover:-translate-y-0.5 duration-300 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <span className="w-16 h-16 sm:w-[72px] sm:h-[72px] rounded bg-foreground text-background flex flex-col items-center justify-center shrink-0">
        <span className="font-serif text-2xl sm:text-[28px] leading-none">{ev.day_num}</span>
        <span className="text-[9px] font-bold uppercase tracking-widest opacity-75 mt-1">{ev.month_abbr}</span>
      </span>
      <span className="flex-grow min-w-0">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest mb-1">
          <span className="text-primary-ink">What's on</span>
          {note && <span className="text-muted-foreground font-semibold">{note}</span>}
        </span>
        <span className="block font-serif text-[17px] leading-snug text-foreground truncate">{ev.title}</span>
        <span className="block text-[12px] text-muted-foreground mt-1 truncate">{ev.date_label} · {ev.time_label} · {ev.venue}</span>
      </span>
      <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
    </button>
  );
}

/* Virtual Try-On promo — prototype-evaluation prominence: a discoverable
   entry card high in the feed so reviewers find the feature immediately.
   Easy to demote/remove once the business decides its place (the allowance
   ladder itself is server config, not baked in here). */
function TryOnPromoCard({ onOpenPage }) {
  return (
    <div data-testid="home-tryon-card" className={`${cardCls} relative overflow-hidden p-6 sm:p-7 border-l-2 border-l-primary`}>
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/5 rounded-full blur-2xl translate-x-1/3 -translate-y-1/3 pointer-events-none" />
      <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-primary-ink text-primary-foreground text-[10px] font-bold uppercase tracking-wider rounded-sm mb-4">
        <Sparkles size={11} /> New
      </div>
      <h3 className="font-serif text-2xl text-foreground leading-tight mb-2">See it on you</h3>
      <p className="text-[13px] text-muted-foreground leading-relaxed max-w-md mb-5">
        Try Vivo pieces on virtually — pick a piece, add your photo, and see the look.
        A bit of fun, not a fitting room.
      </p>
      <button
        data-testid="home-tryon-cta"
        onClick={() => onOpenPage?.("tryon")}
        className="w-full sm:w-auto sm:px-8 bg-primary text-primary-foreground h-11 rounded font-medium text-[15px] flex items-center justify-center gap-2 hover:opacity-90 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <Sparkles size={15} /> Try it on
      </button>
    </div>
  );
}

/* Survey promo — wave-scoped "Help us dress you better" card. Self-fetching:
   renders only while the member hasn't completed the active wave AND the
   server says the Home card should show ("Maybe later" hides it, it
   re-surfaces once after a quiet few days, a second dismissal retires it —
   the Rewards mission and Profile entry points always remain). */
function SurveyPromoCard({ onOpenPage }) {
  const [s, setS] = useState(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    api.surveyState().then((d) => { if (alive) setS(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (hidden || !s?.wave || s.completed || !s.show_home_card) return null;
  const later = () => {
    setHidden(true); // gentle: card slips away now, the server remembers
    api.surveyDismiss(s.wave.id).catch(() => {});
  };
  return (
    <div data-testid="home-survey-card" className={`${cardCls} relative overflow-hidden p-6 sm:p-7 border-l-2 border-l-primary`}>
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/5 rounded-full blur-2xl translate-x-1/3 -translate-y-1/3 pointer-events-none" />
      <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-primary-ink text-primary-foreground text-[10px] font-bold uppercase tracking-wider rounded-sm mb-4">
        <ClipboardList size={11} /> +{s.points ?? 30} points
      </div>
      <h3 className="font-serif text-2xl text-foreground leading-tight mb-2">{s.wave.title}</h3>
      <p className="text-[13px] text-muted-foreground leading-relaxed max-w-md mb-5">
        Ten quick taps, under three minutes — tell us how Vivo fits your life
        and earn {s.points ?? 30} points, instantly. Private to Vivo, always.
      </p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <button
          data-testid="home-survey-cta"
          onClick={() => onOpenPage?.("survey")}
          className="w-full sm:w-auto sm:px-8 bg-primary text-primary-foreground h-11 rounded font-medium text-[15px] flex items-center justify-center gap-2 hover:opacity-90 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Take the survey <ArrowRight size={15} />
        </button>
        <button
          data-testid="home-survey-later"
          onClick={later}
          className="w-full sm:w-auto sm:px-5 h-11 rounded text-[13px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

/* ---------- Editorial homepage sections (image-led redesign) ---------- */

/* Category strip — horizontal pills with a fine brand-colour underline on
   the active one. Tapping any category leads into the Shop tab. */
const HOME_CATEGORIES = ["New In", "Workwear", "Dresses", "Tops", "Bottoms", "Denim", "Active", "Sale"];
function CategoryStrip({ onNavigate }) {
  const [active, setActive] = useState("New In");
  return (
    <nav aria-label="Shop categories" className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto hide-scrollbar">
      <div className="flex gap-6 border-b border-border min-w-max">
        {HOME_CATEGORIES.map((c) => (
          <button
            key={c}
            data-testid={`home-cat-${c.toLowerCase().replace(/\s+/g, "-")}`}
            onClick={() => { setActive(c); onNavigate("shop"); }}
            className={`relative pb-3 pt-1 text-[13px] whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm ${
              active === c ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground font-medium"
            }`}
          >
            {c}
            {active === c && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-primary" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </nav>
  );
}

/* Hero campaign — one strong vertical campaign photo, overlay only where the
   copy sits so faces and the garment stay untouched. */
function HeroCampaign({ onNavigate }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <section data-testid="home-hero" className="-mx-4 sm:mx-0 relative overflow-hidden sm:rounded bg-secondary">
      <div className="aspect-[4/5] sm:aspect-auto sm:h-[560px] relative">
        <img
          src={brandAsset("hero.jpg")}
          alt="Vivo new season campaign"
          ref={(el) => { if (el && el.complete) setLoaded(true); }}
          onLoad={() => setLoaded(true)}
          className="relative w-full h-full object-cover object-[center_20%]"
          draggable={false}
        />
        {/* Loading shimmer — sits on top only until the photo arrives (a
            static img paints below positioned siblings, so this must be
            strictly conditional or it washes the photo out). */}
        {!loaded && <div className="absolute inset-0 bg-secondary animate-pulse" aria-hidden="true" />}
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/20 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 p-6 sm:p-10 text-white">
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-white/80 mb-2">The new season edit</div>
          <h2 className="font-serif text-3xl sm:text-4xl leading-tight mb-2 text-white">Colour, out loud</h2>
          <p className="text-[14px] text-white/85 mb-5 max-w-sm">Bold prints and easy silhouettes — designed in Nairobi, worn everywhere.</p>
          <button
            data-testid="hero-shop-now"
            onClick={() => onNavigate("shop")}
            className="h-11 px-8 rounded bg-white text-neutral-900 font-medium text-[14px] hover:bg-white/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Shop Now
          </button>
        </div>
      </div>
    </section>
  );
}

/* RailCard/ProductRail and the Shop by Category grid moved to
   ShopSections.jsx — the grid, the personalised rail and the New This Week
   rail all live on the Shop tab now (per Sharon). */

/* Promotional banner — editable in one place: change HOME_PROMO to swap in
   delivery offers, sales, new collections or store openings. */
const HOME_PROMO = {
  kicker: "For a limited time",
  title: "Free delivery over KES 5,000",
  sub: "Nairobi, Kigali and Kampala — straight to your door.",
  cta: "Shop the collection",
  image: "promo.jpg",
};
function PromoBanner({ onNavigate }) {
  return (
    <section data-testid="home-promo-banner" className="-mx-4 sm:mx-0 relative overflow-hidden sm:rounded bg-foreground">
      <img
        src={brandAsset(HOME_PROMO.image)}
        alt=""
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover object-[center_30%] opacity-80"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/45 to-black/20 pointer-events-none" />
      <div className="relative p-6 sm:p-10 max-w-md text-white">
        <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/75 mb-2">{HOME_PROMO.kicker}</div>
        <h3 className="font-serif text-2xl sm:text-3xl leading-tight mb-1.5 text-white">{HOME_PROMO.title}</h3>
        <p className="text-[13px] text-white/85 mb-5">{HOME_PROMO.sub}</p>
        <button
          data-testid="home-promo-cta"
          onClick={() => onNavigate("shop")}
          className="h-10 px-6 rounded border border-white/80 text-white text-[13px] font-medium hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {HOME_PROMO.cta}
        </button>
      </div>
    </section>
  );
}

/* The Vivo Community — lifestyle imagery + Join the Conversation CTA. */
function CommunitySpotlight({ onNavigate }) {
  return (
    <section data-testid="home-community-spotlight" className="relative overflow-hidden rounded bg-secondary">
      <div className="grid sm:grid-cols-2">
        <div className="relative aspect-[4/5] sm:aspect-auto">
          <img
            src={brandAsset("community.jpg")}
            alt="Vivo members together"
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover object-top"
            draggable={false}
          />
        </div>
        <div className="p-6 sm:p-10 flex flex-col justify-center bg-card">
          <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-2">The Vivo Community</div>
          <h3 className="font-serif text-2xl sm:text-3xl leading-tight text-foreground mb-2">Real women. Real style. Yours to join.</h3>
          <p className="text-[14px] text-muted-foreground leading-relaxed mb-6">
            Style challenges, member events and conversations with women who dress like you do — we shine together.
          </p>
          <button
            data-testid="home-community-cta"
            onClick={() => onNavigate("community")}
            className="h-11 px-6 rounded bg-primary text-primary-foreground font-medium text-[14px] w-full sm:w-auto sm:self-start flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Join the Conversation <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}

/* Member Rewards summary — points, tier, next-tier progress, View Rewards. */
function RewardsSummaryCard({ member, onNavigate }) {
  if (!member) return null;
  const lifetime = member.lifetime_points ?? member.points ?? 0;
  const next = lifetime < 500 ? { tier: "Ruby", at: 500 } : lifetime < 1000 ? { tier: "Tanzanite", at: 1000 } : null;
  const pct = next ? Math.min(100, Math.round((lifetime / next.at) * 100)) : 100;
  return (
    <section data-testid="home-rewards-card" className={`${cardCls} p-6 sm:p-8`}>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">Member Rewards</div>
          <div className="font-serif text-3xl text-foreground leading-none">
            {(member.points ?? 0).toLocaleString()} <span className="text-base text-muted-foreground font-sans">pts</span>
          </div>
        </div>
        {member.tier && <TierBadge tier={member.tier} />}
      </div>
      <div className="mb-2 flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">
          {next ? `${(next.at - lifetime).toLocaleString()} pts to ${next.tier}` : "Top tier — Tanzanite ✦"}
        </span>
        <span className="text-muted-foreground tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden mb-6">
        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <button
        data-testid="home-rewards-cta"
        onClick={() => onNavigate("rewards")}
        className="h-11 w-full sm:w-auto sm:px-8 rounded bg-foreground text-background font-medium text-[14px] flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        View Rewards <ArrowRight size={15} />
      </button>
    </section>
  );
}

/* Vivo Stories — editorial covers over the news stories the app already
   carries; tapping opens the full article page. */
const STORY_COVERS = ["story-1.jpg", "story-2.jpg", "story-3.jpg"];
function VivoStories({ onOpenNews }) {
  const items = NEWS.slice(0, 3);
  if (!items.length) return null;
  return (
    <section data-testid="home-stories">
      <SectionHeader kicker="Vivo Stories" title="Styling, campaigns & what's on" />
      <div className="flex gap-3 overflow-x-auto hide-scrollbar snap-x -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 sm:grid sm:grid-cols-3 sm:overflow-visible">
        {items.map((n, i) => (
          <button
            key={n.id}
            data-testid={`home-story-${n.id}`}
            onClick={() => onOpenNews(n.id)}
            className="w-[240px] sm:w-auto shrink-0 snap-start text-left group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="relative aspect-[4/5] rounded overflow-hidden bg-secondary mb-3">
              <img
                src={brandAsset(STORY_COVERS[i % STORY_COVERS.length])}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.03]"
                draggable={false}
              />
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-primary-ink mb-1">{n.kicker}</div>
            <div className="font-serif text-[16px] leading-snug text-foreground group-hover:underline underline-offset-2 decoration-border line-clamp-2">{n.headline}</div>
            <div className="text-[11px] text-muted-foreground mt-1">{n.date}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function TabHome({ onNavigate, member, onOpenProduct, onOpenPage, onOpenEvent, onOpenFabulas }) {
  const [products, setProducts] = useState([]);
  const [events, setEvents] = useState([]);
  // Live challenges — the mission card and sidebar feature the first open one.
  const [liveChallenges, setLiveChallenges] = useState([]);
  // Celebrations feed the sidebar jewel (same rotation the wall shows).
  const [cel, setCel] = useState(null);
  const featuredChallenge = liveChallenges.find((c) => !c.closed) || null;

  // Live catalogue enriches the feed (Just Landed + fit-note highlight).
  // If the fetch fails these rows simply don't render — the Shop tab is
  // where catalogue errors surface loudly, the feed degrades gracefully.
  useEffect(() => {
    let alive = true;
    api.products({ limit: 12, offset: 0 })
      .then((d) => { if (alive) setProducts(d.items || []); })
      .catch(() => {});
    // Soonest upcoming event feeds the "What's on" card; same quiet-failure
    // rule — the Events sub-tab owns loading/error states.
    api.events()
      .then((d) => { if (alive) setEvents(d.items || []); })
      .catch(() => {});
    api.challenges()
      .then((d) => { if (alive) setLiveChallenges(d.items || []); })
      .catch(() => {});
    api.celebrations()
      .then((d) => { if (alive) setCel(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const nextEvent = events[0] || null;

  const fitPick = useMemo(() => {
    if (!products.length) return null;
    const byName = (s) => products.find((p) => (p.style_name || "").toLowerCase().includes(s));
    return byName("wrap") || byName("dress") || products[0];
  }, [products]);

  const openNews = (id) => onOpenPage?.(newsPageId(id));
  const shopTap = () => onNavigate("shop");
  // Interactive feed — same DB-backed list the Community tab shows.
  const [feed, setFeed] = useState([]);
  const [detailIdx, setDetailIdx] = useState(-1);
  const [restoreY, setRestoreY] = useState(0); // captured at tap time
  useEffect(() => {
    let on = true;
    api.feed(12).then((d) => { if (on) setFeed(d.items || []); }).catch(() => {});
    return () => { on = false; };
  }, []);
  const patchPost = (id, patch) =>
    setFeed((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const openPost = (post) => {
    setRestoreY(window.scrollY);
    const i = feed.findIndex((p) => p.id === post.id);
    if (i >= 0) setDetailIdx(i);
  };
  const P = feed;

  /* Editorial homepage order: category strip → hero campaign → personal
     moments → promo banner → Community → Member Rewards →
     Stories. Shop by Category and the Chosen-for-You rail live on the
     Shop tab now (per Sharon). */
  return (
    <div className="max-w-3xl mx-auto space-y-10 sm:space-y-14">
      <div className="space-y-6 -mt-2">
        <CategoryStrip onNavigate={onNavigate} />
        <HeroCampaign onNavigate={onNavigate} />
      </div>

      {/* Personal moments — celebration/tier/survey cards, member-only */}
      {member && (
        <div className="space-y-4 empty:hidden">
          <CelebrationCard member={member} />
          <WinnerCongratsCard />
          <PersonalCard member={member} onNavigate={onNavigate} />
          <SurveyPromoCard onOpenPage={onOpenPage} />
        </div>
      )}

      {member && <TryOnPromoCard onOpenPage={onOpenPage} />}

      <PromoBanner onNavigate={onNavigate} />

      {/* The Vivo Community — spotlight, live conversation, mission & events */}
      <div className="space-y-6">
        <CommunitySpotlight onNavigate={onNavigate} />
        <MissionCard challenge={featuredChallenge} onNavigate={onNavigate} />
        {/* Post cards + reels carry like/comment writes — members only.
            Guests still get the spotlight + CTA, which routes them to the
            sign-in fence on the Community tab. */}
        {member && (<>
          <PostCard post={P[0]} onShopTap={shopTap} onOpenProduct={onOpenProduct} onOpen={openPost} onCounts={patchPost} />
          <PostCard post={P[1]} onShopTap={shopTap} onOpenProduct={onOpenProduct} onOpen={openPost} onCounts={patchPost} />
          <ReelsRow member={member} />
          <PostCard post={P[2]} onShopTap={shopTap} onOpenProduct={onOpenProduct} onOpen={openPost} onCounts={patchPost} />
        </>)}
        <UpcomingEventCard ev={nextEvent} onOpen={onOpenEvent} />
        {cel?.jewel && (
          <div className={`${cardCls} p-6`}>
            <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-5">This Week's Jewel</h3>
            <div className="flex items-center gap-4 mb-4">
              {/* Tier shows only when the jewel opted in */}
              <Avatar initials={initialsOf(cel.jewel.username)} tier={cel.jewel.show_tier ? cel.jewel.tier : undefined} size="md" />
              <div>
                <div className="font-semibold text-foreground text-base mb-1">@{cel.jewel.username}</div>
                {cel.jewel.show_tier && cel.jewel.tier && <TierBadge tier={cel.jewel.tier} />}
              </div>
            </div>
            <blockquote className="italic text-foreground/80 text-sm border-l border-primary pl-4 py-1 leading-relaxed">
              "{cel.jewel.quote}"
            </blockquote>
          </div>
        )}
        <CommunityVoice />
      </div>

      <RewardsSummaryCard member={member} onNavigate={onNavigate} />

      {/* Vivo Stories — editorial covers, plus the deeper news & fit reads */}
      <div className="space-y-6">
        <VivoStories onOpenNews={openNews} />
        <FabulasHomeCard story={fabulasOfTheDay()} onOpenStory={onOpenFabulas} />
        <NewsSection onOpenNews={openNews} />
        <FitNoteHighlight product={fitPick} onOpenProduct={onOpenProduct} />
        <BoardHighlight board={styleBoards[3]} onNavigate={onNavigate} />
        <NewsCardCompact article={NEWS[3]} onOpen={openNews} />
        {member && (<>
          <PostCard post={P[3]} onShopTap={shopTap} onOpenProduct={onOpenProduct} onOpen={openPost} onCounts={patchPost} />
          <PostCard post={P[4]} onShopTap={shopTap} onOpenProduct={onOpenProduct} onOpen={openPost} onCounts={patchPost} />
        </>)}
        <SecondLifeCard onOpenPage={onOpenPage} />
      </div>

      {detailIdx >= 0 && P[detailIdx] && (
        <PostDetailModal restoreY={restoreY} posts={P} index={detailIdx} onIndex={setDetailIdx}
                         onClose={() => setDetailIdx(-1)} onOpenProduct={onOpenProduct}
                         onCounts={patchPost} />
      )}

      <EndCap onNavigate={onNavigate} />
    </div>
  );
}
