import React, { useEffect, useMemo, useState } from "react";
import { api, formatDate, timeAgo } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Search, Reply, Link2, Inbox as InboxIcon, MessageSquare, AtSign, Star, RefreshCw, Facebook, Instagram, Twitter, AlertTriangle, CheckCircle2, FileText, ExternalLink, CornerDownRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

const PLATFORMS = ["all", "instagram", "facebook", "tiktok", "x", "whatsapp"];
const TYPES = ["all", "post", "comment", "mention", "dm", "review"];
const SENTIMENTS = ["all", "positive", "neutral", "negative"];

const SENTIMENT_STYLE = {
  positive: "bg-emerald-50 text-emerald-700 border-emerald-200",
  neutral: "bg-zinc-50 text-zinc-600 border-zinc-200",
  negative: "bg-red-50 text-red-700 border-red-200",
};

const TYPE_ICON = { post: FileText, comment: MessageSquare, mention: AtSign, dm: InboxIcon, review: Star };

export default function Inbox() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ platform: "all", type: "all", sentiment: "all", q: "" });
  const [hideMock] = useState(true);
  const [selected, setSelected] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchQ, setSearchQ] = useState("");
  const [fbStatus, setFbStatus] = useState(null);
  const [igStatus, setIgStatus] = useState(null);
  const [xStatus, setXStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [igSyncing, setIgSyncing] = useState(false);
  const [xSyncing, setXSyncing] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [connecting, setConnecting] = useState(false);

  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    // High enough to show a fully deep-synced page (2000 posts + 2000 comments).
    const params = { limit: 4000 };
    if (filters.platform !== "all") params.platform = filters.platform;
    if (filters.type !== "all") params.type = filters.type;
    if (filters.sentiment !== "all") params.sentiment = filters.sentiment;
    if (filters.q) params.q = filters.q;
    if (hideMock) params.hide_mock = true;
    try {
      const r = await api.get("/social/feedback", { params });
      setItems(r.data || []);
      if (r.data?.length && !selected) setSelected(r.data[0]);
    } finally {
      setLoading(false);
    }
  };

  const loadFbStatus = async () => {
    try {
      const r = await api.get("/social/facebook/status");
      setFbStatus(r.data);
    } catch { /* ignore */ }
  };

  const loadIgStatus = async () => {
    try {
      const r = await api.get("/social/instagram/status");
      setIgStatus(r.data);
    } catch { /* ignore */ }
  };

  // The IG sync now runs server-side on a background thread and returns
  // immediately, so we poll /social/instagram/status until it stops "running"
  // (or a safety timeout) and then surface the finished counts / warnings.
  const pollIgUntilDone = async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const deadline = Date.now() + 6 * 60 * 1000; // safety cap (backgrounds on)
    try {
      // Give the thread a moment to acquire the lock before the first poll.
      await sleep(1500);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let st = null;
        try {
          const r = await api.get("/social/instagram/status");
          st = r.data;
          setIgStatus(st);
        } catch { /* transient — keep polling */ }
        if (st && !st.running) {
          const a = st.account || {};
          toast.success(
            `Instagram: ${a.last_sync_posts || 0} posts, ${a.last_sync_comments || 0} comments, ${a.last_sync_mentions || 0} mentions, ${a.last_sync_dms || 0} DMs`
          );
          if (st.last_run_error) {
            toast.error("Instagram sync error: " + st.last_run_error);
          }
          if ((a.last_sync_scopes_missing || []).length) {
            toast.warning(`Missing scope: ${a.last_sync_scopes_missing.join(", ")} — that content cannot be pulled until added.`);
          } else if (st.dm_blocked) {
            toast.warning("Instagram DMs can't be pulled — the messaging permission is missing on the Page token.");
          }
          await load();
          return;
        }
        if (Date.now() > deadline) {
          toast.message("Instagram sync is still running — it will finish in the background.");
          await load();
          return;
        }
        await sleep(3000);
      }
    } finally {
      setIgSyncing(false);
    }
  };

  const syncIgNow = async () => {
    setIgSyncing(true);
    try {
      await api.post("/social/instagram/sync", {});
      toast.message("Instagram sync started — pulling posts, comments, mentions & DMs in the background…");
      await pollIgUntilDone();
    } catch (e) {
      if (e?.response?.status === 409) {
        // A sync (manual or the automatic loop) is already running — just watch it.
        toast.message("An Instagram sync is already running — waiting for it to finish…");
        await pollIgUntilDone();
      } else {
        toast.error("Instagram sync failed to start: " + (e?.response?.data?.detail || e.message));
        setIgSyncing(false);
      }
    }
  };

  const loadXStatus = async () => {
    try {
      const r = await api.get("/social/x/status");
      setXStatus(r.data);
    } catch { /* ignore */ }
  };

  const syncXNow = async () => {
    setXSyncing(true);
    try {
      const r = await api.post("/social/x/sync", {});
      const d = r.data || {};
      toast.success(`X: ${d.posts || 0} posts, ${d.mentions || 0} new mentions, ${d.dms || 0} new DMs`);
      if ((d.scopes_missing || []).length) {
        toast.warning(`Missing access: ${d.scopes_missing.join(", ")} — that content cannot be pulled until your X API tier/scope allows it.`);
      }
      await loadXStatus();
      await load();
    } catch (e) {
      toast.error("X sync failed: " + (e?.response?.data?.detail || e.message));
    } finally {
      setXSyncing(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.post("/social/facebook/sync", {});
      const d = r.data || {};
      toast.success(`Synced ${d.pages_synced || 0} page(s): ${d.posts || 0} posts, ${d.comments || 0} comments, ${d.dms || 0} DMs`);
      if ((d.scopes_missing || []).length) {
        toast.warning(`Missing scope: ${d.scopes_missing.join(", ")} — that content cannot be pulled until added.`);
      }
      await loadFbStatus();
      await load();
    } catch (e) {
      toast.error("Sync failed: " + (e?.response?.data?.detail || e.message));
    } finally {
      setSyncing(false);
    }
  };

  const connectFacebook = async () => {
    const token = tokenInput.trim();
    if (!token) {
      toast.error("Paste a Facebook user access token first.");
      return;
    }
    setConnecting(true);
    try {
      const d = await api.post("/social/facebook/discover", { user_access_token: token });
      toast.success(`Connected ${d.data?.discovered || 0} page(s). Starting first sync…`);
      setConnectOpen(false);
      setTokenInput("");
      await loadFbStatus();
      // Auto-trigger first sync right after discover
      await syncNow();
    } catch (e) {
      toast.error("Connect failed: " + (e?.response?.data?.detail || e.message));
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.platform, filters.type, filters.sentiment, hideMock]);

  useEffect(() => {
    loadFbStatus();
    loadIgStatus();
    loadXStatus();
    const id = setInterval(() => { loadFbStatus(); loadIgStatus(); loadXStatus(); }, 60000); // refresh freshness every 60s
    return () => clearInterval(id);
  }, []);

  const reclassify = async () => {
    toast.message("Running classifier…");
    try {
      const r = await api.post("/social/classify-pending");
      toast.success(`Classified ${r.data.classified} items`);
      load();
    } catch {
      toast.error("Classifier could not run (manager only)");
    }
  };

  const linkCustomer = async (customer) => {
    if (!selected) return;
    await api.post(`/social/feedback/${selected.feedback_id}/link`, {
      customer_id: customer.customer_id,
      customer_name: customer.customer_name,
    });
    toast.success(`Linked to ${customer.customer_name}`);
    setLinkOpen(false);
    setSelected({ ...selected, customer_id: customer.customer_id });
    load();
  };

  const sendReply = async () => {
    if (!replyBody.trim() || !selected) return;
    try {
      const r = await api.post(`/social/feedback/${selected.feedback_id}/reply`, { body: replyBody });
      toast.success(
        r.data?.delivered
          ? `Reply sent to ${r.data.delivery_channel || "the customer"}`
          : "Reply saved (logged only — not sent to the platform)"
      );
      setSelected(r.data);
      setReplyOpen(false);
      setReplyBody("");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message || "Reply failed");
    }
  };

  const searchCustomer = async () => {
    if (!searchQ.trim()) return;
    const r = await api.get("/bi/customer-search", { params: { q: searchQ } });
    setSearchResults(r.data || []);
  };

  const counts = useMemo(() => {
    const c = { total: items.length, positive: 0, neutral: 0, negative: 0, dm: 0, mention: 0 };
    items.forEach((i) => {
      if (i.sentiment) c[i.sentiment] = (c[i.sentiment] || 0) + 1;
      if (i.type === "dm") c.dm += 1;
      if (i.type === "mention") c.mention += 1;
    });
    return c;
  }, [items]);

  return (
    <div className="p-6 md:p-10 max-w-[1500px] mx-auto" data-testid="inbox-page">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="eyebrow">Voice of customer</div>
          <h1 className="font-display text-4xl md:text-5xl tracking-tight mt-2">Social inbox</h1>
          <div className="gold-rule mt-4" />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={reclassify} className="rounded-sm h-11" data-testid="reclassify-button">
            <RefreshCw className="mr-2 h-4 w-4" /> Re-run sentiment
          </Button>
          {(fbStatus?.discovered_pages?.length || 0) === 0 ? (
            <Button onClick={() => setConnectOpen(true)} className="rounded-sm h-11 bg-[#1877F2] hover:bg-[#1877F2]/90 text-white" data-testid="connect-fb-button">
              <Facebook className="mr-2 h-4 w-4" /> Connect Facebook
            </Button>
          ) : (
            <Button onClick={syncNow} disabled={syncing} className="rounded-sm h-11 bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy)]/90 text-white" data-testid="sync-now-button">
              <Facebook className={`mr-2 h-4 w-4 ${syncing ? "animate-pulse" : ""}`} />
              {syncing ? "Syncing…" : "Sync from Facebook"}
            </Button>
          )}
          {igStatus?.connected && (
            <Button onClick={syncIgNow} disabled={igSyncing} className="rounded-sm h-11 bg-gradient-to-tr from-[#F58529] via-[#DD2A7B] to-[#8134AF] hover:opacity-90 text-white" data-testid="sync-ig-button">
              <Instagram className={`mr-2 h-4 w-4 ${igSyncing ? "animate-pulse" : ""}`} />
              {igSyncing ? "Syncing…" : "Sync from Instagram"}
            </Button>
          )}
          {xStatus?.connected && (
            <Button onClick={syncXNow} disabled={xSyncing} className="rounded-sm h-11 bg-black hover:bg-black/90 text-white" data-testid="sync-x-button">
              <Twitter className={`mr-2 h-4 w-4 ${xSyncing ? "animate-pulse" : ""}`} />
              {xSyncing ? "Syncing…" : "Sync from X"}
            </Button>
          )}
        </div>
      </div>

      {/* Facebook live-data banner */}
      <FacebookStatusStrip status={fbStatus} />

      {/* Instagram live-data banner */}
      <InstagramStatusStrip status={igStatus} />

      {/* X (Twitter) live-data banner */}
      <XStatusStrip status={xStatus} />

      {/* counts */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mt-6">
        <Pill label="Total" v={counts.total} testid="inbox-count-total" />
        <Pill label="Positive" v={counts.positive} tone="positive" />
        <Pill label="Neutral" v={counts.neutral} tone="neutral" />
        <Pill label="Negative" v={counts.negative} tone="negative" />
        <Pill label="DMs" v={counts.dm} />
        <Pill label="Mentions" v={counts.mention} />
      </div>

      {/* filters */}
      <div className="mt-6 flex flex-wrap gap-3 items-center" data-testid="inbox-filters">
        <Selector label="Platform" value={filters.platform} options={PLATFORMS} onChange={(v) => setFilters({ ...filters, platform: v })} testid="filter-platform" />
        <Selector label="Type" value={filters.type} options={TYPES} onChange={(v) => setFilters({ ...filters, type: v })} testid="filter-type" />
        <Selector label="Sentiment" value={filters.sentiment} options={SENTIMENTS} onChange={(v) => setFilters({ ...filters, sentiment: v })} testid="filter-sentiment" />
        <div className="relative ml-auto w-full md:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--vivo-muted)]" />
          <Input
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search text…"
            className="h-11 pl-10 rounded-sm"
            data-testid="filter-q"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mt-8">
        {/* List */}
        <div className="lg:col-span-2 vivo-card overflow-hidden max-h-[calc(100vh-260px)] overflow-y-auto" data-testid="inbox-list">
          {loading ? (
            <div className="p-6 text-sm text-[var(--vivo-muted)]">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-sm text-[var(--vivo-muted)]">No feedback matches your filters.</div>
          ) : (
            <ul className="divide-y divide-[var(--vivo-border)]">
              {items.map((i) => {
                const Icon = TYPE_ICON[i.type] || MessageSquare;
                const isSelected = selected?.feedback_id === i.feedback_id;
                return (
                  <li key={i.feedback_id}>
                    <button
                      onClick={() => setSelected(i)}
                      className={`w-full text-left p-4 hover:bg-[var(--vivo-bg)] transition-colors ${isSelected ? "bg-[var(--vivo-bg)] border-l-2 border-[var(--vivo-gold)]" : ""}`}
                      data-testid={`inbox-item-${i.feedback_id}`}
                    >
                      <div className="flex items-start gap-3">
                        <Icon className="h-4 w-4 mt-1 text-[var(--vivo-muted)]" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium truncate text-sm">{i.author_name}</span>
                            <span className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] shrink-0">{timeAgo(i.posted_at)}</span>
                          </div>
                          <div className="text-[11px] text-[var(--vivo-muted)] uppercase tracking-wider mt-0.5">{i.platform} · {i.type}</div>
                          {i.type === "comment" && i.parent_excerpt && (
                            <div className="flex items-start gap-1 text-[11px] text-[var(--vivo-muted)] mt-1.5 italic">
                              <CornerDownRight className="h-3 w-3 mt-0.5 shrink-0" />
                              <span className="line-clamp-1">on: {i.parent_excerpt}</span>
                            </div>
                          )}
                          <p className="text-sm mt-2 line-clamp-2">{i.body}</p>
                          <div className="flex items-center gap-2 mt-2">
                            {i.sentiment && (
                              <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-sm ${SENTIMENT_STYLE[i.sentiment]}`}>
                                {i.sentiment}
                              </span>
                            )}
                            {i.customer_id && (
                              <span className="text-[10px] uppercase tracking-wider text-[var(--vivo-gold-700)]">linked</span>
                            )}
                            {i.replied_at && (
                              <span className="text-[10px] uppercase tracking-wider text-[var(--vivo-navy)]">replied</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="lg:col-span-3">
          {selected ? (
            <Card className="vivo-card p-7 rounded-sm" data-testid="inbox-detail">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-[var(--vivo-muted)]">{selected.platform} · {selected.type} · {formatDate(selected.posted_at)}</div>
                  <div className="font-display text-2xl mt-1">{selected.author_name}</div>
                  <div className="text-sm text-[var(--vivo-muted)]">{selected.author_handle}</div>
                </div>
                {selected.sentiment && (
                  <span className={`text-xs uppercase tracking-wider px-3 py-1 border rounded-sm ${SENTIMENT_STYLE[selected.sentiment]}`}>{selected.sentiment}</span>
                )}
              </div>

              {selected.type === "comment" && selected.parent_excerpt && (
                <div className="mt-4 rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg)] px-4 py-3">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--vivo-muted)]">
                    <CornerDownRight className="h-3.5 w-3.5" /> In reply to post
                  </div>
                  <p className="text-sm mt-1 text-[var(--vivo-muted)] italic line-clamp-2">{selected.parent_excerpt}</p>
                </div>
              )}

              <div className="vivo-divider my-5" />
              <p className="text-base leading-relaxed whitespace-pre-wrap">{selected.body}</p>

              {selected.permalink && (
                <a
                  href={selected.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 mt-4 text-sm text-[var(--vivo-navy)] hover:underline"
                  data-testid="inbox-view-on-facebook"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> View on {selected.platform === "instagram" ? "Instagram" : selected.platform === "x" ? "X" : "Facebook"}
                </a>
              )}

              {selected.themes?.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-2">
                  {selected.themes.map((t) => (
                    <Badge key={t} variant="outline" className="rounded-sm">{t}</Badge>
                  ))}
                </div>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                {selected.customer_id ? (
                  <Button asChild variant="outline" className="rounded-sm" data-testid="inbox-open-customer">
                    <Link to={`/customers/${selected.customer_id}`}>Open customer →</Link>
                  </Button>
                ) : (
                  <Button onClick={() => { setLinkOpen(true); setSearchQ(""); setSearchResults([]); }} variant="outline" className="rounded-sm" data-testid="inbox-link-customer">
                    <Link2 className="mr-2 h-4 w-4" /> Link to customer
                  </Button>
                )}
                <Button
                  onClick={() => { setReplyOpen(true); setReplyBody(selected.reply_body || ""); }}
                  className="rounded-sm bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy-700)] text-white"
                  data-testid="inbox-reply-button"
                >
                  <Reply className="mr-2 h-4 w-4" /> {selected.replied_at ? "Update reply" : "Reply"}
                </Button>
              </div>

              {selected.reply_body && (
                <div className="mt-6 border-l-2 border-[var(--vivo-gold)] pl-4">
                  <div className="text-xs uppercase tracking-wider text-[var(--vivo-muted)]">Your reply · {timeAgo(selected.replied_at)}</div>
                  <p className="text-sm mt-2 whitespace-pre-wrap">{selected.reply_body}</p>
                </div>
              )}
            </Card>
          ) : (
            <div className="vivo-card p-12 text-center text-[var(--vivo-muted)]">Select an item to read.</div>
          )}
        </div>
      </div>

      {/* Link to customer dialog */}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="rounded-sm max-w-lg">
          <DialogHeader><DialogTitle className="font-display">Link this feedback to a customer</DialogTitle></DialogHeader>
          <div className="flex gap-2">
            <Input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchCustomer()} placeholder="Phone, name or email" className="h-11 rounded-sm" data-testid="link-search-input" />
            <Button onClick={searchCustomer} className="h-11 rounded-sm bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy-700)]" data-testid="link-search-submit">Search</Button>
          </div>
          <ul className="max-h-72 overflow-y-auto divide-y divide-[var(--vivo-border)] mt-2">
            {searchResults.map((c) => (
              <li key={c.customer_id}>
                <button
                  onClick={() => linkCustomer(c)}
                  className="w-full text-left p-3 hover:bg-[var(--vivo-bg)]"
                  data-testid={`link-result-${c.customer_id}`}
                >
                  <div className="font-medium">{c.customer_name}</div>
                  <div className="text-xs text-[var(--vivo-muted)]">{c.phone || c.email || c.customer_id}</div>
                </button>
              </li>
            ))}
            {searchResults.length === 0 && searchQ && <li className="p-3 text-sm text-[var(--vivo-muted)]">No matches.</li>}
          </ul>
        </DialogContent>
      </Dialog>

      {/* Reply dialog */}
      <Dialog open={replyOpen} onOpenChange={setReplyOpen}>
        <DialogContent className="rounded-sm max-w-lg">
          <DialogHeader><DialogTitle className="font-display">Reply</DialogTitle></DialogHeader>
          <Textarea rows={5} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} placeholder="Reply on platform…" data-testid="reply-body" />
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              className="rounded-sm h-9"
              data-testid="reply-suggest"
              onClick={async () => {
                if (!selected) return;
                try {
                  const r = await api.post("/insights/social/suggest-reply", { feedback_id: selected.feedback_id });
                  if (r.data?.reply) {
                    setReplyBody(r.data.reply);
                    toast.success(`AI draft (${r.data.tone})`);
                  } else {
                    toast.info("Couldn't draft a reply for this one — try writing manually.");
                  }
                } catch (e) {
                  toast.error(e?.response?.data?.detail || "Suggest failed");
                }
              }}
            >
              ✨ Suggest with AI
            </Button>
            <p className="text-xs text-[var(--vivo-muted)]">
              {selected?.platform === "x"
                ? (selected?.type === "dm"
                    ? "Sends a real X direct message to the customer."
                    : "Posts a real reply on X to this "
                      + (selected?.type === "mention" ? "mention." : "post."))
                : selected?.type === "dm"
                  ? "Sends a real Messenger reply to the customer."
                  : selected?.platform === "instagram" && selected?.type === "comment"
                    ? "Posts a real reply to this Instagram comment."
                    : "Logged here · platform delivery later."}
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReplyOpen(false)}>Cancel</Button>
            <Button onClick={sendReply} className="rounded-sm bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy-700)] text-white" data-testid="reply-send">Save reply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connect Facebook dialog */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent data-testid="connect-fb-dialog" className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <Facebook className="h-5 w-5 text-[#1877F2]" /> Connect Facebook
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="bg-[var(--vivo-bg)] border border-[var(--vivo-border)] p-3 rounded-sm text-xs space-y-2">
              <div className="font-medium text-[var(--vivo-text)]">How to get your access token (~90 seconds):</div>
              <ol className="list-decimal pl-4 space-y-1 text-[var(--vivo-muted)]">
                <li>Open <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer" className="underline text-[var(--vivo-navy)]">Graph API Explorer</a></li>
                <li>Top-right → select app <strong>Vivo_Power_Bi_Extraction</strong></li>
                <li>Click <strong>Get User Access Token</strong></li>
                <li>Tick: <code className="text-[10px] bg-white px-1 rounded">pages_show_list</code>, <code className="text-[10px] bg-white px-1 rounded">pages_read_engagement</code>, <code className="text-[10px] bg-white px-1 rounded">pages_read_user_content</code>, <code className="text-[10px] bg-white px-1 rounded">pages_manage_metadata</code></li>
                <li>On the FB pop-up, tick <strong>all Vivo pages</strong> (Vivo Woman, Shop Zetu, Safari by vivo, AMAYA, Vivo Fashion Group)</li>
                <li>Copy the token and paste below</li>
              </ol>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">User access token</label>
              <Textarea
                rows={4}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="EAATz... (paste the full token)"
                className="mt-1 rounded-sm font-mono text-xs"
                data-testid="fb-token-input"
              />
              <div className="text-[10px] text-[var(--vivo-muted)] mt-1">
                Token stays on Vivo's servers — never leaves your infrastructure. Long-lived Page tokens (~60 days) are generated automatically.
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConnectOpen(false)}>Cancel</Button>
            <Button
              onClick={connectFacebook}
              disabled={connecting || !tokenInput.trim()}
              className="rounded-sm bg-[#1877F2] hover:bg-[#1877F2]/90 text-white"
              data-testid="fb-connect-submit"
            >
              {connecting ? "Connecting…" : "Connect & Sync"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Pill({ label, v, tone, testid }) {
  const cls = tone === "positive" ? "text-emerald-700" : tone === "negative" ? "text-red-700" : "text-[var(--vivo-text)]";
  return (
    <div className="vivo-card px-4 py-3" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">{label}</div>
      <div className={`font-display text-2xl mt-1 font-mono-num ${cls}`}>{v}</div>
    </div>
  );
}

function FacebookStatusStrip({ status }) {
  if (!status) return null;
  const pages = status.discovered_pages || [];
  const lastSynced = status.last_synced_at;
  const counts = status.counts || {};
  const scopesMissing = new Set();
  pages.forEach((p) => (p.last_sync_scopes_missing || []).forEach((s) => scopesMissing.add(s)));
  const ago = lastSynced
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSynced).getTime()) / 60000))
    : null;

  if (pages.length === 0) {
    return (
      <div className="mt-6 vivo-card p-5 rounded-sm border-l-2 border-amber-400" data-testid="fb-status-strip">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium text-base">Facebook is not connected yet.</div>
            <div className="text-xs text-[var(--vivo-muted)] mt-1">
              You're seeing <strong>demo data</strong>. Click <strong>"Connect Facebook"</strong> above to link your Vivo pages and start pulling real posts &amp; comments. Once connected, use <strong>"Sync from Facebook"</strong> anytime to refresh the inbox with the latest activity.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const hasIssues = scopesMissing.size > 0;
  return (
    <div className="mt-6 vivo-card p-4 rounded-sm" data-testid="fb-status-strip">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <Facebook className="h-4 w-4 text-[#1877F2]" />
          <span className="text-sm font-medium">{pages.length} Facebook page{pages.length === 1 ? "" : "s"} live</span>
          {hasIssues ? (
            <span className="text-[10px] uppercase tracking-[0.15em] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-sm">
              Limited
            </span>
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          )}
        </div>
        <div className="text-xs text-[var(--vivo-muted)] flex items-center gap-3 flex-wrap" data-testid="fb-freshness">
          <span>
            Last synced:{" "}
            <span className="text-[var(--vivo-text)] font-medium">
              {ago === null ? "never" : ago === 0 ? "just now" : `${ago} min ago`}
            </span>
          </span>
          <span>Manual sync — click "Sync from Facebook" to refresh</span>
          <span>
            {counts.real_posts ?? 0} live posts ·{" "}
            {counts.real_dms ?? 0} DMs ·{" "}
            {counts.real_feedback ?? 0} live items
          </span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {pages.map((p) => {
          const missing = (p.last_sync_scopes_missing || []).length > 0;
          return (
            <div
              key={p.page_id}
              className={`text-xs border rounded-sm p-2 ${missing ? "border-amber-200 bg-amber-50/40" : "border-[var(--vivo-border)] bg-white"}`}
              data-testid={`fb-page-${p.page_id}`}
            >
              <div className="font-medium truncate" title={p.page_name}>{p.page_name}</div>
              <div className="text-[10px] text-[var(--vivo-muted)] mt-0.5">
                {p.last_sync_posts ?? 0} posts · {p.last_sync_comments ?? 0} comments · {p.last_sync_dms ?? 0} DMs
              </div>
              {missing && (
                <div className="text-[10px] text-amber-700 mt-0.5 truncate" title={(p.last_sync_scopes_missing || []).join(", ")}>
                  ⚠ scope: {p.last_sync_scopes_missing[0]?.replace("pages_", "")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasIssues && (
        <div className="mt-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 p-2 rounded-sm" data-testid="fb-scope-warn">
          <strong>Some content locked.</strong> Missing scope:{" "}
          <code className="text-[10px] bg-white px-1 py-0.5 rounded">{[...scopesMissing].join(", ")}</code>.{" "}
          Enable it in your Meta App → Use Cases → "Manage everything on your Page", then regenerate the user token via Graph Explorer and re-run discovery.
        </div>
      )}
    </div>
  );
}

function InstagramStatusStrip({ status }) {
  if (!status) return null;
  const acct = status.account;
  const lastSynced = status.last_synced_at;
  const counts = status.counts || {};
  const scopesMissing = new Set(acct?.last_sync_scopes_missing || []);
  // The messaging scope gets its own dedicated DM banner below; every other
  // missing scope stays in the generic "some content locked" strip.
  const dmBlocked = !!status.dm_blocked || scopesMissing.has("instagram_manage_messages");
  const otherScopesMissing = [...scopesMissing].filter((s) => s !== "instagram_manage_messages");
  const ago = lastSynced
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSynced).getTime()) / 60000))
    : null;

  if (!status.connected) {
    return (
      <div className="mt-3 vivo-card p-5 rounded-sm border-l-2 border-[#DD2A7B]" data-testid="ig-status-strip">
        <div className="flex items-start gap-3">
          <Instagram className="h-5 w-5 text-[#DD2A7B] mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium text-base">Instagram is not connected yet.</div>
            <div className="text-xs text-[var(--vivo-muted)] mt-1">
              Link an Instagram Business account to your Facebook Page in Meta Business settings. Once linked, a <strong>"Sync from Instagram"</strong> button appears here to pull real posts, comments &amp; @-mentions into the inbox.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const hasIssues = scopesMissing.size > 0;
  return (
    <div className="mt-3 vivo-card p-4 rounded-sm" data-testid="ig-status-strip">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <Instagram className="h-4 w-4 text-[#DD2A7B]" />
          <span className="text-sm font-medium">{acct?.handle || acct?.username || "Instagram"} live</span>
          {hasIssues ? (
            <span className="text-[10px] uppercase tracking-[0.15em] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-sm">
              Limited
            </span>
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          )}
        </div>
        <div className="text-xs text-[var(--vivo-muted)] flex items-center gap-3 flex-wrap" data-testid="ig-freshness">
          <span>
            Last synced:{" "}
            <span className="text-[var(--vivo-text)] font-medium">
              {status.running ? "syncing…" : ago === null ? "never" : ago === 0 ? "just now" : `${ago} min ago`}
            </span>
          </span>
          <span>Manual sync — click "Sync from Instagram" to refresh</span>
          <span>
            {counts.real_posts ?? 0} live posts ·{" "}
            {counts.real_mentions ?? 0} mentions ·{" "}
            {counts.real_dms ?? 0} DMs ·{" "}
            {counts.real_feedback ?? 0} live items
          </span>
        </div>
      </div>

      {/* Persistent DM-permission banner — DMs need instagram_manage_messages on
          the Page token. Shown whenever the last completed sync flagged the scope
          as missing (or the DM phase errored), so staff get an actionable message
          instead of silently seeing no DMs. */}
      {dmBlocked && (
        <div className="mt-3 text-[12px] text-amber-900 bg-amber-50 border-l-2 border-amber-500 border border-amber-200 p-3 rounded-sm flex items-start gap-2" data-testid="ig-dm-blocked">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <strong>Instagram DMs can't be pulled.</strong> The Page token is missing the{" "}
            <code className="text-[11px] bg-white px-1 py-0.5 rounded">instagram_manage_messages</code>{" "}
            permission, so Direct messages won't appear in the inbox until it's granted.{" "}
            Reconnect the Instagram Business account / regenerate the Page token with messaging access in your Meta App, then re-run the sync.
            {status.dm_error && (
              <div className="text-[11px] text-amber-700 mt-1 break-words">Details: {status.dm_error}</div>
            )}
          </div>
        </div>
      )}

      {otherScopesMissing.length > 0 && (
        <div className="mt-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 p-2 rounded-sm" data-testid="ig-scope-warn">
          <strong>Some content locked.</strong> Missing scope:{" "}
          <code className="text-[10px] bg-white px-1 py-0.5 rounded">{otherScopesMissing.join(", ")}</code>.{" "}
          Enable it in your Meta App → Instagram permissions, then regenerate the Page token and re-run the sync.
        </div>
      )}
    </div>
  );
}

function XStatusStrip({ status }) {
  if (!status) return null;
  const acct = status.account;
  const lastSynced = status.last_synced_at;
  const counts = status.counts || {};
  const scopesMissing = new Set(acct?.last_sync_scopes_missing || []);
  const ago = lastSynced
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSynced).getTime()) / 60000))
    : null;

  if (!status.connected) {
    return (
      <div className="mt-3 vivo-card p-5 rounded-sm border-l-2 border-black" data-testid="x-status-strip">
        <div className="flex items-start gap-3">
          <Twitter className="h-5 w-5 text-black mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium text-base">X (Twitter) is not connected yet.</div>
            <div className="text-xs text-[var(--vivo-muted)] mt-1">
              Add your X API credentials to the server (a Bearer token plus the brand's user ID or username for reads; OAuth 1.0a keys for replies &amp; DMs). Once configured, a <strong>"Sync from X"</strong> button appears here to pull real posts, @-mentions &amp; DMs into the inbox.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const hasIssues = scopesMissing.size > 0;
  return (
    <div className="mt-3 vivo-card p-4 rounded-sm" data-testid="x-status-strip">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <Twitter className="h-4 w-4 text-black" />
          <span className="text-sm font-medium">{acct?.handle || acct?.username || "X"} live</span>
          {hasIssues ? (
            <span className="text-[10px] uppercase tracking-[0.15em] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-sm">
              Limited
            </span>
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          )}
        </div>
        <div className="text-xs text-[var(--vivo-muted)] flex items-center gap-3 flex-wrap" data-testid="x-freshness">
          <span>
            Last synced:{" "}
            <span className="text-[var(--vivo-text)] font-medium">
              {ago === null ? "never" : ago === 0 ? "just now" : `${ago} min ago`}
            </span>
          </span>
          <span>Manual sync — click "Sync from X" to refresh</span>
          <span>
            {counts.real_posts ?? 0} live posts ·{" "}
            {counts.real_mentions ?? 0} mentions ·{" "}
            {counts.real_dms ?? 0} DMs
          </span>
        </div>
      </div>

      {hasIssues && (
        <div className="mt-3 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 p-2 rounded-sm" data-testid="x-scope-warn">
          <strong>Some content locked.</strong> Missing access:{" "}
          <code className="text-[10px] bg-white px-1 py-0.5 rounded">{[...scopesMissing].join(", ")}</code>.{" "}
          Your X API tier/scope doesn't currently allow that content — upgrade the API tier or add the scope, then re-run the sync.
        </div>
      )}
    </div>
  );
}

function Selector({ label, value, options, onChange, testid }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)] mb-1">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-11 w-40 rounded-sm" data-testid={testid}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o} value={o} className="capitalize">{o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
