import React, { useEffect, useState } from "react";
import { api, timeAgo } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  RefreshCw, ImageIcon, CheckCircle2, XCircle, Trophy, Camera, Video,
  Megaphone, Phone, UserRound, Sparkles, ChevronLeft,
} from "lucide-react";

// Community moderation desks for the CRM: entry review, challenge winners,
// reward redemptions. Backend: /api/crm/community-entries*,
// /api/crm/community-challenges*, /api/crm/community-redemptions*.
// Mounted from CommunityInbox so the whole community workload lives on one page.

const tabBtn = (active) =>
  `px-3 py-1.5 rounded-full text-sm border transition-colors ${
    active
      ? "bg-[var(--vivo-ink)] text-white border-[var(--vivo-ink)]"
      : "bg-white text-[var(--vivo-muted)] border-[var(--vivo-border)] hover:text-[var(--vivo-ink)]"
  }`;

/* Shared media toggle — entry photos and videos come off the same
   staff-gated blob endpoint; mime decides how we render. */
function useEntryMedia() {
  const [media, setMedia] = useState({}); // pid -> {url, video}
  const toggle = async (pid) => {
    if (media[pid]) {
      setMedia((m) => {
        const next = { ...m };
        URL.revokeObjectURL(next[pid].url);
        delete next[pid];
        return next;
      });
      return;
    }
    try {
      const { data } = await api.get(`/crm/community-entries/${pid}/photo`, { responseType: "blob" });
      setMedia((m) => ({ ...m, [pid]: { url: URL.createObjectURL(data), video: (data.type || "").startsWith("video/") } }));
    } catch {
      toast.error("Couldn't load the media");
    }
  };
  return [media, toggle];
}

function EntryMedia({ pid, media, onToggle }) {
  const m = media[pid];
  return (
    <div className="mt-2">
      <Button size="sm" variant="outline" onClick={() => onToggle(pid)} data-testid={`er-media-btn-${pid}`}>
        <ImageIcon className="h-3.5 w-3.5 mr-1" /> {m ? "Hide media" : "View media"}
      </Button>
      {m && (m.video ? (
        <video src={m.url} controls className="mt-2 max-h-80 rounded border border-[var(--vivo-border)]" data-testid={`er-media-${pid}`} />
      ) : (
        <img src={m.url} alt="Entry media" className="mt-2 max-h-80 rounded border border-[var(--vivo-border)]" data-testid={`er-media-${pid}`} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Entry review — every member share waits here before the community    */
/* sees it. Publishing is what awards points, so the copy says so.      */
/* ------------------------------------------------------------------ */

const REVIEW_TABS = [
  ["pending", "Pending"],
  ["published", "Published"],
  ["rejected", "Not published"],
];
const SCOPES = [
  ["all", "All"],
  ["challenges", "Challenge entries"],
  ["posts", "Feed posts"],
];
const TYPE_LABEL = { look: "Look", question: "Question", haul: "Haul" };

function pointsHint(it) {
  if (it.challenge_id) return `+${it.points || 0} pts on publish`;
  if (it.post_type === "question") return "Question — no points, just conversation";
  if (it.media_kind === "video") return "+100 pts on publish";
  if (it.has_photo) return "+50 pts on publish";
  return "No media — no points";
}

export function EntryReview() {
  const [tab, setTab] = useState("pending");
  const [scope, setScope] = useState("all");
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [media, toggleMedia] = useEntryMedia();

  const load = async (t = tab, sc = scope) => {
    setLoading(true);
    try {
      const { data } = await api.get("/crm/community-entries", { params: { status: t, scope: sc } });
      setItems(data.items || []);
      setCounts(data.counts || {});
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load entries");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(tab, scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope]);

  const review = async (pid, action) => {
    setBusy(pid);
    try {
      const { data } = await api.post(`/crm/community-entries/${pid}/review`, { action });
      toast.success(
        action === "publish"
          ? data.points_awarded ? "Published — points landed with the member" : "Published"
          : "Not published — the member sees a kind note in her journal"
      );
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Review failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 pt-6 mt-6 border-t border-[var(--vivo-border)]" data-testid="entry-review-section">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-[var(--vivo-ink)] flex items-center gap-2">
            <Sparkles className="h-4.5 w-4.5 text-[var(--vivo-primary)]" /> Entry review
          </h2>
          <p className="text-sm text-[var(--vivo-muted)] mt-0.5">
            Every share waits here before members see it. Publishing awards the points —
            questions never carry any.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} data-testid="er-refresh">
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap" data-testid="er-tabs">
        {REVIEW_TABS.map(([id, label]) => (
          <button key={id} data-testid={`er-tab-${id}`} onClick={() => setTab(id)} className={tabBtn(tab === id)}>
            {label}
            <span className="ml-1.5 opacity-70">{counts[id] || 0}</span>
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--vivo-border)]" />
        {SCOPES.map(([id, label]) => (
          <button key={id} data-testid={`er-scope-${id}`} onClick={() => setScope(id)} className={tabBtn(scope === id)}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="p-8 text-center text-sm text-[var(--vivo-muted)]">Loading entries…</Card>
      ) : items.length === 0 ? (
        <Card className="p-8 text-center" data-testid="er-empty">
          <CheckCircle2 className="h-8 w-8 mx-auto text-[var(--vivo-muted)] opacity-40 mb-3" />
          <p className="text-sm text-[var(--vivo-muted)]">
            {tab === "pending" ? "Queue is clear — nothing waiting on you." : "Nothing in this bucket."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((it) => (
            <Card key={it.post_id} className="p-4" data-testid={`er-item-${it.post_id}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="font-medium">
                    {it.challenge_title ? `Challenge · ${it.challenge_title}` : TYPE_LABEL[it.post_type] || "Post"}
                  </Badge>
                  {it.media_kind === "video" ? (
                    <Badge variant="outline"><Video className="h-3 w-3 mr-1" /> Video</Badge>
                  ) : it.has_photo ? (
                    <Badge variant="outline"><Camera className="h-3 w-3 mr-1" /> Photo</Badge>
                  ) : null}
                  {it.marketing_ok ? (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                      <Megaphone className="h-3 w-3 mr-1" /> Marketing OK
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[var(--vivo-muted)]">In-app only</Badge>
                  )}
                  {(it.winner_position || 0) >= 1 && (
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                      <Trophy className="h-3 w-3 mr-1" /> Winner #{it.winner_position}
                    </Badge>
                  )}
                  <span className="text-xs text-[var(--vivo-muted)]">{timeAgo(it.created_at)}</span>
                </div>
                {tab === "pending" && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={busy === it.post_id}
                      onClick={() => review(it.post_id, "publish")}
                      data-testid={`er-publish-${it.post_id}`}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Publish
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy === it.post_id}
                      onClick={() => review(it.post_id, "reject")}
                      data-testid={`er-reject-${it.post_id}`}>
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Don't publish
                    </Button>
                  </div>
                )}
              </div>

              <p className="mt-2 text-sm text-[var(--vivo-ink)] flex items-center gap-2 flex-wrap">
                <UserRound className="h-4 w-4 text-[var(--vivo-muted)]" />
                <span className="font-medium">@{it.author_username}</span>
                <span className="text-xs text-[var(--vivo-muted)]">{pointsHint(it)}</span>
              </p>

              {it.caption && (
                <p className="mt-1.5 text-sm text-[var(--vivo-ink)] whitespace-pre-wrap leading-relaxed" data-testid={`er-caption-${it.post_id}`}>
                  {it.caption}
                </p>
              )}

              <div className="mt-1.5 flex items-center gap-3 flex-wrap text-xs text-[var(--vivo-muted)]">
                {it.fit_note?.fit && (
                  <span>Fit: {it.fit_note.fit}{it.fit_note.size ? ` · Size ${it.fit_note.size}` : ""}</span>
                )}
                {Array.isArray(it.tagged) && it.tagged.length > 0 && (
                  <span>{it.tagged.length} piece{it.tagged.length === 1 ? "" : "s"} tagged</span>
                )}
              </div>

              {(it.has_photo || it.media_kind === "video") && (
                <EntryMedia pid={it.post_id} media={media} onToggle={toggleMedia} />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Challenge board — winner picking. Vote tallies are staff-only:       */
/* members never see numbers, only ribbons once the team decides.       */
/* ------------------------------------------------------------------ */

const DECIDING_LABEL = {
  team_pick: "Team pick",
  community_shortlist: "Community shortlist",
};
const POSITIONS = [
  [1, "1st"],
  [2, "2nd"],
  [3, "3rd"],
];

export function ChallengeBoard() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);          // challenge id
  const [detail, setDetail] = useState(null);    // shortlist payload
  const [busy, setBusy] = useState(null);
  const [media, toggleMedia] = useEntryMedia();

  const loadBoard = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/crm/community-challenges");
      setItems(data.items || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load challenges");
    } finally {
      setLoading(false);
    }
  };

  const openShortlist = async (cid) => {
    setSel(cid);
    setDetail(null);
    try {
      const { data } = await api.get(`/crm/community-challenges/${cid}/shortlist`);
      setDetail(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load the shortlist");
      setSel(null);
    }
  };

  useEffect(() => { loadBoard(); }, []);

  const pick = async (pid, position) => {
    setBusy(pid);
    try {
      const { data } = await api.post(`/crm/community-entries/${pid}/winner`, { position });
      toast.success(
        position
          ? `Ribbon set — the ${data.winner_bonus}-point bonus follows the pick`
          : "Ribbon cleared — bonus reversed"
      );
      await openShortlist(sel);
      await loadBoard();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't set the winner");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 pt-6 mt-6 border-t border-[var(--vivo-border)]" data-testid="challenge-board-section">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-[var(--vivo-ink)] flex items-center gap-2">
            <Trophy className="h-4.5 w-4.5 text-[var(--vivo-primary)]" /> Challenges & winners
          </h2>
          <p className="text-sm text-[var(--vivo-muted)] mt-0.5">
            Pick winners here — each carries a 200-point bonus, and re-picking moves it.
            Vote counts are for this desk only; members see ribbons, never tallies.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => (sel ? openShortlist(sel) : loadBoard())} disabled={loading} data-testid="cb-refresh">
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {sel === null ? (
        loading ? (
          <Card className="p-8 text-center text-sm text-[var(--vivo-muted)]">Loading challenges…</Card>
        ) : (
          <div className="space-y-3">
            {items.map((c) => (
              <Card key={c.id} className="p-4" data-testid={`cb-item-${c.id}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-[var(--vivo-ink)]">{c.title}</span>
                      <Badge variant="outline">{DECIDING_LABEL[c.deciding] || c.deciding}</Badge>
                      <Badge variant="outline" className={c.closed ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700 border-emerald-200"}>
                        {c.closed ? "Closed" : "Open"}
                      </Badge>
                    </div>
                    <p className="text-xs text-[var(--vivo-muted)] mt-1">
                      {c.hashtag} · {c.points} pts per published entry · {c.pending} pending · {c.published} published
                      {c.winners_set > 0 ? ` · ${c.winners_set} winner${c.winners_set === 1 ? "" : "s"} set` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => openShortlist(c.id)} data-testid={`cb-open-${c.id}`}>
                    Pick winners
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : detail === null ? (
        <Card className="p-8 text-center text-sm text-[var(--vivo-muted)]">Loading shortlist…</Card>
      ) : (
        <div className="space-y-3" data-testid="cb-shortlist">
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => { setSel(null); setDetail(null); }} data-testid="cb-back">
              <ChevronLeft className="h-3.5 w-3.5 mr-1" /> All challenges
            </Button>
            <span className="font-medium text-[var(--vivo-ink)]">{detail.challenge?.title}</span>
            <Badge variant="outline">{DECIDING_LABEL[detail.challenge?.deciding] || detail.challenge?.deciding}</Badge>
            {detail.shortlist && (
              <span className="text-xs text-[var(--vivo-muted)]">
                Top 10 by member votes — tallies stay in this room.
              </span>
            )}
          </div>

          {(detail.entries || []).length === 0 ? (
            <Card className="p-8 text-center text-sm text-[var(--vivo-muted)]" data-testid="cb-shortlist-empty">
              No published entries yet — nothing to pick from.
            </Card>
          ) : (
            (detail.entries || []).map((e) => (
              <Card key={e.post_id} className="p-4" data-testid={`cb-entry-${e.post_id}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[var(--vivo-ink)]">@{e.author_username}</span>
                    <Badge variant="outline" data-testid={`cb-votes-${e.post_id}`}>{e.vote_count} vote{e.vote_count === 1 ? "" : "s"}</Badge>
                    {e.media_kind === "video" && <Badge variant="outline"><Video className="h-3 w-3 mr-1" /> Video</Badge>}
                    {(e.winner_position || 0) >= 1 && (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        <Trophy className="h-3 w-3 mr-1" /> #{e.winner_position}
                      </Badge>
                    )}
                    <span className="text-xs text-[var(--vivo-muted)]">{timeAgo(e.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {POSITIONS.map(([pos, label]) => (
                      <Button key={pos} size="sm"
                        variant={e.winner_position === pos ? "default" : "outline"}
                        disabled={busy === e.post_id}
                        onClick={() => pick(e.post_id, pos)}
                        data-testid={`cb-pick-${pos}-${e.post_id}`}>
                        {label}
                      </Button>
                    ))}
                    {(e.winner_position || 0) >= 1 && (
                      <Button size="sm" variant="outline" disabled={busy === e.post_id}
                        onClick={() => pick(e.post_id, null)}
                        data-testid={`cb-clear-${e.post_id}`}>
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
                {e.caption && <p className="mt-2 text-sm text-[var(--vivo-ink)] leading-relaxed">{e.caption}</p>}
                {e.has_photo && <EntryMedia pid={e.post_id} media={media} onToggle={toggleMedia} />}
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Redemptions — Zetu shoots to schedule, tanks to stitch. Status       */
/* changes are visible to the member immediately (with your note).      */
/* ------------------------------------------------------------------ */

const REWARD_LABEL = (k) => (k === "zetu_shoot" ? "Zetu Studios Photoshoot" : "Embroidered Tank");
const NEXT_STATUSES = (k) =>
  k === "zetu_shoot"
    ? ["booking", "scheduled", "done", "cancelled"]
    : ["in_review", "needs_changes", "stitching", "ready", "collected", "cancelled"];
const RSTATUS_LABEL = {
  in_review: "In review", needs_changes: "Needs a tweak", stitching: "Being stitched",
  booking: "Booking", scheduled: "Scheduled",
  ready: "Ready", collected: "Collected", done: "Done", cancelled: "Cancelled",
};
const RSTATUS_STYLE = {
  booking: "bg-amber-50 text-amber-700 border-amber-200",
  in_review: "bg-amber-50 text-amber-700 border-amber-200",
  needs_changes: "bg-rose-50 text-rose-700 border-rose-200",
  stitching: "bg-blue-50 text-blue-700 border-blue-200",
  scheduled: "bg-blue-50 text-blue-700 border-blue-200",
  ready: "bg-blue-50 text-blue-700 border-blue-200",
  done: "bg-emerald-50 text-emerald-700 border-emerald-200",
  collected: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-slate-100 text-slate-600",
};
const DONE_SET = new Set(["done", "collected", "cancelled"]);

export function RedemptionQueue() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState({});
  const [showPast, setShowPast] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/crm/community-redemptions");
      setItems(data.items || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't load redemptions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const setStatus = async (r, status) => {
    setBusy(r.id);
    try {
      await api.put(`/crm/community-redemptions/${r.id}/status`, {
        status,
        note: notes[r.id] ?? r.status_note ?? "",
      });
      toast.success(`Moved to ${RSTATUS_LABEL[status] || status} — the member sees it right away`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const active = items.filter((r) => !DONE_SET.has(r.status));
  const past = items.filter((r) => DONE_SET.has(r.status));
  const shown = showPast ? items : active;

  return (
    <div className="space-y-3 pt-6 mt-6 border-t border-[var(--vivo-border)]" data-testid="redemption-queue-section">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-[var(--vivo-ink)] flex items-center gap-2">
            <Camera className="h-4.5 w-4.5 text-[var(--vivo-primary)]" /> Reward redemptions
          </h2>
          <p className="text-sm text-[var(--vivo-muted)] mt-0.5">
            Zetu shoots to schedule and tanks to stitch. Your note travels with the status —
            the member reads it in her Rewards tab.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowPast((v) => !v)} data-testid="rq-toggle-past">
            {showPast ? "Active only" : `Show finished (${past.length})`}
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} data-testid="rq-refresh">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <Card className="p-8 text-center text-sm text-[var(--vivo-muted)]">Loading redemptions…</Card>
      ) : shown.length === 0 ? (
        <Card className="p-8 text-center" data-testid="rq-empty">
          <Camera className="h-8 w-8 mx-auto text-[var(--vivo-muted)] opacity-40 mb-3" />
          <p className="text-sm text-[var(--vivo-muted)]">
            {showPast ? "No redemptions yet." : "Nothing waiting — every booking is handled."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((r) => (
            <Card key={r.id} className="p-4" data-testid={`rq-item-${r.id}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="font-medium">
                    {r.reward_key === "zetu_shoot" ? <Camera className="h-3 w-3 mr-1" /> : null}
                    {REWARD_LABEL(r.reward_key)}
                  </Badge>
                  <Badge variant="outline" className={RSTATUS_STYLE[r.status] || ""} data-testid={`rq-status-${r.id}`}>
                    {RSTATUS_LABEL[r.status] || r.status}
                  </Badge>
                  <span className="text-xs text-[var(--vivo-muted)]">
                    {(r.points_cost || 0).toLocaleString()} pts · {timeAgo(r.created_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {NEXT_STATUSES(r.reward_key).filter((s) => s !== r.status).map((s) => (
                    <Button key={s} size="sm"
                      variant={s === "cancelled" ? "outline" : DONE_SET.has(s) ? "default" : "outline"}
                      disabled={busy === r.id}
                      onClick={() => setStatus(r, s)}
                      data-testid={`rq-set-${s}-${r.id}`}>
                      {RSTATUS_LABEL[s]}
                    </Button>
                  ))}
                </div>
              </div>

              <p className="mt-2 text-sm text-[var(--vivo-ink)] flex items-center gap-2 flex-wrap">
                <UserRound className="h-4 w-4 text-[var(--vivo-muted)]" />
                <span className="font-medium">{r.full_name}</span>
                <span className="text-[var(--vivo-muted)]">@{r.username}</span>
                {r.phone && (
                  <a href={`tel:${r.phone}`} className="inline-flex items-center gap-1 text-[var(--vivo-primary)] hover:underline">
                    <Phone className="h-3.5 w-3.5" /> {r.phone}
                  </a>
                )}
              </p>

              {r.reward_key !== "zetu_shoot" && (
                <p className="mt-1 text-xs text-[var(--vivo-muted)]">
                  {r.colour} · Size {r.size}
                  {r.embroidery_type === "upload"
                    ? ` · Uploaded design${r.has_design ? "" : " (missing)"}`
                    : r.monogram_text ? ` · Monogram "${r.monogram_text}" (${r.monogram_style})` : ""}
                  {r.collection_method === "pickup" ? ` · Pick up at ${r.pickup_store}` : " · Delivery"}
                </p>
              )}

              <div className="mt-3 flex items-end gap-2">
                <Textarea
                  rows={1}
                  placeholder='Note the member will see ("Sat 10am at Zetu Studios — ask for Wanjiru")'
                  value={notes[r.id] ?? r.status_note ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                  className="text-sm min-h-[38px]"
                  data-testid={`rq-note-${r.id}`}
                />
                <Button size="sm" variant="outline"
                  disabled={busy === r.id || (notes[r.id] ?? r.status_note ?? "") === (r.status_note ?? "")}
                  onClick={() => setStatus(r, r.status)}
                  data-testid={`rq-note-save-${r.id}`}>
                  Save note
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
