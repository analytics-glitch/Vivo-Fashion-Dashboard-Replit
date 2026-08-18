import { useCallback, useEffect, useState } from "react";
import { styleBoards } from "./mockData";
import PostDetailModal from "./PostDetailModal";
import ChallengeDetail from "./ChallengeDetail";
import { api } from "@/lib/api";
import { useAuthImage } from "./authImage";
import { TierBadge, Avatar, ImagePlaceholder, cardCls, brandAsset } from "./ui";
import { NEWS } from "./newsData";
import { NewsCardCompact } from "./NewsSection";
import {
  Trophy, Users, Heart, MessageCircle, Clock, Sparkles, Plus, X,
  ChevronRight, HandHeart, Camera, HelpCircle, Play,
} from "lucide-react";
import EntryModal, { ENTRY_STATUS_COPY } from "./EntryModal";
import { VivoEditsHome } from "./VivoEdits";
import EventsList from "./EventsList";
import { FabulasCarousel } from "./FabulasStory";

const WELCOME_KEY = "vivo_community_welcome_dismissed";

const initialsOf = (u) =>
  (u || "?").split(/[._\s-]+/).filter(Boolean).slice(0, 2)
    .map((s) => s[0].toUpperCase()).join("") || "?";

const POSITION_LABEL = { 1: "1st place", 2: "2nd place", 3: "3rd place" };

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-KE", { day: "numeric", month: "long" });
};

// Deterministic weekly-ish rotation for the celebrated list — everyone gets
// their turn near the top without any notion of rank.
const rotate = (arr, n) => {
  if (!arr?.length) return arr || [];
  const k = n % arr.length;
  return arr.slice(k).concat(arr.slice(0, k));
};
const dayOfYear = () => {
  const now = new Date();
  return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
};

/* ---------- feed tiles ---------- */

// Uniform 4:5 tile. Member media (photo/video) comes straight off the public
// entry-photo endpoint; seeded posts carry image_url; questions render as a
// text card — no media expected, ever.
function GridVisual({ post }) {
  if (post.post_type === "question") {
    return (
      <div className="aspect-[4/5] bg-secondary/70 flex flex-col justify-center p-4 sm:p-5">
        <HelpCircle size={18} className="text-primary-ink mb-3" strokeWidth={1.5} />
        <p className="font-serif text-[15px] sm:text-base text-foreground leading-snug line-clamp-6">
          {post.caption}
        </p>
      </div>
    );
  }
  if (post.has_photo && post.photo_path) {
    const src = "/api/community" + post.photo_path;
    return (
      <div className="aspect-[4/5] bg-secondary relative">
        {post.media_kind === "video" ? (
          <>
            <video src={src} muted playsInline preload="metadata" className="w-full h-full object-cover" />
            <span className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/55 text-white flex items-center justify-center">
              <Play size={13} className="fill-white ml-0.5" />
            </span>
          </>
        ) : (
          <img src={src} alt={`Look by @${post.author.username}`} loading="lazy" className="w-full h-full object-cover" />
        )}
      </div>
    );
  }
  if (post.image_url) {
    return (
      <div className="aspect-[4/5] bg-secondary">
        <img src={post.image_url} alt={`Look by @${post.author.username}`} loading="lazy" className="w-full h-full object-cover" />
      </div>
    );
  }
  return <ImagePlaceholder aspectRatio="aspect-[4/5]" className="rounded-none border-none" text={`Look by @${post.author.username}`} />;
}

/* Image-led feed tile — no card chrome: the photo carries the tile, the
   byline and restrained engagement counts sit quietly beneath it. */
function GridPost({ post, onOpen }) {
  return (
    <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={onOpen} data-testid={`grid-post-${post.id}`}
            aria-label={`Open post by @${post.author.username}`}
            className="group cursor-pointer relative block w-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <div className="rounded overflow-hidden mb-2">
        <GridVisual post={post} />
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[11px] font-medium text-muted-foreground truncate">@{post.author.username}</span>
        <span className="flex items-center gap-2.5 text-[11px] text-muted-foreground shrink-0">
          <span className="flex items-center gap-1"><Heart size={12} strokeWidth={1.5} /> {post.like_count}</span>
          <span className="flex items-center gap-1"><MessageCircle size={12} strokeWidth={1.5} /> {post.comment_count}</span>
        </span>
      </div>
    </button>
  );
}

// A member's shared try-on look — image is member-gated, fetched with the
// Bearer header via useAuthImage. Username only; never the member's name.
function SharedLookCard({ look }) {
  // cache:false — sharing is revocable; don't keep another member's image
  // beyond this card's lifetime (see authImage.js).
  const url = useAuthImage(`/tryon/looks/${look.id}/image`, { cache: false });
  return (
    <div data-testid={`shared-look-${look.id}`} className="shrink-0 w-36 sm:w-40 rounded overflow-hidden border border-border bg-card">
      <div className="aspect-[3/4] bg-secondary relative">
        {url ? (
          <img src={url} alt={look.product_name} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full animate-pulse" />
        )}
        {look.demo && (
          <span className="absolute bottom-1.5 left-1.5 bg-foreground/85 text-background text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm">Demo</span>
        )}
      </div>
      <div className="p-2.5">
        <div className="text-[12px] font-medium text-foreground leading-snug line-clamp-1">{look.product_name}</div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">@{look.username}</div>
      </div>
    </div>
  );
}

const SUB_TABS = [
  { id: "feed", label: "Feed" },
  { id: "events", label: "Events" },
  { id: "challenges", label: "Challenges" },
  { id: "leaderboard", label: "Shining This Week" },
  { id: "style_boards", label: "Style Boards" },
];
const SUB_IDS = SUB_TABS.map((t) => t.id);

/* Feed filter chips — the editorial names, mapped onto the existing content
   types (the API's post_type filter is unchanged): For You = everything,
   Styling = looks, Conversations = style questions, Hauls = hauls. Events
   jumps to the Events sub-tab; Stores shows the store-news stories that
   already live in Vivo News. */
const FEED_CHIPS = [
  // ids stay the historical type-derived selectors (chip-all, chip-look,
  // chip-question, chip-haul) so existing test consumers keep working; only
  // the labels adopt the new editorial names.
  { id: "all", label: "For You", type: "" },
  { id: "look", label: "Styling", type: "look" },
  { id: "events", label: "Events", jump: "events" },
  { id: "stores", label: "Stores", view: "stores" },
  { id: "question", label: "Conversations", type: "question" },
  { id: "haul", label: "Hauls", type: "haul" },
];

export default function TabCommunity({ member, subNav, onSubChange, onOpenEvent, onOpenProduct, onOpenPage, onOpenFabulas, onOpenEdit, onOpenEdits }) {
  const [subTab, setSubTab] = useState(() => (SUB_IDS.includes(subNav?.id) ? subNav.id : "feed"));
  const [followed, setFollowed] = useState({});
  const [entryFor, setEntryFor] = useState(null);    // challenge entry composer
  const [composeType, setComposeType] = useState(""); // standalone composer: "look" | "question"

  // Shell-driven sub-navigation (e.g. Home's "What's on" card → Events).
  // subNav carries a nonce (n) so repeat requests for the same sub-tab land.
  useEffect(() => {
    if (subNav?.id && SUB_IDS.includes(subNav.id)) {
      setSubTab(subNav.id);
      setOpenChallenge(null); // fresh outside request always lands on the list
    }
  }, [subNav]);

  // Member-initiated switches also tell the shell, so the URL's ?sub= stays
  // truthful and refresh/share restores the same view.
  const selectSub = (id) => { setSubTab(id); onSubChange?.(id); };

  // Pinned welcome card — dismiss persists per device.
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try { return localStorage.getItem(WELCOME_KEY) === "1"; } catch { return true; }
  });
  const dismissWelcome = () => {
    setWelcomeDismissed(true);
    try { localStorage.setItem(WELCOME_KEY, "1"); } catch { /* private mode */ }
  };

  // Shared try-on looks — members who opted in from their result card.
  const [sharedLooks, setSharedLooks] = useState([]);
  useEffect(() => {
    let alive = true;
    api.tryonShared().then((d) => { if (alive) setSharedLooks(d.items || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Interactive feed — DB-backed posts; likes and comments are real
  // per-member state shared with the detail modal via patchPost.
  const [feed, setFeed] = useState(null); // null = first load
  const [feedType, setFeedType] = useState("");
  // "" = normal feed; "stores" = the store-news stories panel (client-side
  // only — nothing about the feed API changes).
  const [feedView, setFeedView] = useState("");
  const [detailIdx, setDetailIdx] = useState(-1);
  const [restoreY, setRestoreY] = useState(0); // captured at tap time
  useEffect(() => {
    let alive = true;
    setFeed(null);
    setDetailIdx(-1);
    api.feed(50, 0, feedType).then((d) => { if (alive) setFeed(d.items || []); })
      .catch(() => { if (alive) setFeed([]); });
    return () => { alive = false; };
  }, [feedType]);
  const patchPost = (id, patch) =>
    setFeed((list) => (list || []).map((p) => (p.id === id ? { ...p, ...patch } : p)));

  // Live challenges — my_entry rides along per member.
  const [chList, setChList] = useState(null);
  const [openChallenge, setOpenChallenge] = useState(null);
  const loadChallenges = useCallback(() => {
    api.challenges().then((d) => setChList(d.items || [])).catch(() => setChList([]));
  }, []);
  useEffect(() => { loadChallenges(); }, [loadChallenges]);

  // Shining This Week — appreciation wall + past winners strip.
  const [cel, setCel] = useState(null);
  useEffect(() => {
    let alive = true;
    api.celebrations()
      .then((d) => { if (alive) setCel(d); })
      .catch(() => { if (alive) setCel({ jewel: null, celebrated: [], winners: [], new_jewels: [] }); });
    return () => { alive = false; };
  }, []);

  const closeComposer = () => { setEntryFor(null); setComposeType(""); };
  const handleSubmitted = () => { loadChallenges(); };

  const celebrated = rotate(cel?.celebrated || [], dayOfYear());

  return (
    <div className="animate-in fade-in duration-500">
      {/* Sub Tabs */}
      <div className="flex gap-6 border-b border-border mb-8 overflow-x-auto hide-scrollbar">
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => selectSub(t.id)}
            className={`py-3 text-[13px] font-semibold uppercase tracking-wider whitespace-nowrap transition-colors relative ${
              subTab === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground/80"
            }`}
          >
            {t.label}
            {subTab === t.id && (
              <span className="absolute bottom-0 left-0 w-full h-[2px] bg-foreground" />
            )}
          </button>
        ))}
      </div>

      {/* Feed SubTab */}
      {subTab === "feed" && (
        <>
          {/* Featured campaign — the live challenge as an image-led editorial
              header. Pure restyling of existing content: entering still goes
              through the Challenges flow. */}
          {(() => {
            const featured = (chList || []).find((c) => !c.closed);
            if (!featured) return null;
            return (
              <section data-testid="feed-featured" className="relative rounded overflow-hidden bg-secondary mb-8 -mx-4 sm:mx-0">
                <div className="aspect-[4/3] sm:aspect-[21/9] relative">
                  <img
                    src={brandAsset("community.jpg")}
                    alt=""
                    className="w-full h-full object-cover object-[center_25%]"
                    draggable={false}
                  />
                  <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-black/70 via-black/25 to-transparent pointer-events-none" />
                  <div className="absolute inset-x-0 bottom-0 p-5 sm:p-8 text-white">
                    <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/80 mb-1.5">Featured challenge</div>
                    <h2 className="font-serif text-2xl sm:text-3xl leading-tight mb-1.5 text-white">{featured.title}</h2>
                    <p className="text-[13px] text-white/85 max-w-md line-clamp-2 mb-4">{featured.description}</p>
                    <button
                      data-testid="feed-featured-cta"
                      onClick={() => selectSub("challenges")}
                      className="h-10 px-6 rounded bg-white text-neutral-900 font-medium text-[13px] hover:bg-white/90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      {featured.my_entry ? "View challenge" : `Enter — earn ${featured.points} pts`}
                    </button>
                  </div>
                </div>
              </section>
            );
          })()}

          {!welcomeDismissed && (
            <div data-testid="feed-welcome" className="relative bg-primary/5 border border-primary/20 rounded p-5 sm:p-6 mb-6">
              <button aria-label="Dismiss welcome" data-testid="welcome-dismiss" onClick={dismissWelcome}
                      className="absolute top-2.5 right-2.5 w-9 h-9 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <X size={16} />
              </button>
              <div className="text-[11px] font-bold uppercase tracking-wider text-primary-ink mb-1.5">Karibu to Johari</div>
              <h3 className="font-serif text-xl text-foreground mb-1.5">This is where Vivo women shine</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
                Share your looks, ask the honest style questions, cheer each other on — and earn Johari points along the way.
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                <button data-testid="welcome-share" onClick={() => setComposeType("look")}
                        className="h-10 px-4 rounded bg-primary text-primary-foreground text-[13px] font-medium inline-flex items-center gap-1.5 hover:opacity-90 active:scale-[0.98] transition-all">
                  <Camera size={15} /> Share your first look
                </button>
                <button onClick={() => selectSub("challenges")}
                        className="h-10 px-4 rounded bg-background border border-border text-foreground text-[13px] font-medium inline-flex items-center gap-1.5 hover:bg-secondary transition-colors">
                  See challenges
                </button>
              </div>
            </div>
          )}

          {/* Composer — an elegant, quiet invitation at the top of the feed */}
          <div data-testid="feed-composer" className="border-b border-border pb-5 mb-6 flex flex-wrap items-center gap-3">
            <Avatar initials={initialsOf(member?.username)} size="sm" />
            <button data-testid="composer-look" onClick={() => setComposeType("look")}
                    className="flex-1 min-w-[150px] h-11 px-4 rounded-full bg-secondary/60 text-left font-serif italic text-[14px] text-muted-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Share a look with the community…
            </button>
            <div className="flex gap-2">
              <button data-testid="composer-look-btn" onClick={() => setComposeType("look")}
                      className="h-11 px-4 rounded-full bg-foreground text-background text-[13px] font-medium inline-flex items-center gap-1.5 hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
                <Camera size={15} strokeWidth={1.5} /> Share a look
              </button>
              <button data-testid="composer-question-btn" onClick={() => setComposeType("question")}
                      className="h-11 px-4 rounded-full bg-background border border-border text-foreground text-[13px] font-medium inline-flex items-center gap-1.5 hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <HelpCircle size={15} strokeWidth={1.5} /> Ask
              </button>
            </div>
          </div>

          {/* Filter chips — editorial names over the existing content types */}
          <div data-testid="feed-chips" className="flex gap-2 overflow-x-auto hide-scrollbar mb-6 -mx-4 px-4 sm:mx-0 sm:px-0">
            {FEED_CHIPS.map((c) => {
              const active = c.jump ? false : c.view ? feedView === c.view : (feedView === "" && feedType === c.type);
              return (
                <button key={c.id} data-testid={`chip-${c.id}`} aria-pressed={active}
                        onClick={() => {
                          if (c.jump) { selectSub(c.jump); return; }
                          if (c.view) { setFeedView(c.view); return; }
                          setFeedView(""); setFeedType(c.type);
                        }}
                        className={`h-9 px-4 rounded-full text-[12px] font-semibold whitespace-nowrap border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          active
                            ? "bg-foreground text-background border-foreground"
                            : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-secondary"
                        }`}>
                  {c.label}
                </button>
              );
            })}
          </div>

          {/* Stores view — the store stories that already live in Vivo News */}
          {feedView === "stores" && (
            <div data-testid="feed-stores" className="space-y-4 mb-10">
              {NEWS.map((n) => (
                <NewsCardCompact key={n.id} article={n} onOpen={(id) => onOpenPage?.(`news-${id}`)} />
              ))}
            </div>
          )}

          {feedView === "" && sharedLooks.length > 0 && feedType === "" && (
            <section data-testid="shared-looks-strip" className="mb-8">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={14} className="text-primary-ink" />
                <h3 className="font-serif text-lg text-foreground">Shared looks</h3>
                <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">Virtual Try-On</span>
              </div>
              <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
                {sharedLooks.map((l) => <SharedLookCard key={l.id} look={l} />)}
              </div>
            </section>
          )}
          {feedView === "" && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 items-start" data-testid="community-feed-grid">
                {feed === null
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="rounded overflow-hidden animate-pulse">
                        <div className="aspect-[4/5] bg-secondary/60 rounded" />
                      </div>
                    ))
                  : feed.map((p, i) => <GridPost key={p.id} post={p} onOpen={() => { setRestoreY(window.scrollY); setDetailIdx(i); }} />)}
              </div>
              {feed !== null && feed.length === 0 && (
                <p className="text-muted-foreground text-sm italic mt-4">Nothing here yet — be the first to share.</p>
              )}
            </>
          )}

          {/* Vivo Edits — creator/editorial module, moved here from Home
              (rewire spec §8). Cards carry Explore Her Style only — no
              Shop-the-Look CTAs on this surface. */}
          {feedView === "" && feedType === "" && (
            <div className="mt-12">
              <VivoEditsHome onOpenEdit={onOpenEdit} onViewAll={onOpenEdits} feed={feed || undefined} />
            </div>
          )}

          {/* Give Your Vivo a Second Life */}
          <section data-testid="feed-givingback" className={`${cardCls} mt-10 p-5 sm:p-6 flex items-start gap-4`}>
            <HandHeart className="text-primary-ink shrink-0 mt-0.5" size={22} strokeWidth={1.5} />
            <div className="flex-1">
              <h3 className="font-serif text-lg text-foreground mb-1">Give your Vivo a second life</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
                Loved pieces you've outgrown can lift another woman up. Bring them to any Vivo store and we'll take it from there.
              </p>
              <button data-testid="givingback-open" onClick={() => onOpenPage?.("givingback")}
                      className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">
                How it works <ChevronRight size={14} />
              </button>
            </div>
          </section>

          {detailIdx >= 0 && feed && feed[detailIdx] && (
            <PostDetailModal restoreY={restoreY} posts={feed} index={detailIdx} onIndex={setDetailIdx}
                             onClose={() => setDetailIdx(-1)} onOpenProduct={onOpenProduct}
                             onCounts={patchPost} />
          )}

          {/* Mobile FAB — composer in thumb's reach */}
          <button data-testid="feed-fab" aria-label="Share with the community" onClick={() => setComposeType("look")}
                  className="fixed md:hidden bottom-24 right-4 z-30 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center active:scale-95 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
            <Plus size={26} />
          </button>
        </>
      )}

      {/* Events SubTab */}
      {subTab === "events" && (
        <EventsList onEnterChallenge={() => selectSub("challenges")} onOpenEvent={onOpenEvent} />
      )}

      {/* Challenges SubTab */}
      {subTab === "challenges" && openChallenge && (
        <ChallengeDetail challengeId={openChallenge} onBack={() => { setOpenChallenge(null); loadChallenges(); }} onOpenProduct={onOpenProduct} />
      )}
      {subTab === "challenges" && !openChallenge && (
        <div className="space-y-10">
          <div>
            <p data-testid="challenges-review-note" className="text-muted-foreground text-sm leading-relaxed max-w-2xl mb-6">
              Every entry is reviewed with love before it goes live — your points are added the moment your entry is published.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {chList === null
                ? Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className={`${cardCls} p-6 h-52 animate-pulse`} />
                  ))
                : chList.map((c) => (
                    <div key={c.id} className={`${cardCls} p-6 flex flex-col`} data-testid={`challenge-card-${c.id}`}>
                      <div className="flex justify-between items-start mb-3 gap-4">
                        <h3 className="text-xl font-serif text-foreground leading-tight">{c.title}</h3>
                        <span className="bg-primary/10 text-primary-ink border border-primary/20 text-[10px] font-semibold leading-snug px-2.5 py-1.5 rounded-sm shrink-0 max-w-[120px] text-center">
                          Earn {c.points} pts when published
                        </span>
                      </div>
                      {c.hashtag && (
                        <div className="text-[12px] font-semibold text-primary-ink mb-2">{c.hashtag}</div>
                      )}
                      <p className="text-muted-foreground text-[15px] mb-8 flex-grow leading-relaxed line-clamp-3">{c.description}</p>
                      <div className="flex items-center justify-between mt-auto pt-5 border-t border-border gap-3 flex-wrap">
                        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${c.closed ? "bg-muted-foreground" : "bg-primary"}`} />
                            {c.closed ? "Closed" : `Ends ${fmtDate(c.deadline)}`}
                          </span>
                          {c.entries_display && (
                            <span className="flex items-center gap-1.5"><Users size={14}/> {c.entries_display}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2.5">
                          {c.my_entry && (
                            <span data-testid={`entered-${c.id}`} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground bg-secondary border border-border px-3 h-9 rounded whitespace-nowrap">
                              <Clock size={13} strokeWidth={1.5} /> {ENTRY_STATUS_COPY[c.my_entry.status] || "Entered"}
                            </span>
                          )}
                          <button data-testid={`challenge-open-${c.id}`} onClick={() => setOpenChallenge(c.id)}
                                  className="bg-foreground text-background hover:bg-foreground/90 transition-colors text-[13px] font-medium px-4 h-9 rounded active:scale-[0.98]">
                            {c.closed ? "See winners" : c.my_entry ? "View challenge" : "Enter challenge"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
            </div>
          </div>

          <div>
            <h3 className="text-lg font-serif text-foreground mb-4">Past Winners</h3>
            {cel === null ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 bg-secondary rounded animate-pulse" />)}
              </div>
            ) : (cel.winners || []).length === 0 ? (
              <p className="text-sm text-muted-foreground italic">Winners from our latest challenge land here soon.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="past-winners">
                {(cel.winners || []).slice(0, 6).map((w) => (
                  <div key={`${w.challenge_id}-${w.post_id}`} className="bg-secondary rounded p-4 flex items-center gap-4 border border-border">
                    <Avatar initials={initialsOf(w.username)} />
                    <div className="min-w-0">
                      <div className="font-semibold text-[13px] text-foreground truncate">@{w.username}</div>
                      <div className="text-[11px] text-muted-foreground mt-1 leading-snug">
                        <Trophy size={11} className="inline -mt-0.5 mr-1 text-[#d1a657]" />
                        {POSITION_LABEL[w.winner_position] || "Winner"} · “{w.title}”
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Shining This Week SubTab (id kept as "leaderboard" for URL stability) */}
      {subTab === "leaderboard" && (
        <div className="max-w-3xl mx-auto space-y-8" data-testid="celebration-wall">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-primary-ink mb-1.5">Shining this week</div>
            <h2 className="text-2xl font-serif text-foreground mb-1.5">A little love for our Johari Gems</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              No ranks, no numbers — just the community celebrating each other. Celebrations rotate every week.
            </p>
          </div>

          {cel === null ? (
            <div className="space-y-4">
              <div className="h-40 bg-secondary rounded animate-pulse" />
              <div className="h-64 bg-secondary rounded animate-pulse" />
            </div>
          ) : (
            <>
              {cel.jewel && (
                <div data-testid="jewel-card" className="bg-primary/5 border border-primary/20 rounded p-5 sm:p-7">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-primary-ink mb-3 flex items-center gap-1.5">
                    <Sparkles size={13} /> Jewel of the week
                  </div>
                  <div className="flex items-center gap-4 mb-4">
                    <Avatar initials={initialsOf(cel.jewel.username)} tier={cel.jewel.show_tier ? cel.jewel.tier : undefined} size="md" />
                    <div>
                      <div className="font-semibold text-foreground text-[15px]">@{cel.jewel.username}</div>
                      {cel.jewel.show_tier && cel.jewel.tier && <TierBadge tier={cel.jewel.tier} className="mt-1 inline-block" />}
                    </div>
                  </div>
                  <blockquote className="font-serif text-lg text-foreground leading-relaxed">
                    “{cel.jewel.quote}”
                  </blockquote>
                </div>
              )}

              {/* #FabulasAtAnyAge — stories from our partner community */}
              <FabulasCarousel onOpenStory={onOpenFabulas} />

              {(celebrated.length > 0) && (
                <div className={`${cardCls} overflow-hidden`} data-testid="celebrated-list">
                  <div className="p-5 border-b border-border">
                    <h3 className="font-serif text-lg text-foreground">Celebrated this week</h3>
                  </div>
                  <div className="divide-y divide-border">
                    {celebrated.map((c) => (
                      <div key={c.username} className="flex items-start gap-4 p-4 sm:px-5">
                        <Avatar initials={initialsOf(c.username)} size="sm" />
                        <div className="min-w-0">
                          <span className="font-semibold text-[13px] text-foreground">@{c.username}</span>
                          <span className="text-[13px] text-muted-foreground"> — {c.reason}</span>
                        </div>
                        <Heart size={14} className="ml-auto shrink-0 text-primary-ink mt-1" />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(cel.winners || []).length > 0 && (
                <div data-testid="winners-list">
                  <h3 className="font-serif text-lg text-foreground mb-3">Fresh challenge winners</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {cel.winners.slice(0, 3).map((w) => (
                      <div key={`${w.challenge_id}-${w.post_id}`} className="bg-secondary rounded p-4 border border-border">
                        <Trophy size={16} className="text-[#d1a657] mb-2" strokeWidth={1.5} />
                        <div className="font-semibold text-[13px] text-foreground">@{w.username}</div>
                        <div className="text-[11px] text-muted-foreground mt-1 leading-snug">
                          {POSITION_LABEL[w.winner_position] || "Winner"} · “{w.title}”
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(cel.new_jewels || []).length > 0 && (
                <div data-testid="new-jewels">
                  <h3 className="font-serif text-lg text-foreground mb-3">New jewels this week</h3>
                  <div className="flex flex-wrap gap-2">
                    {cel.new_jewels.map((n) => (
                      <span key={n.username} className="inline-flex items-center gap-2 bg-secondary border border-border rounded-full pl-1.5 pr-3.5 py-1.5">
                        <Avatar initials={initialsOf(n.username)} size="sm" />
                        <span className="text-[12px] font-medium text-foreground">@{n.username}</span>
                        <span className="text-[11px] text-muted-foreground">joined {n.joined}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <div data-testid="celebrations-you" className={`${cardCls} p-4 sm:p-5 text-[13px] text-muted-foreground leading-relaxed`}>
            {member?.show_leaderboard === false ? (
              <>You've chosen not to appear in community celebrations. You can change this any time in <span className="font-medium text-foreground">Profile → Privacy</span>.</>
            ) : (
              <>You may be celebrated here as <span className="font-medium text-foreground">@{member?.username}</span>{member?.show_tier ? ", with your tier gem" : " — tier kept private"}. Manage this in <span className="font-medium text-foreground">Profile → Privacy</span>.</>
            )}
          </div>
        </div>
      )}

      {/* Style Boards SubTab */}
      {subTab === "style_boards" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {styleBoards.map((board, i) => (
            <div key={i} className={`${cardCls} overflow-hidden group`}>
              <div className="grid grid-cols-2 grid-rows-2 h-48 gap-px bg-border p-px">
                <ImagePlaceholder className="rounded-none h-full w-full border-none" aspectRatio="aspect-auto" text="" />
                <ImagePlaceholder className="rounded-none h-full w-full border-none" aspectRatio="aspect-auto" text="" />
                <ImagePlaceholder className="rounded-none h-full w-full col-span-2 border-none" aspectRatio="aspect-auto" text="" />
              </div>
              <div className="p-5 flex justify-between items-start bg-background">
                <div>
                  <h3 className="font-serif text-foreground text-lg mb-1">{board.title}</h3>
                  <div className="text-xs text-muted-foreground tracking-wide uppercase">{board.items} items • {board.followers} followers</div>
                </div>
                <button
                  data-testid="follow-btn"
                  onClick={() => setFollowed(f => ({ ...f, [i]: !f[i] }))}
                  className={`text-xs font-medium px-5 min-h-[44px] inline-flex items-center rounded transition-all active:scale-[0.95] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                    followed[i]
                      ? "bg-primary border-primary text-primary-foreground"
                      : "bg-background border-border text-foreground hover:bg-secondary"
                  }`}
                >
                  {followed[i] ? "Following" : "Follow"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(entryFor || composeType) && (
        <EntryModal challenge={entryFor} postType={composeType} onClose={closeComposer} onSubmitted={handleSubmitted} />
      )}
    </div>
  );
}
