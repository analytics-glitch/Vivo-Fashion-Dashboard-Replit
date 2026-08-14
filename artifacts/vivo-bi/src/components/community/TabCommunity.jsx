import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from "react-dom";
import { posts, challenges, leaderboard, styleBoards } from "./mockData";
import { TierBadge, Avatar, ImagePlaceholder } from "./ui";
import { Trophy, Users, Heart, ChatCircle, Clock, CheckCircle, X } from "@phosphor-icons/react";

function GridPost({ post, slotId }) {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow group cursor-pointer relative">
      <ImagePlaceholder aspectRatio="aspect-square" className="rounded-none" slotId={slotId} />
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4 text-white">
        <div className="flex items-center gap-1 font-bold"><Heart weight="fill" /> {post.likes}</div>
        <div className="flex items-center gap-1 font-bold"><ChatCircle weight="fill" /> {post.comments}</div>
      </div>
    </div>
  );
}

// Demo entry modal: submissions are reviewed before publication — points are
// only earned once an entry goes live, so no instant points animation here.
function EntryModal({ challenge, onClose, onSubmitted }) {
  const [step, setStep] = useState("form");
  const [caption, setCaption] = useState("");
  const dialogRef = useRef(null);
  const prevFocusRef = useRef(null);

  const open = !!challenge;

  useEffect(() => {
    if (challenge) { setStep("form"); setCaption(""); }
  }, [challenge?.id]);

  // Hand focus back to the invoker when the dialog closes.
  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement;
    return () => {
      if (prevFocusRef.current && typeof prevFocusRef.current.focus === "function") {
        prevFocusRef.current.focus();
      }
      prevFocusRef.current = null;
    };
  }, [open]);

  // Move focus into the dialog on open and when the step changes.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector(
        step === "form" ? '[data-testid="input-entry-caption"]' : '[data-testid="btn-entry-done"]'
      );
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!challenge) return null;

  // Keep Tab cycling inside the dialog while it is open.
  const trapTab = (e) => {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll(
      'button, textarea, input, select, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes).filter((n) => !n.disabled);
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose} data-testid="entry-modal">
      <div
        ref={dialogRef}
        role="dialog" aria-modal="true" aria-labelledby="bi-entry-title"
        className="bg-white rounded-2xl shadow-xl border border-[#e8dfd5] w-full max-w-md p-6 relative"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <button aria-label="Close" onClick={onClose} className="absolute top-4 right-4 text-[#a8a199] hover:text-[#2c2a29] transition-colors">
          <X size={18} />
        </button>

        {step === "form" ? (
          <>
            <h3 id="bi-entry-title" className="text-xl font-bold text-[#2c2a29] mb-1 pr-8">Enter {challenge.title}</h3>
            <p className="text-sm font-semibold text-[#C43E00] mb-4">Earn {challenge.points} pts when your entry is published</p>
            <textarea
              data-testid="input-entry-caption"
              aria-label="Your story"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              placeholder="Tell us the story behind your look…"
              className="w-full rounded-xl border border-[#e8dfd5] bg-[#fcfaf8] p-3 text-sm text-[#2c2a29] placeholder-[#a8a199] focus:outline-none focus:ring-2 focus:ring-[#FE5000] resize-none mb-4"
            />
            <p className="text-xs text-[#7a746e] leading-relaxed bg-[#f5ece4] rounded-xl p-3 mb-5">
              Our team reviews every entry before it goes live in the community — it's how we keep this space lovely. Your {challenge.points} points are added as soon as your entry is published.
            </p>
            <div className="flex gap-3">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-[#e8dfd5] text-sm font-bold text-[#7a746e] hover:bg-[#faf8f5] transition-colors">Not now</button>
              <button data-testid="btn-entry-submit" onClick={() => { setStep("done"); onSubmitted?.(challenge.id); }} className="flex-1 py-2.5 rounded-lg bg-[#FE5000] text-white text-sm font-bold hover:bg-[#C43E00] transition-colors">Share my entry</button>
            </div>
          </>
        ) : (
          <div className="text-center py-2" data-testid="entry-confirmation">
            <div className="w-12 h-12 mx-auto rounded-full bg-[#f5ece4] text-[#C43E00] flex items-center justify-center mb-4">
              <CheckCircle size={28} weight="fill" />
            </div>
            <h3 className="text-xl font-bold text-[#2c2a29] mb-2">Thanks for sharing!</h3>
            <p className="text-sm text-[#4a4643] leading-relaxed mb-5">
              Your entry is under review — you'll earn your {challenge.points} points the moment it's published. Until then it's only visible to you on your profile.
            </p>
            <button data-testid="btn-entry-done" onClick={onClose} className="w-full py-2.5 rounded-lg bg-[#2c2a29] text-white text-sm font-bold hover:bg-[#1a1918] transition-colors">Done</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/* Static mirror of the member app's events calendar (BI preview only —
   RSVPs, calendar files and gated access live in the member app). */
// Capacity figures mirror the member app's seeded baselines (Aug 2026:
// spot counts are public product surface — "18 of 30 spots taken").
const EVENTS = [
  { id: "galleria-styling-evening", day: 28, mon: "Aug", kicker: "Styling Evening", title: "An Evening of Styling at Galleria", when: "Fri 28 Aug · 5:30 – 7:30 PM EAT", venue: "Vivo, Galleria Mall", cap: 30, taken: 18, blurb: "Our stylists walk you through the new season — what to pair, how to layer, and the fits that flatter. Bring a friend; leave with a look." },
  { id: "junction-perfect-fit", day: 12, mon: "Sep", kicker: "Fit Workshop", title: "The Perfect Fit: A Tailoring Afternoon", when: "Sat 12 Sep · 2:00 – 4:30 PM EAT", venue: "Vivo, The Junction Mall", cap: 25, taken: 21, blurb: "Meet the tailors behind our new in-store service. Live demos on hems, waists and straps — and how the smallest changes make a piece completely yours." },
  { id: "myvivostory-photo-afternoon", day: 26, mon: "Sep", kicker: "Community Meet-up", title: "#MyVivoStory Meet-up & Photo Afternoon", when: "Sat 26 Sep · 2:00 – 5:00 PM EAT", venue: "Vivo, Moi Avenue", cap: 40, taken: 12, blurb: "Meet the community behind the hashtag. Portraits by our photographer in the refreshed store, stylists on hand, and stories worth sharing." },
  { id: "new-collection-first-look", day: 8, mon: "Oct", kicker: "Members' Evening", title: "New Collection: The First Look", when: "Thu 8 Oct · 6:00 – 8:00 PM EAT", venue: "Vivo, The Junction Mall", cap: 25, taken: 19, blurb: "The new collection on the rails a week before anyone else sees it — first pick, light bites, and the designers in the room.", gated: true },
  { id: "fifteen-years-celebration", day: 24, mon: "Oct", kicker: "Celebration", title: "Fifteen Years of Vivo: The Big One", when: "Sat 24 Oct · 4:00 – 8:00 PM EAT", venue: "Sarit Centre Expo Hall", cap: 60, taken: 60, blurb: "Fifteen years of dressing her boldly deserves a party. Music, a lookback at the collections that made us, and a toast to the women who wore them." },
];

export default function TabCommunity() {
  const [subTab, setSubTab] = useState("feed");
  const [followed, setFollowed] = useState({});
  const [entryFor, setEntryFor] = useState(null);
  const [entered, setEntered] = useState({});
  
  const SUB_TABS = [
    { id: "feed", label: "Feed" },
    { id: "events", label: "Events" },
    { id: "challenges", label: "Challenges" },
    { id: "leaderboard", label: "Leaderboard" },
    { id: "style_boards", label: "Style Boards" },
  ];

  return (
    <div className="animate-in fade-in duration-500">
      {/* Sub Tabs */}
      <div className="flex gap-4 sm:gap-8 border-b border-[#e8dfd5] mb-8 overflow-x-auto hide-scrollbar">
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`py-3 text-sm font-bold whitespace-nowrap transition-colors border-b-2 ${
              subTab === t.id ? "border-[#2c2a29] text-[#2c2a29]" : "border-transparent text-[#a8a199] hover:text-[#4a4643]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      
      {/* Feed SubTab */}
      {subTab === "feed" && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {posts.map(p => <GridPost key={p.id} post={p} slotId={`community-feed-${p.id}`} />)}
          {posts.map(p => <GridPost key={p.id + 'dup'} post={{...p, likes: p.likes + 10}} slotId={`community-feed-${p.id}-alt`} />)}
        </div>
      )}
      
      {/* Events SubTab — static preview; RSVP flows live in the member app */}
      {subTab === "events" && (
        <div data-testid="community-events" className="max-w-3xl space-y-6">
          <p className="text-sm text-[#7a746e] leading-relaxed max-w-2xl">
            Styling evenings, workshops and celebrations — in our stores, for our members.
            Every event has a fixed number of spots; members tap a thumbnail for the full
            detail page, where RSVPs, waitlists and "add to calendar" live. Read-only preview.
          </p>
          {EVENTS.map((ev) => (
            <div key={ev.id} data-testid={`event-${ev.id}`} className="bg-white rounded border border-[#e8dfd5] p-5 sm:p-6 flex items-start gap-5">
              <div className="w-14 h-14 rounded bg-[#2c2a29] text-[#faf8f5] flex flex-col items-center justify-center shrink-0">
                <span className="font-serif text-xl leading-none">{ev.day}</span>
                <span className="text-[8px] font-bold uppercase tracking-widest opacity-75 mt-1">{ev.mon}</span>
              </div>
              <img
                src={`/app/events/${ev.id}.jpg`}
                alt=""
                loading="lazy"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                className="hidden sm:block w-28 h-[72px] rounded object-cover shrink-0"
              />
              <div className="flex-grow min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#C43E00] mb-1">
                  {ev.kicker}{ev.gated ? " · Tanzanite & invitation holders" : ""}
                </div>
                <h3 className="font-serif text-lg text-[#2c2a29] leading-snug mb-1">{ev.title}</h3>
                <div className="text-[12px] text-[#7a746e] mb-2">{ev.when} · {ev.venue}</div>
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="h-1 w-32 rounded-full bg-[#f0e9e1] overflow-hidden shrink-0">
                    <div
                      className={`h-full rounded-full ${ev.taken >= ev.cap ? "bg-[#b7b0a8]" : "bg-[#C43E00]"}`}
                      style={{ width: `${Math.min(100, Math.round((ev.taken / ev.cap) * 100))}%` }}
                    />
                  </div>
                  <span className="text-[11px] font-semibold text-[#7a746e]">
                    {ev.taken >= ev.cap ? "Fully booked — waitlist open" : `${ev.taken} of ${ev.cap} spots taken`}
                  </span>
                </div>
                <p className="text-[13px] text-[#7a746e] leading-relaxed">{ev.blurb}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Challenges SubTab */}
      {subTab === "challenges" && (
        <div className="space-y-8">
          <div>
            <p data-testid="challenges-review-note" className="text-sm text-[#7a746e] leading-relaxed max-w-2xl mb-6">
              Every entry is reviewed with love before it goes live — your points are added the moment your entry is published.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {challenges.map(c => (
                <div key={c.id} className="bg-white p-6 rounded-2xl shadow-[0_2px_10px_rgba(44,42,41,0.04)] border border-[#f0e9e1] flex flex-col">
                  <div className="flex justify-between items-start mb-3 gap-3">
                    <h3 className="text-xl font-bold text-[#2c2a29]">{c.title}</h3>
                    <span className="bg-[#f5ece4] text-[#C43E00] text-[11px] leading-snug font-bold px-2.5 py-1.5 rounded shrink-0 max-w-[120px] text-center">Earn {c.points} pts when published</span>
                  </div>
                  <p className="text-[#4a4643] text-sm mb-6 flex-grow">{c.description}</p>
                  <div className="flex items-center justify-between mt-auto pt-4 border-t border-[#f0e9e1]">
                    <div className="flex items-center gap-3 text-xs font-medium text-[#7a746e]">
                      <span>⏳ {c.deadline}</span>
                      <span>•</span>
                      <span className="flex items-center gap-1"><Users size={14}/> {c.entries} entries</span>
                    </div>
                    {entered[c.id] ? (
                      <span data-testid={`entered-${c.id}`} className="inline-flex items-center gap-1.5 text-xs font-bold text-[#7a746e] bg-[#f5ece4] px-3 py-2 rounded-lg whitespace-nowrap">
                        <Clock size={14} /> Entered — in review
                      </span>
                    ) : (
                      <button data-testid={`enter-${c.id}`} onClick={() => setEntryFor(c)} className="bg-[#FE5000] text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-[#C43E00] transition-colors">
                        Enter Challenge
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div>
            <h3 className="text-lg font-bold text-[#2c2a29] mb-4">Past Winners</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { username: "achieng.o", initials: "AO", tier: "Ruby", showTier: false },
                { username: "wanjiku.m", initials: "WM", tier: "Tanzanite", showTier: false },
                { username: "makena_w", initials: "MW", tier: "Tanzanite", showTier: true },
              ].map((w) => (
                <div key={w.username} className="bg-[#f5ece4] rounded-xl p-4 flex items-center gap-4">
                  {/* Privacy: username only; tier styling is opt-in */}
                  <Avatar initials={w.initials} tier={w.showTier ? w.tier : undefined} />
                  <div>
                    <div className="font-bold text-sm text-[#2c2a29]">@{w.username}</div>
                    <div className="text-xs text-[#7a746e]">Won "Style It 3 Ways" · 150 pts</div>
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
          <div className="bg-white rounded-2xl shadow-sm border border-[#f0e9e1] overflow-hidden">
            <div className="p-6 bg-gradient-to-r from-[#ebdcd0] to-[#f5ece4] border-b border-[#e8dfd5]">
              <h2 className="text-xl font-bold text-[#2c2a29] flex items-center gap-2">
                <Trophy weight="fill" className="text-[#C43E00]" /> Weekly Top Contributors
              </h2>
              <p className="text-[#7a746e] text-sm mt-1">Points are awarded as your posts, comments and challenge entries are published.</p>
            </div>
            <div className="divide-y divide-[#f0e9e1]">
              {leaderboard.map((user, idx) => (
                <div key={user.username} className={`flex items-center justify-between p-4 sm:p-6 transition-colors hover:bg-[#faf8f5] ${idx < 3 ? 'bg-[#fcfaf8]' : ''}`}>
                  <div className="flex items-center gap-4 sm:gap-6">
                    <div className={`text-lg font-bold w-6 text-center ${idx === 0 ? 'text-[#d4af37]' : idx === 1 ? 'text-[#c0c0c0]' : idx === 2 ? 'text-[#cd7f32]' : 'text-[#a8a199]'}`}>
                      #{user.rank}
                    </div>
                    {/* Privacy: username only; tier badge is opt-in */}
                    <Avatar initials={user.initials} tier={user.showTier ? user.tier : undefined} size="md" />
                    <div>
                      <div className="font-bold text-[#2c2a29] text-sm sm:text-base">@{user.username}</div>
                      {user.showTier && <TierBadge tier={user.tier} className="mt-1" />}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[#2c2a29] font-bold">{user.contributions}</div>
                    <div className="text-xs font-normal text-[#a8a199] uppercase tracking-wide">contributions</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Style Boards SubTab */}
      {subTab === "style_boards" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {styleBoards.map((board) => (
            <div key={board.id} className="bg-white rounded-2xl shadow-sm overflow-hidden border border-[#f0e9e1] group">
              <div className="grid grid-cols-2 grid-rows-2 h-48 gap-0.5 bg-[#e8dfd5] p-0.5">
                <ImagePlaceholder className="rounded-none h-full w-full" aspectRatio="aspect-auto" slotId={`community-board-${board.id}-tile-1`} />
                <ImagePlaceholder className="rounded-none h-full w-full" aspectRatio="aspect-auto" slotId={`community-board-${board.id}-tile-2`} />
                <ImagePlaceholder className="rounded-none h-full w-full col-span-2" aspectRatio="aspect-auto" slotId={`community-board-${board.id}-tile-3`} />
              </div>
              <div className="p-5 flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-[#2c2a29] mb-1">{board.title}</h3>
                  <div className="text-xs text-[#7a746e]">{board.items} items • {board.followers} followers</div>
                </div>
                <button
                  data-testid="follow-btn"
                  onClick={() => setFollowed(f => ({ ...f, [board.id]: !f[board.id] }))}
                  className={`text-xs font-bold px-3 py-1.5 rounded-full transition-colors ${
                    followed[board.id]
                      ? "bg-[#FE5000] text-white"
                      : "text-[#C43E00] bg-[#f5ece4] hover:bg-[#FE5000] hover:text-white"
                  }`}
                >
                  {followed[board.id] ? "Following" : "+ Follow"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <EntryModal challenge={entryFor} onClose={() => setEntryFor(null)} onSubmitted={(id) => setEntered((s) => ({ ...s, [id]: true }))} />
    </div>
  );
}