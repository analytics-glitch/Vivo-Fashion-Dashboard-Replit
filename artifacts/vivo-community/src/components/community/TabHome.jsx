import React, { useEffect, useMemo, useState } from 'react';
import { Heart, MessageCircle, Share, ArrowRight, ChevronRight, Cake, Gift, X, Trophy, HandHeart } from "lucide-react";
import PostDetailModal from "./PostDetailModal";
import { PostVisual, timeAgo } from "./PostBits";
import { TierBadge, Avatar, cardCls, brandAsset, SectionHeader } from "./ui";
import { api } from "@/lib/api";
import { StyledForYouHome } from "./StyledForYou";
import { NEWS, newsPageId } from "./newsData";
import ReelsRow from "./ReelsRow";
import WeeklyPlaylist from "./WeeklyPlaylist";

const initialsOf = (u) =>
  (u || "?").split(/[._\s-]+/).filter(Boolean).slice(0, 2)
    .map((x) => x[0].toUpperCase()).join("") || "?";

/* Post visual — placeholder art in two tones so a photo-less demo feed still
   has rhythm. Aspect ratio comes from the post's layout variant. */
/* Home renders post cards WITHOUT product tag pills — shopping entry points
   live in Shop / the post detail modal, never on the Home feed (rewire spec). */
function PostCard({ post, onOpen, onCounts }) {
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
          <p className="text-[13px] text-muted-foreground mt-0.5">The whole of {month} is yours — celebrate loudly, we're cheering with you.</p>
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

/* Community Spotlight — "This Week's Jewel" and "Community Voices" merged
   into ONE featured-member section (per Sharon's community-first brief).
   The jewel comes from the celebrations API; when no jewel is live we fall
   back to an evergreen member voice so the section never goes blank. */
function CommunitySpotlightCard({ jewel, onNavigate }) {
  const username = jewel?.username || "amina_h";
  const quote = jewel?.quote || "I came for the dresses. I stayed for the women.";
  const tier = jewel?.show_tier ? jewel?.tier : undefined;
  return (
    <section data-testid="home-spotlight-card" className="bg-foreground text-background rounded p-6 sm:p-10 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full blur-3xl pointer-events-none" />
      <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mb-5">Community Spotlight</div>
      <div className="flex items-center gap-4 mb-5">
        <Avatar initials={initialsOf(username)} tier={tier} size="md" />
        <div>
          <div className="font-semibold text-background text-base">@{username}</div>
          {tier && <div className="mt-1"><TierBadge tier={tier} /></div>}
        </div>
      </div>
      <blockquote className="font-serif text-xl sm:text-2xl leading-snug italic mb-6 max-w-xl">
        "{quote}"
      </blockquote>
      <button
        data-testid="spotlight-story-cta"
        onClick={() => onNavigate("community")}
        className="h-11 px-6 rounded border border-background/40 text-background text-[13px] font-medium hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
      >
        Read Her Story
      </button>
    </section>
  );
}

/* Shop Community Looks — a compact, community-led shoppable strip built from
   real member posts that tag Vivo pieces. Deliberately secondary. Now merged
   into the VivoEditsHome component but kept here for fallback rendering if needed. */
function ShopCommunityLooks({ posts, onOpenProduct, onNavigate }) {
  const looks = (posts || []).filter((p) => p?.tagged?.length && p.post_type !== "question").slice(0, 3);
  if (!looks.length) return null;
  return (
    <section data-testid="home-shop-looks" className="mt-12">
      <SectionHeader kicker="Shop Community Looks" title="Worn by the community" sub="Real members, real outfits — every piece is Vivo." />
      <div className="grid sm:grid-cols-3 gap-4">
        {looks.map((p) => (
          <div key={p.id} className={`${cardCls} p-4 flex flex-col`} data-testid={`shop-look-${p.id}`}>
            <div className="flex items-center gap-2.5 mb-3">
              <Avatar initials={p.author.initials} size="sm" />
              <span className="text-[13px] font-semibold text-foreground truncate">@{p.author.username}</span>
            </div>
            <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2 mb-4 flex-grow">{p.caption}</p>
            <button
              data-testid={`shop-look-cta-${p.id}`}
              onClick={() => (p.tagged?.[0]?.sku ? onOpenProduct?.(p.tagged[0].sku) : onNavigate("shop"))}
              className="h-10 rounded border border-border text-foreground text-[13px] font-medium hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Shop the Look
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function EndCap({ onNavigate }) {
  return (
    <div data-testid="feed-endcap" className="text-center py-10 border-t border-border">
      <div className="font-serif text-xl text-foreground mb-1.5">You're all caught up</div>
      <p className="text-[13px] text-muted-foreground mb-6">New stories, reels and drops land every week.</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          data-testid="endcap-community"
          onClick={() => onNavigate("community")}
          className="h-11 px-6 rounded bg-foreground text-background text-[14px] font-medium hover:opacity-90 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          This week's challenge
        </button>
      </div>
      {/* Plain nav bridge to Shop — deliberately quiet, no collection imagery */}
      <button
        data-testid="endcap-shop"
        onClick={() => onNavigate("shop")}
        className="mt-4 text-[13px] font-medium text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Go to Shop →
      </button>
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

/* "See it on you" (Virtual Try-On promo) moved to the Shop tab banner and
   individual product pages per the community-first homepage brief. */

/* ---------- Editorial homepage sections (image-led redesign) ---------- */

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
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-white/80 mb-2">This season's conversation</div>
          <h2 className="font-serif text-3xl sm:text-4xl leading-tight mb-2 text-white">Colour, out loud</h2>
          <p className="text-[14px] text-white/85 mb-5 max-w-sm">Bold prints, easy silhouettes and the women wearing them — designed in Nairobi, worn everywhere.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              data-testid="hero-join-cta"
              onClick={() => onNavigate("community")}
              className="h-11 px-8 rounded bg-white text-neutral-900 font-medium text-[14px] hover:bg-white/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Join the Conversation
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* RailCard/ProductRail and the Shop by Category grid moved to
   ShopSections.jsx — the grid, the personalised rail and the New This Week
   rail all live on the Shop tab now (per Sharon). */

/* The delivery/sale promo banner moved to the Shop tab (PromoBanner in
   TabShop.jsx) per the community-first homepage brief. */

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

/* Member Rewards summary — a slim horizontal progress banner. */
function RewardsSummaryCard({ member, onNavigate }) {
  if (!member) return null;
  const lifetime = member.lifetime_points ?? member.points ?? 0;
  const next = lifetime < 500 ? { tier: "Ruby", at: 500 } : lifetime < 1000 ? { tier: "Tanzanite", at: 1000 } : null;
  const pct = next ? Math.min(100, Math.round((lifetime / next.at) * 100)) : 100;
  return (
    <section data-testid="home-rewards-card" className={`${cardCls} p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4`}>
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-3 mb-2">
          <div className="font-serif text-2xl text-foreground leading-none">
            {(member.points ?? 0).toLocaleString()} <span className="text-sm text-muted-foreground font-sans">pts</span>
          </div>
          {member.tier && <TierBadge tier={member.tier} />}
        </div>
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="text-muted-foreground truncate">
            {next ? `${(next.at - lifetime).toLocaleString()} pts to ${next.tier}` : "Top tier — Tanzanite ✦"}
          </span>
          <span className="text-muted-foreground tabular-nums ml-2">{pct}%</span>
        </div>
        <div className="h-1 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <button
        data-testid="home-rewards-cta"
        onClick={() => onNavigate("rewards")}
        className="shrink-0 h-10 w-full sm:w-auto px-6 rounded bg-foreground text-background font-medium text-[13px] hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        View Rewards
      </button>
    </section>
  );
}

/* Vivo Stories — editorial covers over the news stories the app already
   carries; tapping opens the full article page. */
const STORY_COVERS = ["story-1.jpg", "story-2.jpg", "story-3.jpg"];
function VivoStories({ onOpenNews, onViewAll }) {
  const items = NEWS.slice(0, 3);
  if (!items.length) return null;
  return (
    <section data-testid="home-stories">
      <div className="flex items-end justify-between gap-4">
        <SectionHeader kicker="Vivo Stories" title="Styling, campaigns & what's on" />
        {onViewAll && (
          <button
            data-testid="home-stories-viewall"
            onClick={onViewAll}
            className="shrink-0 mb-6 text-[13px] font-medium text-primary-ink hover:underline inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
          >
            View All Stories <ChevronRight size={14} />
          </button>
        )}
      </div>
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

export default function TabHome({ onNavigate, member, onOpenProduct, onOpenPage, onOpenEvent }) {
  const [events, setEvents] = useState([]);
  // Live challenges — the mission card and sidebar feature the first open one.
  const [liveChallenges, setLiveChallenges] = useState([]);
  // Celebrations feed the sidebar jewel (same rotation the wall shows).
  const [cel, setCel] = useState(null);
  const featuredChallenge = liveChallenges.find((c) => !c.closed) || null;

  useEffect(() => {
    let alive = true;
    // Soonest upcoming event feeds the "What's on" card; quiet-failure
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

  const openNews = (id) => onOpenPage?.(newsPageId(id));
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

  /* Style Question of the Week — the single most-engaged open question. */
  const questionOfWeek = useMemo(
    () =>
      feed
        .filter((p) => p.post_type === "question")
        .slice()
        .sort((a, b) => (b.like_count + b.comment_count) - (a.like_count + a.comment_count))[0] || null,
    [feed],
  );

  /* Feed preview — max 4 featured posts: visual posts and meaningful
     engagement first; the question of the week is featured separately. */
  const previewPosts = useMemo(() => {
    const score = (p) => (p.variant !== "quote" && p.post_type !== "question" ? 100 : 0) + p.like_count * 2 + p.comment_count * 3;
    return feed
      .filter((p) => p.id !== questionOfWeek?.id)
      .slice()
      .sort((a, b) => score(b) - score(a))
      .slice(0, 4);
  }, [feed, questionOfWeek]);

  /* Community-first homepage (per Sharon's brief): hero → this week's
     mission → personal moments → community feed preview → Fresh from Vivo
     reels → style question of the week → upcoming event → Community
     Spotlight → Styled for You (+ survey) → Shop Community Looks →
     Member Rewards → Vivo Stories → Second Life. Shopping promos, try-on,
     fit notes and boards live on Shop / product pages / Community now. */
  return (
    <div className="max-w-4xl mx-auto space-y-16 sm:space-y-24">
      <div className="-mt-2">
        <HeroCampaign onNavigate={onNavigate} />
      </div>

      {/* 2 · This Week's Mission */}
      <MissionCard challenge={featuredChallenge} onNavigate={onNavigate} />

      {/* Personal one-shot moments — celebration/winner/tier, member-only */}
      {member && (
        <div className="space-y-4 empty:hidden">
          <CelebrationCard member={member} />
          <WinnerCongratsCard />
          <PersonalCard member={member} onNavigate={onNavigate} />
        </div>
      )}

      {/* 3 · Community feed preview — max 4 featured posts + Join the Conversation.
          Guests see the community intro instead (posts carry like writes). */}
      {member ? (
        previewPosts.length > 0 && (
          <section data-testid="home-feed-preview">
            <SectionHeader kicker="This week in the community" title="Looks & conversations we loved" />
            <div className="grid sm:grid-cols-2 gap-4 sm:gap-6">
              {previewPosts.map((p) => (
                <PostCard key={p.id} post={p} onOpen={openPost} onCounts={patchPost} />
              ))}
            </div>
            <div className="mt-8 text-center">
              <button
                data-testid="home-view-community"
                onClick={() => onNavigate("community")}
                className="h-11 px-8 rounded bg-foreground text-background font-medium text-[14px] inline-flex items-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                Join the Conversation <ArrowRight size={15} />
              </button>
            </div>
          </section>
        )
      ) : (
        <CommunitySpotlight onNavigate={onNavigate} />
      )}

      {/* 4 · Fresh from Vivo — capped reel carousel + View All */}
      <ReelsRow member={member} limit={5} onViewAll={() => onNavigate("community")} />

      {/* 4b · This Week's Vivo Playlist — Spotify embed, grouped with Reels
          as Home's brand-content block */}
      <WeeklyPlaylist />

      {/* 5 · Styled for You — personalisation + the dress-you-better survey */}
      {member && (
        <div className="space-y-4">
          <StyledForYouHome
            member={member}
            onOpenProduct={onOpenProduct}
            onViewAll={() => {
              try { sessionStorage.setItem("vivo_shop_sfy", "1"); } catch { /* private mode */ }
              onNavigate("shop");
            }}
            onPersonalise={() => onOpenPage("styleprefs")}
          />
        </div>
      )}

      {/* Vivo Edits moved to the Community tab (Home-vs-Shop rewire spec) */}

      {/* 7 · Community Spotlight — Jewel + Voices merged into one feature */}
      <CommunitySpotlightCard jewel={cel?.jewel} onNavigate={onNavigate} />

      {/* 8 · Vivo Stories — three editorial covers + view all */}
      <VivoStories onOpenNews={openNews} onViewAll={() => onNavigate("community")} />

      {/* 9 · Member Rewards — one compact preview */}
      <RewardsSummaryCard member={member} onNavigate={onNavigate} />

      {/* Style Question of the Week — one featured conversation */}
      {member && questionOfWeek && (
        <section data-testid="home-style-question">
          <SectionHeader kicker="Style question of the week" title="Weigh in — the community wants to know" />
          <PostCard post={questionOfWeek} onOpen={openPost} onCounts={patchPost} />
        </section>
      )}

      {/* Upcoming event — the next one only; calendar stays in Community */}
      <UpcomingEventCard ev={nextEvent} onOpen={onOpenEvent} />

      {/* Give your Vivo a second life — small closing feature */}
      <SecondLifeCard onOpenPage={onOpenPage} />

      {detailIdx >= 0 && P[detailIdx] && (
        <PostDetailModal restoreY={restoreY} posts={P} index={detailIdx} onIndex={setDetailIdx}
                         onClose={() => setDetailIdx(-1)} onOpenProduct={onOpenProduct}
                         onCounts={patchPost} />
      )}

      <EndCap onNavigate={onNavigate} />
    </div>
  );
}
