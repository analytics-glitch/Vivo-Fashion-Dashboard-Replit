import React, { useEffect, useState } from "react";
import {
  ArrowLeft, Clock, Users, Trophy, Check, Vote as VoteIcon, Camera,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthImage } from "./authImage";
import { Avatar, cardCls, btnPrimary } from "./ui";
import { PostVisual } from "./PostBits";
import PostDetailModal from "./PostDetailModal";
import EntryModal from "./EntryModal";

/* Challenge detail — opened from any challenge card. The entries gallery
   is browsable by everyone; entries are real feed posts, so tapping one
   opens the same PostDetailModal with live likes and comments. A member's
   own pending entry appears here (pinned first) visible only to her. */

const WINNER_LABEL = { 1: "Winner", 2: "2nd place", 3: "3rd place" };

function daysLeftLabel(deadlineIso) {
  const ms = new Date(deadlineIso).getTime() - Date.now();
  const days = Math.ceil(ms / 86400000);
  if (days <= 0) return "Closing today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

/* Gallery tile — real photo (member-gated fetch) when the entry has one,
   otherwise the same placeholder visual language as the feed. */
function EntryTile({ entry, votingOn, onOpen }) {
  // cache:false — moderation can unpublish; pixels must not outlive the tile
  const url = useAuthImage(entry.has_photo ? entry.photo_path : null, { cache: false });
  const pending = entry.entry_status === "pending";
  return (
    <button
      type="button"
      onPointerDown={(e) => e.preventDefault()}
      onClick={onOpen}
      data-testid={`entry-tile-${entry.id}`}
      aria-label={`Open entry by @${entry.author.username}`}
      className="bg-card rounded overflow-hidden shadow-sm hover:shadow-md transition-shadow group cursor-pointer relative border border-border block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {entry.has_photo ? (
        <div className="aspect-[4/5] bg-secondary">
          {url ? (
            entry.media_kind === "video" ? (
              <video src={url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
            ) : (
              <img src={url} alt={`Entry by @${entry.author.username}`} loading="lazy" className="w-full h-full object-cover" />
            )
          ) : (
            <div className="w-full h-full animate-pulse" />
          )}
        </div>
      ) : (
        <PostVisual post={entry} className="mb-0 rounded-none border-none aspect-[4/5]" />
      )}
      {entry.winner_position && (
        <span
          data-testid={`winner-ribbon-${entry.id}`}
          className="absolute top-2 left-2 inline-flex items-center gap-1 bg-foreground/90 text-background text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded"
        >
          <Trophy size={10} strokeWidth={2} /> {WINNER_LABEL[entry.winner_position]}
        </span>
      )}
      {pending && (
        <span
          data-testid={`pending-pill-${entry.id}`}
          className="absolute top-2 left-2 inline-flex items-center gap-1 bg-background/95 text-foreground border border-border text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded"
        >
          <Clock size={10} strokeWidth={2} /> In review — only you
        </span>
      )}
      <div className="p-2.5 flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted-foreground truncate">@{entry.author.username}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">♥ {entry.like_count}</span>
      </div>
    </button>
  );
}

export default function ChallengeDetail({ challengeId, initialEntryId, onBack, onOpenProduct }) {
  const [data, setData] = useState(null); // null = loading
  const [err, setErr] = useState("");
  const [entryOpen, setEntryOpen] = useState(false);
  const [detailIdx, setDetailIdx] = useState(-1);
  const [restoreY, setRestoreY] = useState(0);
  const [openedInitial, setOpenedInitial] = useState(false);

  const load = () => {
    setErr("");
    api.challenge(challengeId)
      .then(setData)
      .catch((e) => setErr(e.message || "This challenge couldn't load"));
  };
  useEffect(() => { setData(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [challengeId]);

  // Winner-card taps land straight on that entry in the gallery modal.
  useEffect(() => {
    if (!data || !initialEntryId || openedInitial) return;
    const idx = (data.entries || []).findIndex((e) => e.id === initialEntryId);
    if (idx >= 0) { setRestoreY(window.scrollY); setDetailIdx(idx); }
    setOpenedInitial(true);
  }, [data, initialEntryId, openedInitial]);

  const patchEntry = (id, patch) =>
    setData((d) => (d ? { ...d, entries: d.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) } : d));

  const handleVote = (post) =>
    api.challengeVote(challengeId, post.id)
      .then((r) => setData((d) => (d ? {
        ...d,
        my_vote: r.my_vote,
        entries: d.entries.map((e) => ({ ...e, my_vote: r.my_vote === e.id })),
      } : d)))
      .catch(() => {});

  if (err) {
    return (
      <div className="animate-in fade-in duration-300">
        <button type="button" onClick={onBack} data-testid="challenge-back"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6">
          <ArrowLeft size={15} /> Challenges
        </button>
        <div className={`${cardCls} p-8 text-center`}>
          <p className="text-[14px] text-muted-foreground mb-4">{err}</p>
          <button type="button" onClick={load} className="bg-foreground text-background text-[13px] font-medium px-5 h-10 rounded hover:bg-foreground/90 transition-colors">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="animate-in fade-in duration-300" data-testid="challenge-loading">
        <div className="h-4 w-28 bg-secondary rounded animate-pulse mb-8" />
        <div className="h-40 bg-secondary rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="aspect-[4/5] bg-secondary rounded animate-pulse" />)}
        </div>
      </div>
    );
  }

  const mine = data.my_entry;
  const votingOn = data.voting_enabled && !data.closed;

  return (
    <div className="animate-in fade-in duration-300" data-testid={`challenge-detail-${data.id}`}>
      <button type="button" onClick={onBack} data-testid="challenge-back"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6">
        <ArrowLeft size={15} /> Challenges
      </button>

      {/* Header */}
      <div className={`${cardCls} p-6 sm:p-8 mb-8`}>
        <div className="flex justify-between items-start gap-4 mb-3 flex-wrap">
          <h2 className="text-2xl sm:text-3xl font-serif text-foreground leading-tight">{data.title}</h2>
          <span className="bg-primary/10 text-primary-ink border border-primary/20 text-[10px] font-semibold leading-snug px-2.5 py-1.5 rounded-sm shrink-0 max-w-[130px] text-center">
            Earn {data.points} pts when published
          </span>
        </div>
        <p className="text-muted-foreground text-[15px] leading-relaxed max-w-2xl mb-5">{data.description}</p>
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground flex-wrap mb-5">
          {data.closed ? (
            <span data-testid="challenge-closed-chip" className="inline-flex items-center gap-1.5 bg-secondary border border-border text-foreground px-2.5 py-1.5 rounded-sm font-semibold">
              Challenge closed
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-primary" /> {daysLeftLabel(data.deadline)}</span>
          )}
          <span className="flex items-center gap-1.5" data-testid="challenge-entry-count"><Users size={14} /> {data.entries_display} entries</span>
          {data.voting_enabled && (
            <span className="flex items-center gap-1.5" data-testid="voting-chip">
              <VoteIcon size={14} />
              {data.closed
                ? "Community voting — closed"
                : `Voting open until ${new Date(data.deadline).toLocaleDateString("en-KE", { day: "numeric", month: "long" })}`}
            </span>
          )}
          {data.prize && <span className="flex items-center gap-1.5"><Trophy size={14} /> {data.prize}</span>}
        </div>

        {/* How to enter */}
        <div className="bg-secondary/50 border border-border rounded p-4 mb-5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">How it works</div>
          <p className="text-[13px] text-muted-foreground leading-relaxed">{data.rules}</p>
          <p className="text-[12px] text-muted-foreground leading-relaxed mt-2" data-testid="winner-model-copy">
            {data.deciding === "team_pick"
              ? "Winners are chosen by the Vivo team — celebrating women of every age, shape and story."
              : "Community votes shortlist the top ten, then the Vivo team chooses the winners — celebrating women of every age, shape and story."}
          </p>
        </div>

        {/* CTA states */}
        {data.closed ? (
          <div data-testid="challenge-closed-cta" className="text-[14px] font-medium text-muted-foreground">
            Entries closed — winners announced soon
          </div>
        ) : mine?.entry_status === "pending" ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span data-testid="challenge-entered-pill" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground bg-secondary border border-border px-3 h-9 rounded whitespace-nowrap">
              <Clock size={13} strokeWidth={1.5} /> Entered — in review
            </span>
            <span className="text-[12px] text-muted-foreground">Only you can see it until it goes live — your {data.points} pts land at publication.</span>
          </div>
        ) : mine?.entry_status === "published" ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span data-testid="challenge-live-pill" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-primary-ink bg-primary/10 border border-primary/20 px-3 h-9 rounded whitespace-nowrap">
              <Check size={13} strokeWidth={2} /> Your entry is live
            </span>
            <button
              type="button"
              data-testid="jump-to-my-entry"
              onClick={() => {
                const idx = data.entries.findIndex((e) => e.id === mine.post_id);
                if (idx >= 0) { setRestoreY(window.scrollY); setDetailIdx(idx); }
              }}
              className="text-[13px] font-medium text-primary-ink hover:opacity-80 underline underline-offset-2"
            >
              See it in the gallery
            </button>
          </div>
        ) : (
          <button data-testid="challenge-enter-btn" onClick={() => setEntryOpen(true)} className={`${btnPrimary} sm:w-auto`}>
            <Camera size={15} strokeWidth={1.5} /> Enter Challenge
          </button>
        )}
      </div>

      {/* Winners — closed challenges lead with the podium */}
      {data.closed && data.winners?.length > 0 && (
        <div className="mb-8" data-testid="challenge-winners">
          <h3 className="text-lg font-serif text-foreground mb-4 flex items-center gap-2">
            <Trophy size={18} className="text-primary-ink" strokeWidth={1.5} /> Winners
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {data.winners.map((w) => (
              <button
                key={w.id}
                type="button"
                data-testid={`winner-card-${w.id}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  const idx = data.entries.findIndex((e) => e.id === w.id);
                  if (idx >= 0) { setRestoreY(window.scrollY); setDetailIdx(idx); }
                }}
                className="bg-secondary rounded p-4 flex items-center gap-4 border border-border text-left hover:bg-secondary/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Avatar initials={w.author.initials} tier={w.author.show_tier ? w.author.tier : undefined} />
                <div className="min-w-0">
                  <div className="font-semibold text-[13px] text-foreground truncate">@{w.author.username}</div>
                  <div className="text-[11px] text-primary-ink font-semibold mt-1 flex items-center gap-1">
                    <Trophy size={11} strokeWidth={2} /> {WINNER_LABEL[w.winner_position]}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Gallery */}
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <h3 className="text-lg font-serif text-foreground">Everyone&apos;s entries</h3>
        {votingOn && (
          <span className="text-[12px] text-muted-foreground">Tap an entry to see it and cast your vote — one vote, you can change it anytime.</span>
        )}
      </div>
      {data.entries.length === 0 ? (
        <div className={`${cardCls} p-10 text-center text-[14px] text-muted-foreground leading-relaxed`} data-testid="entries-empty">
          No entries in the gallery yet — be the first, we&apos;d love to see yours.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6" data-testid="challenge-gallery">
          {data.entries.map((e, i) => (
            <EntryTile key={e.id} entry={e} votingOn={data.voting_enabled}
                       onOpen={() => { setRestoreY(window.scrollY); setDetailIdx(i); }} />
          ))}
        </div>
      )}

      {detailIdx >= 0 && data.entries[detailIdx] && (
        <PostDetailModal
          restoreY={restoreY}
          posts={data.entries}
          index={detailIdx}
          onIndex={setDetailIdx}
          onClose={() => setDetailIdx(-1)}
          onOpenProduct={onOpenProduct}
          onCounts={patchEntry}
          voteCtl={{ enabled: votingOn, myVote: data.my_vote, onVote: handleVote }}
        />
      )}

      <EntryModal
        challenge={entryOpen ? { ...data, kind: "challenge_api" } : null}
        onClose={() => setEntryOpen(false)}
        onSubmitted={() => load()}
      />
    </div>
  );
}
