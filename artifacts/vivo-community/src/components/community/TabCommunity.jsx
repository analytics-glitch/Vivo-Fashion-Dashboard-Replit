import React, { useEffect, useState } from 'react';
import { posts, challenges, leaderboard, styleBoards } from "./mockData";
import { api } from "@/lib/api";
import { useAuthImage } from "./authImage";
import { TierBadge, Avatar, ImagePlaceholder, cardCls, btnPrimary } from "./ui";
import { Trophy, Users, Heart, MessageCircle, Clock, Sparkles } from "lucide-react";
import EntryModal, { getEntries } from "./EntryModal";
import EventsList from "./EventsList";

function GridPost({ post }) {
  return (
    <div className="bg-card rounded overflow-hidden shadow-sm hover:shadow-md transition-shadow group cursor-pointer relative border border-border">
      <ImagePlaceholder aspectRatio="aspect-[4/5]" className="rounded-none border-none" text="Post" />
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-6 text-white backdrop-blur-[2px]">
        <div className="flex items-center gap-2 font-medium"><Heart className="fill-white" size={20} /> {post.likes}</div>
        <div className="flex items-center gap-2 font-medium"><MessageCircle className="fill-white" size={20} /> {post.comments}</div>
      </div>
    </div>
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
  { id: "leaderboard", label: "Leaderboard" },
  { id: "style_boards", label: "Style Boards" },
];
const SUB_IDS = SUB_TABS.map((t) => t.id);

export default function TabCommunity({ member, subNav, onSubChange, onOpenEvent }) {
  const [subTab, setSubTab] = useState(() => (SUB_IDS.includes(subNav?.id) ? subNav.id : "feed"));
  const [followed, setFollowed] = useState({});
  const [entryFor, setEntryFor] = useState(null);
  const [enteredIds, setEnteredIds] = useState(() => new Set(getEntries().map((e) => e.challengeId)));

  // Shell-driven sub-navigation (e.g. Home's "What's on" card → Events).
  // subNav carries a nonce (n) so repeat requests for the same sub-tab land.
  useEffect(() => {
    if (subNav?.id && SUB_IDS.includes(subNav.id)) setSubTab(subNav.id);
  }, [subNav]);

  // Member-initiated switches also tell the shell, so the URL's ?sub= stays
  // truthful and refresh/share restores the same view.
  const selectSub = (id) => { setSubTab(id); onSubChange?.(id); };

  const refreshEntered = () => setEnteredIds(new Set(getEntries().map((e) => e.challengeId)));

  // Shared try-on looks — members who opted in from their result card.
  const [sharedLooks, setSharedLooks] = useState([]);
  useEffect(() => {
    let alive = true;
    api.tryonShared().then((d) => { if (alive) setSharedLooks(d.items || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
          {sharedLooks.length > 0 && (
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {posts.map(p => <GridPost key={p.id} post={p} />)}
            {posts.map(p => <GridPost key={p.id + 'dup'} post={{...p, likes: p.likes + 10}} />)}
          </div>
        </>
      )}
      
      {/* Events SubTab */}
      {subTab === "events" && (
        <EventsList onEnterChallenge={() => selectSub("challenges")} onOpenEvent={onOpenEvent} />
      )}

      {/* Challenges SubTab */}
      {subTab === "challenges" && (
        <div className="space-y-10">
          <div>
            <p data-testid="challenges-review-note" className="text-muted-foreground text-sm leading-relaxed max-w-2xl mb-6">
              Every entry is reviewed with love before it goes live — your points are added the moment your entry is published.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {challenges.map(c => (
                <div key={c.id} className={`${cardCls} p-6 flex flex-col`}>
                  <div className="flex justify-between items-start mb-4 gap-4">
                    <h3 className="text-xl font-serif text-foreground leading-tight">{c.title}</h3>
                    <span className="bg-primary/10 text-primary-ink border border-primary/20 text-[10px] font-semibold leading-snug px-2.5 py-1.5 rounded-sm shrink-0 max-w-[120px] text-center">
                      Earn {c.points} pts when published
                    </span>
                  </div>
                  <p className="text-muted-foreground text-[15px] mb-8 flex-grow leading-relaxed">{c.description}</p>
                  <div className="flex items-center justify-between mt-auto pt-5 border-t border-border">
                    <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
                      <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-primary" /> {c.deadline}</span>
                      <span className="flex items-center gap-1.5"><Users size={14}/> {c.entries} entries</span>
                    </div>
                    {enteredIds.has(c.id) ? (
                      <span data-testid={`entered-${c.id}`} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground bg-secondary border border-border px-3 h-9 rounded whitespace-nowrap">
                        <Clock size={13} strokeWidth={1.5} /> Entered — in review
                      </span>
                    ) : (
                      <button data-testid={`enter-${c.id}`} onClick={() => setEntryFor(c)} className="bg-foreground text-background hover:bg-foreground/90 transition-colors text-[13px] font-medium px-4 h-9 rounded active:scale-[0.98]">
                        Enter Challenge
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div>
            <h3 className="text-lg font-serif text-foreground mb-4">Past Winners</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false },
                { username: "wanjiku.m", initials: "WM", tier: "Tanzanite", showTier: false },
                { username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true },
              ].map((w) => (
                <div key={w.username} className="bg-secondary rounded p-4 flex items-center gap-4 border border-border">
                  {/* Privacy: tier styling only for members who opted in */}
                  <Avatar initials={w.initials} tier={w.showTier ? w.tier : undefined} />
                  <div>
                    <div className="font-semibold text-[13px] text-foreground">@{w.username}</div>
                    <div className="text-[11px] text-muted-foreground mt-1">Won "Style It 3 Ways" · 150pts prize</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Leaderboard SubTab */}
      {subTab === "leaderboard" && (
        <div className="max-w-3xl mx-auto">
          <div className={`${cardCls} overflow-hidden`}>
            <div className="p-6 bg-secondary/50 border-b border-border">
              <h2 className="text-xl font-serif text-foreground flex items-center gap-2 mb-1">
                <Trophy className="text-primary-ink" size={24} strokeWidth={1.5} /> Weekly Top Contributors
              </h2>
              <p className="text-muted-foreground text-sm">Ranked by community activity this week — posts, comments and challenge entries. Points balances stay private.</p>
            </div>
            <div className="divide-y divide-border">
              {leaderboard.map((user, idx) => (
                <div key={user.username} className={`flex items-center justify-between p-4 sm:p-6 transition-colors hover:bg-secondary/30 ${idx < 3 ? 'bg-background' : ''}`}>
                  <div className="flex items-center gap-4 sm:gap-6">
                    <div className={`text-lg font-serif italic w-6 text-center ${idx === 0 ? 'text-[#d1a657]' : idx === 1 ? 'text-[#a1a7b0]' : idx === 2 ? 'text-[#c28662]' : 'text-muted-foreground'}`}>
                      #{user.rank}
                    </div>
                    {/* Privacy: username only; tier badge is opt-in */}
                    <Avatar initials={user.initials} tier={user.showTier ? user.tier : undefined} size="md" />
                    <div>
                      <div className="font-semibold text-foreground text-sm sm:text-[15px]">@{user.username}</div>
                      {user.showTier && <TierBadge tier={user.tier} className="mt-1 inline-block" />}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-foreground font-medium text-lg">{user.contributions}</div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground">contributions</div>
                  </div>
                </div>
              ))}
            </div>
            <div data-testid="leaderboard-you" className="p-4 sm:p-5 bg-secondary/30 border-t border-border text-[13px] text-muted-foreground leading-relaxed">
              {member?.show_leaderboard === false ? (
                <>You're hidden from the leaderboard. You can change this any time in <span className="font-medium text-foreground">Profile → Privacy</span>.</>
              ) : (
                <>You appear here as <span className="font-medium text-foreground">@{member?.username}</span>{member?.show_tier ? ", with your tier badge" : " — tier badge hidden"}. Manage this in <span className="font-medium text-foreground">Profile → Privacy</span>.</>
              )}
            </div>
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

      <EntryModal challenge={entryFor} onClose={() => setEntryFor(null)} onSubmitted={refreshEntered} />
    </div>
  );
}