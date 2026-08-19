import React, { useEffect, useMemo, useState } from 'react';
import { Heart, MessageCircle, Share, ArrowRight, ChevronRight, Cake, Gift, X, Trophy, HelpCircle, HandHeart, Clock, MapPin } from "lucide-react";
import PostDetailModal from "./PostDetailModal";
import { PostVisual, timeAgo } from "./PostBits";
import { TierBadge, Avatar, cardCls, brandAsset, SectionHeader } from "./ui";
import { api } from "@/lib/api";
import { StyledForYouHome } from "./StyledForYou";
import { NEWS, newsPageId } from "./newsData";
import { NewsCover } from "./NewsSection";
import { evImgUrl } from "./EventSpots";
import { HOME_TEASER_BANNERS } from "./homeTeaserBanners";
import ReelsRow from "./ReelsRow";
import WeeklyPlaylist from "./WeeklyPlaylist";

const initialsOf = (u) =>
  (u || "?").split(/[._\s-]+/).filter(Boolean).slice(0, 2)
    .map((x) => x[0].toUpperCase()).join("") || "?";

// Promo Banner Configuration
const HOME_PROMO = {
  kicker: "For a limited time",
  title: "Free delivery over KES 5,000",
  sub: "Nairobi, Kigali and Kampala — straight to your door.",
  image: "promo.jpg",
};

/* PostCard (kept for detail modal parity & mini-feed) */
function PostCard({ post, onOpen, onCounts }) {
  const [likeBump, setLikeBump] = useState(0);
  if (!post) return null;

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
    <div className={`${cardCls} p-5 transition-transform hover:-translate-y-0.5 duration-300 ${post.post_type === "question" ? "bg-primary/5 border-primary/20" : ""}`} data-testid={`post-card-${post.id}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
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

      {post.post_type === "question" ? (
        <div role="button" tabIndex={0} onClick={open} onKeyDown={onOpenKey}
             onPointerDown={(e) => e.preventDefault()}
             aria-label="Open style question"
             className="flex items-start gap-3 mb-5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          <HelpCircle size={18} className="text-primary-ink mt-1 shrink-0" strokeWidth={1.5} />
          <p className="font-serif text-lg sm:text-xl leading-snug text-foreground/90">{post.caption}</p>
        </div>
      ) : post.variant === "quote" ? (
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

const TIER_RANK = { Tsavorite: 0, Ruby: 1, Tanzanite: 2, Pearl: 0, Diamond: 2 };
function CelebrationCard({ member }) {
  const [moment, setMoment] = useState(null);
  useEffect(() => {
    const tier = member?.tier;
    if (!tier) return;
    let welcome = false;
    try {
      welcome = sessionStorage.getItem("johari_welcome") === "1";
      if (welcome) sessionStorage.removeItem("johari_welcome");
    } catch { }
    let prev = null;
    try {
      prev = localStorage.getItem("johari_tier_seen");
      localStorage.setItem("johari_tier_seen", tier);
    } catch { }
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
          {welcome ? "Karibu Vivo Johari — we shine together." : `You're now ${moment.tier} — vigelegele!`}
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
    try { localStorage.setItem(`johari_winner_seen_${win.post_id}`, "1"); } catch { }
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

function PersonalCard({ member, onNavigate }) {
  const now = new Date();
  if (!member) return null;
  const dobMonth = member?.dob ? parseInt(String(member.dob).slice(5, 7), 10) : NaN;
  const birthday = !Number.isNaN(dobMonth) && dobMonth === now.getMonth() + 1;
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
        <button onClick={() => onNavigate("rewards")} aria-label="See your rewards"
          className="w-11 h-11 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
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
          <button onClick={() => onNavigate("rewards")} aria-label="See your rewards"
            className="w-11 h-11 shrink-0 rounded-full border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
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

function HeroCampaign({ onOpenPage }) {
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
        {!loaded && <div className="absolute inset-0 bg-secondary animate-pulse" aria-hidden="true" />}
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/20 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 p-6 sm:p-10 text-white">
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-white/80 mb-2">This season's conversation</div>
          <h2 className="font-serif text-3xl sm:text-4xl leading-tight mb-2 text-white">The New Old Money</h2>
          <p className="text-[14px] text-white/85 mb-5 max-w-sm">Timeless silhouettes, refined details and effortless elegance, reimagined for the modern Vivo woman.</p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <button
              data-testid="hero-join-cta"
              onClick={() => onOpenPage?.("article-the-new-old-money")}
              className="h-10 sm:h-11 px-6 rounded bg-white text-neutral-900 font-medium text-[13px] hover:bg-white/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Join the Conversation
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function FeedPreview({ posts, openPost, patchPost, onNavigate }) {
  return (
    <section data-testid="home-feed-preview" className="flex flex-col h-full">
      <SectionHeader kicker="This week in the community" title="Looks & conversations we loved" />
      <div className="flex-grow flex flex-col">
        {posts.length ? (
          <div className="grid grid-cols-2 gap-3 mb-4">
            {posts.map((post) => (
              <button
                key={post.id}
                type="button"
                data-testid={`home-feed-tile-${post.id}`}
                onClick={() => openPost(post)}
                className={`${cardCls} overflow-hidden text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
              >
                <PostVisual post={post} className="mb-0 rounded-none" />
                <div className="p-3">
                  <div className="text-[11px] font-semibold text-foreground truncate">@{post.author.username}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">{post.caption}</p>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="bg-secondary flex-grow rounded mb-4 flex items-center justify-center p-6 text-center text-[13px] text-muted-foreground border border-border">
            Nothing here yet
          </div>
        )}
        <button
          data-testid="home-view-community"
          onClick={() => onNavigate("community")}
          className="h-11 w-full rounded bg-foreground text-background font-medium text-[14px] inline-flex justify-center items-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Join the Conversation <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
}

function CommunitySpotlightCard({ jewel, onNavigate }) {
  const username = jewel?.username || "amina_h";
  const quote = jewel?.quote || "I came for the dresses. I stayed for the women.";
  const tier = jewel?.show_tier ? jewel?.tier : undefined;
  return (
    <section data-testid="home-spotlight-card" className="bg-foreground text-background rounded p-6 sm:p-10 relative overflow-hidden flex flex-col justify-center h-full">
      <div className="absolute top-0 right-0 w-48 h-48 bg-white/5 rounded-full blur-3xl pointer-events-none" />
      <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mb-5 relative z-10">Community Spotlight</div>
      <div className="flex items-center gap-4 mb-5 relative z-10">
        <Avatar initials={initialsOf(username)} tier={tier} size="md" />
        <div>
          <div className="font-semibold text-background text-base">@{username}</div>
          {tier && <div className="mt-1"><TierBadge tier={tier} /></div>}
        </div>
      </div>
      <blockquote className="font-serif text-xl sm:text-2xl leading-snug italic mb-6 relative z-10 text-white/95">
        "{quote}"
      </blockquote>
      <div className="mt-auto relative z-10">
        <button
          data-testid="spotlight-story-cta"
          onClick={() => onNavigate("community")}
          className="h-10 px-6 rounded border border-background/40 text-background text-[13px] font-medium hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
        >
          Read Her Story
        </button>
      </div>
    </section>
  );
}

function HomeTeaserBanner({ banner, testId, ctaTestId, onOpen }) {
  return (
    <section data-testid={testId} className="h-full">
      <button
        type="button"
        data-testid={ctaTestId}
        onClick={onOpen}
        aria-label={`${banner.cta}: ${banner.title}`}
        className="group relative h-full min-h-[390px] sm:min-h-[430px] w-full overflow-hidden rounded bg-foreground text-left shadow-[0_4px_24px_rgba(0,0,0,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <img
          src={brandAsset(banner.image960)}
          srcSet={`${brandAsset(banner.image640)} 640w, ${brandAsset(banner.image960)} 960w`}
          sizes="(max-width: 767px) calc(100vw - 32px), 432px"
          alt={banner.alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.025]"
          style={{ objectPosition: banner.objectPosition }}
        />
        <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/5 transition-colors group-hover:from-black/90" />
        <span className="absolute inset-x-0 bottom-0 p-5 sm:p-7 text-white">
          <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-white/75 mb-2">{banner.kicker}</span>
          <span className="block font-serif text-2xl sm:text-3xl leading-tight text-white">{banner.title}</span>
          <span className="block mt-2 max-w-sm text-[13px] leading-relaxed text-white/80">{banner.description}</span>
          <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-white group-hover:underline underline-offset-4">
            {banner.cta} <ChevronRight size={14} />
          </span>
          {banner.disclosure && (
            <span className="block mt-2 text-[10px] leading-relaxed text-white/60">{banner.disclosure}</span>
          )}
        </span>
      </button>
    </section>
  );
}

function CommunityFeedTeaser({ onNavigate }) {
  return (
    <HomeTeaserBanner
      banner={HOME_TEASER_BANNERS.community}
      testId="home-community-teaser"
      ctaTestId="home-view-community"
      onOpen={() => onNavigate("community")}
    />
  );
}

function CuratorsTeaser({ onOpenPage }) {
  return (
    <HomeTeaserBanner
      banner={HOME_TEASER_BANNERS.curators}
      testId="home-curators-teaser"
      ctaTestId="home-curators-cta"
      onOpen={() => onOpenPage("edits")}
    />
  );
}

function StyleBoardsTeaser({ onOpenStyleBoards }) {
  return (
    <HomeTeaserBanner
      banner={HOME_TEASER_BANNERS.styleBoards}
      testId="home-styleboards-teaser"
      ctaTestId="home-styleboards-cta"
      onOpen={() => onOpenStyleBoards?.()}
    />
  );
}

function JohariNewsCompact({ onOpenNews }) {
  const item = NEWS[0];
  if (!item) return null;
  return (
    <HomeTeaserBanner
      banner={HOME_TEASER_BANNERS.news}
      testId="home-stories-compact"
      ctaTestId="home-johari-news-cta"
      onOpen={() => onOpenNews(item.id)}
    />
  );
}

function HomeEventCard({ event, onOpen }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = evImgUrl(event);
  return (
    <button
      data-testid={`home-event-${event.id}`}
      onClick={() => onOpen?.(event.id)}
      className={`${cardCls} overflow-hidden text-left group hover:-translate-y-0.5 transition-transform duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="aspect-[3/2] overflow-hidden bg-secondary">
        {src && !imgFailed ? (
          <img
            src={src}
            alt={event.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <NewsCover article={{ image: null, cover: event.cover }} size="md" className="h-full" />
        )}
      </div>
      <div className="p-4 sm:p-5">
        <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-2">{event.kicker || "What's On"}</div>
        <h3 className="font-serif text-lg text-foreground mb-2 group-hover:underline decoration-border">{event.title}</h3>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Clock size={12} strokeWidth={1.5} className="shrink-0" />
          <span>{event.date_label}{event.time_label ? ` · ${event.time_label}` : ""}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground mt-1">
          <MapPin size={12} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate">{event.venue}</span>
        </div>
      </div>
    </button>
  );
}

function EventsRow({ events, onOpenEvents, onOpenEvent }) {
  const displayEvents = events.slice(0, 2);
  return (
    <section data-testid="home-events-row">
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1.5">
            Community
          </div>
          <h2 className="text-2xl font-serif text-foreground">Upcoming Events</h2>
        </div>
        <button
          data-testid="home-events-link"
          onClick={onOpenEvents}
          className="text-[13px] font-medium text-primary-ink hover:underline inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          View all <ChevronRight size={14} />
        </button>
      </div>
      
      {displayEvents.length > 0 ? (
        <div className="grid sm:grid-cols-2 gap-4 sm:gap-6">
          {displayEvents.map((event) => (
            <HomeEventCard key={event.id} event={event} onOpen={onOpenEvent} />
          ))}
        </div>
      ) : (
        <div className="bg-secondary rounded p-8 text-center text-[13px] text-muted-foreground border border-border">
          No upcoming events at the moment. Stay tuned!
        </div>
      )}
    </section>
  );
}

function ConfigurablePromoBanner() {
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
      <div className="relative p-6 sm:p-8 max-w-md text-white">
        <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/75 mb-2">{HOME_PROMO.kicker}</div>
        <h3 className="font-serif text-2xl sm:text-3xl leading-tight mb-1.5 text-white">{HOME_PROMO.title}</h3>
        <p className="text-[13px] text-white/85">{HOME_PROMO.sub}</p>
      </div>
    </section>
  );
}

function GiveBack({ onOpenPage }) {
  return (
    <section data-testid="home-givingback" className={`${cardCls} p-5 sm:p-6 flex flex-col sm:flex-row sm:items-start gap-4`}>
      <HandHeart className="text-primary-ink shrink-0 mt-0.5 hidden sm:block" size={24} strokeWidth={1.5} />
      <div className="flex-1">
        <div className="flex items-center gap-3 mb-1.5">
          <HandHeart className="text-primary-ink shrink-0 sm:hidden" size={20} strokeWidth={1.5} />
          <h3 className="font-serif text-lg text-foreground">Give your Vivo a second life</h3>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed max-w-2xl">
          Pieces you've outgrown can lift another woman up — bring them to any Vivo store.
        </p>
        <button data-testid="givingback-open" onClick={() => onOpenPage?.("givingback")}
                className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">
          How it works <ChevronRight size={14} />
        </button>
      </div>
    </section>
  );
}

export default function TabHome({ onNavigate, member, onOpenProduct, onOpenPage, onOpenEvents, onOpenEvent, onOpenStyleBoards }) {
  const [cel, setCel] = useState(null);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    let alive = true;
    api.celebrations().then((d) => { if (alive) setCel(d); }).catch(() => {});
    api.events().then((d) => { if (alive) setEvents(d.items || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const openNews = (id) => onOpenPage?.(newsPageId(id));

  return (
    <div className="max-w-4xl mx-auto space-y-7 sm:space-y-9 pb-10">
      <div className="-mt-2">
        <HeroCampaign onOpenPage={onOpenPage} />
      </div>

      {/* Row 1: Looks and conversations + Community Spotlight */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6 items-stretch">
        <div className="col-span-1 h-full">
          <CommunityFeedTeaser onNavigate={onNavigate} />
        </div>
        <div className="col-span-1 h-full">
          <CommunitySpotlightCard jewel={cel?.jewel} onNavigate={onNavigate} />
        </div>
      </div>

      {/* Row 2: Reels + Curators teaser */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6 items-stretch">
        <div className="col-span-1 h-full flex flex-col justify-center">
          <ReelsRow member={member} limit={4} onViewAll={() => onNavigate("community")} compact />
        </div>
        <div className="col-span-1 h-full">
          <CuratorsTeaser onOpenPage={onOpenPage} />
        </div>
      </div>

      {/* Row 3: Playlist + Style Boards teaser */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6 items-stretch">
        <div className="col-span-1 h-full flex flex-col justify-center">
          <WeeklyPlaylist compact />
        </div>
        <div className="col-span-1 h-full">
          <StyleBoardsTeaser onOpenStyleBoards={onOpenStyleBoards} />
        </div>
      </div>

      {/* Row 4: Styled for You + Compact News */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6 items-stretch">
        <div className="col-span-1 h-full">
          {member ? (
            <StyledForYouHome
              member={member}
              onOpenProduct={onOpenProduct}
              onViewAll={() => onNavigate("shop")}
              onPersonalise={() => onOpenPage("styleprefs")}
            />
          ) : (
            <div className={`${cardCls} p-6 sm:p-8 flex flex-col justify-center h-full`}>
               <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-3">
                  New
               </div>
               <h3 className="font-serif text-2xl text-foreground mb-3">Styled for You</h3>
               <p className="text-[13px] text-muted-foreground leading-relaxed mb-6">
                  Get weekly outfit and product recommendations selected around your style, size and preferences.
               </p>
               <button
                 onClick={() => onNavigate("profile")}
                 className="h-10 px-6 sm:w-auto w-full rounded bg-primary text-primary-foreground text-[13px] font-medium hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
               >
                  Personalise My Style
               </button>
            </div>
          )}
        </div>
        <div className="col-span-1 h-full">
          <JohariNewsCompact onOpenNews={openNews} />
        </div>
      </div>

      {/* Row 5: Events */}
      <EventsRow events={events} onOpenEvents={onOpenEvents} onOpenEvent={onOpenEvent} />

      <ConfigurablePromoBanner />
      
      <GiveBack onOpenPage={onOpenPage} />
    </div>
  );
}