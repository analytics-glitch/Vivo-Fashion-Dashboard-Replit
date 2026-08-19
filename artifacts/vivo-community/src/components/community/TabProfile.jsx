import React, { useEffect, useRef, useState } from 'react';
import { api } from "@/lib/api";
import { TierBadge, Avatar, cardCls, btnSecondary, inputCls } from "./ui";
import { MapPin, Package, ArrowRight, LogOut, Camera, Ruler, Check, Loader2, ShieldCheck, AtSign, Clock, Heart, ChevronRight, Hourglass, Trophy } from "lucide-react";
import { useWishlist } from "@/context/WishlistContext";
import EntryModal, { ENTRY_STATUS_COPY } from "./EntryModal";
import { StylePrefsProfileCard } from "./StyledForYou";
import RewardsSummaryCard, { WeeklyMissionsCard } from "./RewardsSummaryCard";

const WIN_LABEL = { 1: "1st place", 2: "2nd place", 3: "3rd place" };

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(String(iso).includes("T") ? iso : iso + "T00:00:00").toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch {
    return iso;
  }
}

function Toggle({ checked, onChange, disabled, testId, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-11 h-6 mt-0.5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50 ${checked ? "bg-primary" : "bg-border"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-background shadow-sm transition-transform duration-200 ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

function SavedTick({ show }) {
  if (!show) return null;
  return <span className="text-primary-ink inline-flex items-center gap-1 text-xs font-medium"><Check size={13} /> Saved</span>;
}

function UsernameStatus({ check, dirty, onPick }) {
  if (!dirty) return <div className="text-[13px] text-muted-foreground">This is your current username.</div>;
  if (check.state === "checking") {
    return <div data-testid="username-status" className="text-[13px] text-muted-foreground flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" /> Checking availability…</div>;
  }
  if (check.state === "ok") {
    return <div data-testid="username-status" className="text-[13px] text-primary-ink flex items-center gap-1.5"><Check size={14} /> Available</div>;
  }
  if (check.state === "taken" || check.state === "invalid") {
    return (
      <div data-testid="username-status" className="space-y-2">
        <div className="text-[13px] text-destructive">{check.message}</div>
        {check.suggestions?.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {check.suggestions.map((s) => (
              <button key={s} type="button" data-testid={`suggestion-${s}`} onClick={() => onPick(s)}
                className="text-xs font-medium border border-border rounded-full px-3 py-1.5 hover:bg-secondary transition-colors text-foreground">
                @{s}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return null;
}

function PrivacySettings({ member, onMemberUpdate }) {
  const m = member || {};
  const [editing, setEditing] = useState(false);
  const [uname, setUname] = useState(m.username || "");
  const [check, setCheck] = useState({ state: "idle" });
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const liveRef = useRef("");

  useEffect(() => {
    if (!editing) { setUname(m.username || ""); setCheck({ state: "idle" }); }
  }, [m.username, editing]);

  const dirty = uname !== (m.username || "");

  useEffect(() => {
    if (!editing || !dirty) { setCheck({ state: "idle" }); return; }
    if (uname.length < 3) { setCheck({ state: "invalid", message: "Usernames are 3–20 characters" }); return; }
    setCheck({ state: "checking" });
    const u = uname;
    const t = setTimeout(() => {
      api.usernameCheck(u)
        .then((d) => {
          if (liveRef.current !== u) return;
          if (d.available) setCheck({ state: "ok" });
          else setCheck({ state: d.valid ? "taken" : "invalid", message: d.message, suggestions: d.suggestions || [] });
        })
        .catch(() => setCheck({ state: "idle" }));
    }, 400);
    return () => clearTimeout(t);
  }, [uname, editing, dirty]);

  const save = async (patch, key) => {
    setBusy(key); setError(""); setSaved("");
    try {
      const d = await api.updateSettings(patch);
      onMemberUpdate?.(d.member);
      setSaved(key);
      setTimeout(() => setSaved((s) => (s === key ? "" : s)), 2200);
      return true;
    } catch (e) {
      if (e.detail?.code === "username_taken") {
        setCheck({ state: "taken", message: e.detail.message, suggestions: e.detail.suggestions || [] });
      } else {
        setError(e.message);
      }
      return false;
    } finally {
      setBusy("");
    }
  };

  const saveUsername = async () => {
    if (await save({ username: uname }, "username")) setEditing(false);
  };

  return (
    <div className={`${cardCls} overflow-hidden`} data-testid="privacy-settings">
      <div className="p-5 border-b border-border bg-secondary/40">
        <h3 className="font-serif text-lg text-foreground flex items-center gap-2 mb-1">
          <ShieldCheck size={18} strokeWidth={1.5} className="text-primary-ink" /> Privacy
        </h3>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          You control what other members see. Your real name, phone number and points balance are always private — only you see those.
        </p>
      </div>

      {/* Username */}
      <div className="p-5 border-b border-border">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <div className="text-[13px] font-semibold text-foreground flex items-center gap-2">Username <SavedTick show={saved === "username"} /></div>
          {!editing && (
            <button data-testid="privacy-username-edit" onClick={() => { setEditing(true); liveRef.current = m.username || ""; }}
              className="text-[13px] font-medium text-primary-ink hover:opacity-80 transition-opacity">
              Change
            </button>
          )}
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed mb-3">
          The name other members see on anything you share — posts, comments, boards and challenge entries.
        </p>
        {!editing ? (
          <div data-testid="privacy-username-display" className="inline-flex items-center gap-1 bg-secondary border border-border rounded px-3 py-2 text-[14px] font-medium text-foreground">
            <AtSign size={14} className="text-muted-foreground" />{m.username || "—"}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground text-[15px]" aria-hidden="true">@</span>
              <input
                data-testid="privacy-username-input"
                type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                aria-label="Username"
                value={uname}
                onChange={(e) => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20); liveRef.current = v; setUname(v); }}
                className={`${inputCls} w-full pl-9`}
              />
            </div>
            <UsernameStatus check={check} dirty={dirty} onPick={(s) => { liveRef.current = s; setUname(s); }} />
            <div className="flex gap-2">
              <button data-testid="privacy-username-save" onClick={saveUsername}
                disabled={!dirty || check.state !== "ok" || busy === "username"}
                className="h-10 px-5 rounded bg-primary text-primary-foreground text-[13px] font-medium disabled:opacity-40 disabled:pointer-events-none hover:opacity-90 transition-opacity flex items-center gap-2">
                {busy === "username" && <Loader2 size={14} className="animate-spin" />} Save
              </button>
              <button onClick={() => { setEditing(false); setError(""); }}
                className="h-10 px-5 rounded border border-border text-[13px] font-medium text-foreground hover:bg-secondary transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tier badge visibility */}
      <div className="p-5 border-b border-border flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-semibold text-foreground mb-1 flex items-center gap-2">Show my tier badge <SavedTick show={saved === "show_tier"} /></div>
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Adds your Tsavorite, Ruby or Tanzanite gem beside your username on posts and celebrations. Off means only you see your tier.
          </p>
        </div>
        <Toggle checked={!!m.show_tier} disabled={busy === "show_tier"} testId="toggle-show-tier"
          label="Show my tier badge on my posts and celebrations"
          onChange={(v) => save({ show_tier: v }, "show_tier")} />
      </div>

      {/* Celebration visibility */}
      <div className="p-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-semibold text-foreground mb-1 flex items-center gap-2">Appear in community celebrations <SavedTick show={saved === "show_leaderboard"} /></div>
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            When this is off, we never feature you on the celebration wall — jewel of the week, weekly celebrations or winner spotlights. Your activity still earns points — privately.
          </p>
        </div>
        <Toggle checked={m.show_leaderboard !== false} disabled={busy === "show_leaderboard"} testId="toggle-show-leaderboard"
          label="Appear in community celebrations"
          onChange={(v) => save({ show_leaderboard: v }, "show_leaderboard")} />
      </div>

      {error && <div className="px-5 pb-5 text-[13px] text-destructive">{error}</div>}
    </div>
  );
}

export default function TabProfile({ member, onSignOut, onMemberUpdate, onOpenWishlist, onOpenPage, onOpenEvents, onOpenEvent, onOpenQuiz }) {
  const { count: wishCount } = useWishlist();
  const [shareOpen, setShareOpen] = useState(false);
  // Live style journal — everything she's shared, pending or published.
  const [myEntries, setMyEntries] = useState([]);
  const loadEntries = () =>
    api.myEntries().then((d) => setMyEntries(d.items || [])).catch(() => {});
  useEffect(() => { loadEntries(); }, []);

  // Upcoming events where this member holds a spot — confirmed RSVPs and
  // waitlist places alike. Quiet on failure — the Events tab owns
  // loading/error states; this card is a gentle mirror.
  const [myEvents, setMyEvents] = useState([]);
  useEffect(() => {
    let on = true;
    api.events()
      .then((d) => {
        if (on) setMyEvents((d.items || []).filter((e) => ["confirmed", "waitlisted"].includes(e.my_rsvp?.status)));
      })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  const m = member || {};
  const stats = m.stats || {};
  const orders = m.recent_orders || [];

  return (
    <div className="animate-in fade-in duration-500 max-w-5xl mx-auto">
      {/* Johari rewards summary — moved here from the Rewards tab so her
          balance and tier greet her first on the Account page. */}
      <div className="mb-10 space-y-10">
        <RewardsSummaryCard member={member} />
        <WeeklyMissionsCard />
      </div>
      {/* Profile header — editorial charcoal band matching the Rewards hero,
          with the Style DNA / quiz block on the cream ground beneath it. */}
      <div className="mb-10 rounded overflow-hidden -mx-4 sm:mx-0">
        <div className="relative bg-foreground text-background p-6 sm:p-10 overflow-hidden">
          <div className="absolute top-0 right-0 w-52 h-52 bg-white/5 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />

          <div className="relative flex flex-col md:flex-row items-center md:items-start gap-6 md:gap-8 z-10">
            <Avatar initials={m.initials || "V"} tier={m.tier} size="lg" />

            <div className="flex-grow text-center md:text-left flex flex-col items-center md:items-start">
              <div className="flex flex-col md:flex-row md:items-center gap-3 mb-2">
                <h1 data-testid="profile-name" className="text-3xl font-serif text-background">{m.name || "Vivo Member"}</h1>
                <TierBadge tier={m.tier} className="self-center" />
              </div>

              {m.username && (
                <div data-testid="profile-username" className="text-sm text-background/70 mb-3 flex items-center gap-1">
                  <AtSign size={13} />{m.username}
                  <span className="opacity-60 ml-1">· what members see · your name stays private</span>
                </div>
              )}

              <div className="text-background/70 text-sm flex flex-wrap items-center justify-center md:justify-start gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5"><MapPin size={14} /> {stats.city || "Kenya"}</span>
                <span className="opacity-40">•</span>
                <span>Member since {m.joined || "today"}</span>
              </div>
            </div>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-4 gap-4 mt-8 pt-6 border-t border-white/15 text-center relative z-10">
            <div>
              <div data-testid="profile-posts" className="text-2xl font-serif text-background">{myEntries.filter((e) => e.entry_status === "published").length}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mt-2">Posts</div>
            </div>
            <div>
              <div data-testid="profile-points" className="text-2xl font-serif text-primary">{(m.lifetime_points ?? 0).toLocaleString()}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mt-2">Lifetime Pts</div>
            </div>
            <div>
              <div data-testid="profile-orders" className="text-2xl font-serif text-background">{stats.orders ?? 0}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mt-2">Orders</div>
            </div>
            <div>
              <div className="text-2xl font-serif text-background">0</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-background/60 mt-2">Following</div>
            </div>
          </div>
        </div>

        {/* Size + Style DNA strip on the cream ground */}
        <div className="pt-6 px-1 sm:px-0 flex flex-col items-center md:items-start">

            {stats.preferred_size && (
              <div className="inline-flex items-center gap-1.5 bg-secondary text-foreground text-xs font-medium px-3 py-1.5 rounded border border-border mb-6">
                <Ruler size={14} className="text-muted-foreground" /> Preferred size: {stats.preferred_size}
              </div>
            )}

            {/* Style DNA (from the server-composed quiz) or the quiz CTA */}
            {!m.quiz_completed ? (
              <div className="bg-secondary/50 p-5 rounded border border-border text-left w-full md:w-auto">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                  <div>
                    <div className="font-semibold text-[15px] text-foreground mb-1">Find your Style DNA</div>
                    <div className="text-[13px] text-muted-foreground leading-relaxed">Two minutes, a handful of easy taps — your feed starts dressing you properly, and 50 points land on your card.</div>
                  </div>
                  <button data-testid="take-quiz-btn" onClick={onOpenQuiz} className="bg-foreground text-background h-11 px-5 rounded text-[13px] font-medium flex items-center gap-2 whitespace-nowrap hover:bg-foreground/90 transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
                    Take the quiz <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row items-center md:items-start gap-4" data-testid="style-dna-chips">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground md:mt-2">Style DNA</span>
                <div className="flex flex-wrap justify-center md:justify-start items-center gap-2">
                  {(m.style_dna || []).map((dna) => (
                    <span key={dna} className="bg-background border border-border text-foreground text-xs font-medium px-3 py-1.5 rounded shadow-sm">
                      {dna}
                    </span>
                  ))}
                  <button data-testid="retake-quiz-btn" onClick={onOpenQuiz} className="text-[12px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors ml-1">
                    Retake
                  </button>
                </div>
              </div>
            )}
        </div>
      </div>

      {/* Styled for You — opt-in toggle + preference summary */}
      <div className="mb-10">
        <StylePrefsProfileCard onOpenPrefs={() => onOpenPage("styleprefs")} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        {/* My Posts Grid */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-serif text-foreground mb-6">My Style Journal</h2>
          {myEntries.length > 0 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {myEntries.map((e) => {
                  const won = (e.winner_position || 0) >= 1;
                  const title = e.challenge_title
                    ? e.challenge_title
                    : e.post_type === "question" ? "Question to the community"
                    : e.media_kind === "video" ? "Video look" : "Shared look";
                  return (
                    <div key={e.post_id} className={`${cardCls} p-5`} data-testid={`journal-entry-${e.post_id}`}>
                      <div className="flex items-center justify-between gap-3 mb-3">
                        {won ? (
                          <span data-testid={`journal-winner-${e.post_id}`} className="inline-flex items-center gap-1.5 bg-[#d1a657]/15 border border-[#d1a657]/40 text-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm">
                            <Trophy size={11} strokeWidth={2} className="text-[#d1a657]" /> {WIN_LABEL[e.winner_position] || "Winner"}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 bg-secondary border border-border text-muted-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-sm">
                            <Clock size={11} strokeWidth={2} /> {ENTRY_STATUS_COPY[e.entry_status] || "In review"}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">{fmtDate(e.created_at)}</span>
                      </div>
                      <div className="font-medium text-foreground text-[14px] mb-1">{title}</div>
                      {e.caption && <p className="text-[13px] text-muted-foreground leading-relaxed mb-3 line-clamp-2">{e.caption}</p>}
                      <p className="text-[12px] text-muted-foreground leading-relaxed border-t border-border pt-3">
                        {e.entry_status === "rejected"
                          ? "This one didn't go live — tweak it and reshare anytime, we'd love to see it again."
                          : e.entry_status === "published"
                            ? (won
                                ? "Celebrated in the community — vigelegele!"
                                : e.points > 0 ? `Live in the community — ${e.points} pts earned.` : "Live in the community.")
                            : e.points > 0
                              ? `Only you can see this while our team takes a look. You'll earn ${e.points} pts the moment it's published.`
                              : "Only you can see this while our team takes a look."}
                      </p>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
                <p className="text-[12px] text-muted-foreground leading-relaxed max-w-md">
                  We review every entry to keep the community lovely. If one doesn't go live, we'll let you know — tweak it and reshare anytime.
                </p>
                <button data-testid="share-another-look" onClick={() => setShareOpen(true)} className="bg-foreground text-background text-[13px] font-medium px-5 h-10 rounded hover:bg-foreground/90 transition-colors active:scale-[0.98] shrink-0">
                  Share another look
                </button>
              </div>
            </div>
          ) : (
            <div className={`${cardCls} border-dashed p-12 text-center bg-transparent`}>
              <div className="w-16 h-16 mx-auto rounded-full bg-secondary border border-border text-muted-foreground flex items-center justify-center mb-6">
                <Camera size={24} strokeWidth={1.5} />
              </div>
              <h3 className="font-serif text-lg text-foreground mb-2">Your journal is waiting</h3>
              <p className="text-[14px] text-muted-foreground mb-8 max-w-sm mx-auto leading-relaxed">
                Share your first look with the community and start building your style story.
              </p>
              <button data-testid="share-first-look" onClick={() => setShareOpen(true)} className="bg-foreground text-background text-[13px] font-medium px-6 h-10 rounded hover:bg-foreground/90 transition-colors active:scale-[0.98]">
                Share your first look
              </button>
              <p className="text-[11px] text-muted-foreground mt-4">
                Earn 50 pts when your photo look is published — 100 for a video. Every share is reviewed with love first.
              </p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-10">
          <button
            data-testid="profile-wishlist-link"
            onClick={onOpenWishlist}
            className={`${cardCls} w-full p-5 flex items-center gap-4 text-left hover:bg-secondary/50 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
          >
            <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
              <Heart size={18} strokeWidth={1.5} />
            </span>
            <span className="flex-grow min-w-0">
              <span className="block font-medium text-foreground text-[15px]">My Wishlist</span>
              <span className="block text-[13px] text-muted-foreground mt-0.5">
                {wishCount > 0
                  ? `${wishCount} piece${wishCount > 1 ? "s" : ""} saved`
                  : "Pieces you love, saved for later"}
              </span>
            </span>
            <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
          </button>
          <div>
            <h2 className="text-xl font-serif text-foreground mb-6 flex items-center gap-2">
               Recent Orders
            </h2>
            <div className={`${cardCls} overflow-hidden divide-y divide-border`}>
              {orders.map(o => (
                <div key={o.order} className="p-5 hover:bg-secondary/50 transition-colors cursor-pointer group">
                  <div className="flex justify-between items-start mb-3">
                    <div className="font-medium text-foreground text-[14px] group-hover:text-primary-ink transition-colors">{o.order}</div>
                    <div className="text-primary-ink font-medium text-[13px]">+{o.pts} pts</div>
                  </div>
                  {o.styles && (
                    <div className="text-[11px] text-muted-foreground -mt-2 mb-3 truncate">
                      Style{String(o.styles).includes(",") ? "s" : ""} {o.styles}
                    </div>
                  )}
                  <div className="flex justify-between items-end text-[12px]">
                    <div className="text-muted-foreground flex items-center gap-1.5"><Package size={14} /> {fmtDate(o.date)}</div>
                    <div className="font-medium text-foreground">KES {Math.round(o.total_kes).toLocaleString()}</div>
                  </div>
                </div>
              ))}
              {orders.length === 0 && (
                <div className="p-8 text-center text-[13px] text-muted-foreground leading-relaxed">
                  No purchases yet. Shop with your phone number in store and they'll appear here.
                </div>
              )}
            </div>
          </div>

          {/* My events — upcoming RSVPs from the events calendar */}
          <div className={`${cardCls} overflow-hidden`} data-testid="profile-events">
            <div className="p-5 border-b border-border flex items-center justify-between gap-4">
              <h3 className="font-serif text-lg text-foreground">My Events</h3>
              <button
                data-testid="profile-events-all"
                onClick={() => onOpenEvents?.()}
                className="text-[12px] font-semibold uppercase tracking-wider text-primary-ink hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                See what's on
              </button>
            </div>
            {myEvents.length > 0 ? (
              <div className="divide-y divide-border">
                {myEvents.map((ev) => (
                  <button
                    key={ev.id}
                    data-testid={`profile-event-${ev.id}`}
                    onClick={() => (onOpenEvent ? onOpenEvent(ev.id) : onOpenEvents?.())}
                    className="w-full p-5 flex items-center gap-4 text-left hover:bg-secondary/50 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                  >
                    <span className="w-12 h-12 rounded bg-foreground text-background flex flex-col items-center justify-center shrink-0">
                      <span className="font-serif text-lg leading-none">{ev.day_num}</span>
                      <span className="text-[8px] font-bold uppercase tracking-widest opacity-75 mt-0.5">{ev.month_abbr}</span>
                    </span>
                    <span className="flex-grow min-w-0">
                      <span className="block text-[14px] font-medium text-foreground truncate group-hover:text-primary-ink transition-colors">{ev.title}</span>
                      <span className="block text-[12px] text-muted-foreground mt-0.5">{ev.date_label} · {ev.venue}</span>
                      {ev.my_rsvp?.status === "waitlisted" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground mt-1">
                          <Hourglass size={11} strokeWidth={2} /> #{ev.my_rsvp.position} on the waitlist
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary-ink mt-1">
                          <Check size={11} strokeWidth={2.5} /> You&apos;re in
                        </span>
                      )}
                    </span>
                    <ChevronRight size={15} className="text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-6 text-[13px] text-muted-foreground leading-relaxed">
                Nothing on your calendar yet. Styling evenings, workshops and celebrations all live under{" "}
                <button data-testid="profile-events-empty-link" onClick={() => onOpenEvents?.()} className="font-medium text-primary-ink hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Events</button>
                {" "}— come see what's on.
              </div>
            )}
          </div>

          <PrivacySettings member={m} onMemberUpdate={onMemberUpdate} />

          {/* My data (DPA): one place to see, delete and control everything she's uploaded */}
          <div className={`${cardCls} overflow-hidden`} data-testid="mydata-card">
            <button
              type="button"
              data-testid="profile-mydata-link"
              onClick={() => onOpenPage?.("mydata")}
              className="w-full p-5 flex items-center gap-4 text-left hover:bg-secondary/50 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
            >
              <span className="flex-grow min-w-0">
                <span className="block text-[14px] font-medium text-foreground group-hover:text-primary-ink transition-colors">My data</span>
                <span className="block text-[12px] text-muted-foreground mt-0.5">
                  See, delete or download everything you&apos;ve shared — and control marketing use of it.
                </span>
              </span>
              <ChevronRight size={15} className="text-muted-foreground shrink-0" />
            </button>
          </div>

          <button
            data-testid="btn-signout"
            onClick={onSignOut}
            className={`${btnSecondary} text-muted-foreground hover:text-destructive hover:border-destructive hover:bg-destructive/5`}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </div>

      {shareOpen && (
        <EntryModal
          postType="look"
          onClose={() => setShareOpen(false)}
          onSubmitted={loadEntries}
        />
      )}

    </div>
  );
}