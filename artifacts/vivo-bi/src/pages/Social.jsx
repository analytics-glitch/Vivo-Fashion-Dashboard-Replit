import React, { useCallback, useEffect, useState } from "react";
import { api, fmtNum, fmtDate } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { toast } from "sonner";
import {
  FacebookLogo,
  ArrowClockwise,
  PaperPlaneTilt,
  ThumbsUp,
  ChatCircle,
  ShareNetwork,
  Users,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Megaphone,
} from "@phosphor-icons/react";

// ---------------------------------------------------------------------------
// Social — Facebook Page management cockpit.
// Backed by the /api/social/* endpoints (analyst+ surface). Lets staff publish
// offers to the brand's Facebook Page, read Page audience + engagement, and
// read/reply to comments with AI-assigned sentiment. No emojis in the UI;
// money is KES (none on this page). Mirrors the CRM.jsx editorial styling.
// ---------------------------------------------------------------------------

const errOf = (e) => e?.response?.data?.detail || e?.message || "Request failed";

const inputCls =
  "w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-foreground outline-none focus:border-brand";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-brand/90 disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-2 text-[13px] font-semibold text-foreground hover:bg-panel disabled:opacity-50";

const SENTIMENT_META = {
  positive: { label: "Positive", color: "#1a5c38" },
  negative: { label: "Negative", color: "#dc2626" },
  neutral: { label: "Neutral", color: "#6b7280" },
};

const Pill = ({ children, color, subtle = false }) => (
  <span
    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
    style={
      subtle
        ? { color, backgroundColor: `${color}1a` }
        : { color: "#fff", backgroundColor: color }
    }
  >
    {children}
  </span>
);

const SentimentBadge = ({ sentiment }) => {
  const m = SENTIMENT_META[sentiment];
  if (!m) return <Pill color="#9ca3af" subtle>Unscored</Pill>;
  return <Pill color={m.color} subtle>{m.label}</Pill>;
};

const KpiTile = ({ label, value, icon: Icon }) => (
  <div className="card-white p-4 flex items-center gap-3">
    {Icon && (
      <div className="shrink-0 w-9 h-9 rounded-lg bg-brand/10 text-brand grid place-items-center">
        <Icon size={18} weight="bold" />
      </div>
    )}
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
      <div className="text-[20px] font-bold tracking-tight text-foreground">{value}</div>
    </div>
  </div>
);

// =====================================================================
// Comments + reply (per post)
// =====================================================================

const CommentList = ({ postId }) => {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [comments, setComments] = useState([]);
  const [replyFor, setReplyFor] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api
      .get("/social/comments", { params: { post_id: postId }, forceFresh: true })
      .then((r) => setComments(r.data?.comments || []))
      .catch((e) => setErr(errOf(e)))
      .finally(() => setLoading(false));
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitReply = (commentId) => {
    const msg = replyText.trim();
    if (!msg) return;
    setSending(true);
    api
      .post(`/social/comments/${encodeURIComponent(commentId)}/reply`, { message: msg })
      .then(() => {
        toast.success("Reply posted");
        setReplyFor(null);
        setReplyText("");
        load();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSending(false));
  };

  if (loading) return <div className="py-4"><Loading label="Loading comments…" /></div>;
  if (err) return <ErrorBox message={err} />;
  if (!comments.length) return <Empty label="No comments on this post yet." />;

  return (
    <div className="space-y-3 pt-2">
      {comments.map((c) => (
        <div key={c.id} className="rounded-lg border border-border bg-panel/40 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12.5px] font-semibold text-foreground">
                  {c.from_name || "Facebook user"}
                </span>
                <SentimentBadge sentiment={c.sentiment} />
                {c.like_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                    <ThumbsUp size={12} /> {fmtNum(c.like_count)}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[13px] text-foreground/90 whitespace-pre-wrap break-words">
                {c.message || <span className="italic text-muted">(no text)</span>}
              </p>
              <div className="mt-1 text-[11px] text-muted">{fmtDate(c.created_time)}</div>
            </div>
            <button
              type="button"
              className={btnGhost + " shrink-0"}
              onClick={() => {
                setReplyFor(replyFor === c.id ? null : c.id);
                setReplyText("");
              }}
            >
              <PaperPlaneTilt size={14} /> Reply
            </button>
          </div>
          {replyFor === c.id && (
            <div className="mt-3 space-y-2">
              <textarea
                className={inputCls + " min-h-[64px] resize-y"}
                placeholder="Write a public reply…"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={sending || !replyText.trim()}
                  onClick={() => submitReply(c.id)}
                >
                  <PaperPlaneTilt size={14} /> {sending ? "Posting…" : "Post reply"}
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={sending}
                  onClick={() => { setReplyFor(null); setReplyText(""); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// =====================================================================
// Recent posts
// =====================================================================

const PostCard = ({ post }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="card-white p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13.5px] text-foreground whitespace-pre-wrap break-words min-w-0">
          {post.message || <span className="italic text-muted">(no caption)</span>}
        </p>
        {post.picture && (
          <img
            src={post.picture}
            alt=""
            className="w-16 h-16 rounded-md object-cover border border-border shrink-0"
          />
        )}
      </div>
      <div className="mt-3 flex items-center gap-4 flex-wrap text-[12px] text-muted">
        <span>{fmtDate(post.created_time)}</span>
        <span className="inline-flex items-center gap-1"><ThumbsUp size={13} /> {fmtNum(post.like_count)}</span>
        <span className="inline-flex items-center gap-1"><ChatCircle size={13} /> {fmtNum(post.comment_count)}</span>
        <span className="inline-flex items-center gap-1"><ShareNetwork size={13} /> {fmtNum(post.share_count)}</span>
        {post.permalink_url && (
          <a
            href={post.permalink_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-brand hover:underline"
          >
            <ArrowSquareOut size={13} /> View on Facebook
          </a>
        )}
      </div>
      <button
        type="button"
        className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand hover:underline"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
        {open ? "Hide comments" : `Comments & sentiment${post.comment_count ? ` (${fmtNum(post.comment_count)})` : ""}`}
      </button>
      {open && <CommentList postId={post.id} />}
    </div>
  );
};

// =====================================================================
// Page
// =====================================================================

const Social = () => {
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState("");
  const [insights, setInsights] = useState(null);
  const [posts, setPosts] = useState([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [postsErr, setPostsErr] = useState("");

  // Offer composer
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [posting, setPosting] = useState(false);

  const loadStatus = useCallback(() => {
    setStatusErr("");
    api
      .get("/social/status", { forceFresh: true })
      .then((r) => setStatus(r.data))
      .catch((e) => setStatusErr(errOf(e)));
  }, []);

  const loadInsights = useCallback(() => {
    api
      .get("/social/insights", { forceFresh: true })
      .then((r) => setInsights(r.data))
      .catch(() => setInsights(null));
  }, []);

  const loadPosts = useCallback(() => {
    setPostsLoading(true);
    setPostsErr("");
    api
      .get("/social/posts", { params: { limit: 12 }, forceFresh: true })
      .then((r) => setPosts(r.data?.posts || []))
      .catch((e) => setPostsErr(errOf(e)))
      .finally(() => setPostsLoading(false));
  }, []);

  const refreshAll = useCallback(() => {
    loadStatus();
    loadInsights();
    loadPosts();
  }, [loadStatus, loadInsights, loadPosts]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const configured = status?.configured && status?.ok;

  const submitPost = () => {
    const msg = message.trim();
    if (!msg) return;
    setPosting(true);
    api
      .post("/social/post", { message: msg, link: link.trim() || undefined })
      .then(() => {
        toast.success("Offer published to Facebook");
        setMessage("");
        setLink("");
        loadPosts();
        loadInsights();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setPosting(false));
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand/10 text-brand grid place-items-center">
            <FacebookLogo size={22} weight="fill" />
          </div>
          <div>
            <h1 className="font-sans text-[20px] font-bold tracking-tight text-foreground">Social</h1>
            <p className="text-[12.5px] text-muted">
              Publish offers, track engagement and reply to comments on your Facebook Page
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <div className="flex items-center gap-2 text-[12.5px]">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: configured ? "#1a5c38" : "#dc2626" }}
                aria-hidden="true"
              />
              <span className="font-semibold text-foreground">
                {configured ? (status.name || "Connected") : "Not connected"}
              </span>
              {configured && status.followers_count != null && (
                <span className="text-muted">· {fmtNum(status.followers_count)} followers</span>
              )}
            </div>
          )}
          <button type="button" className={btnGhost} onClick={refreshAll}>
            <ArrowClockwise size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Connection problem states */}
      {statusErr && <ErrorBox message={statusErr} />}
      {status && !status.configured && (
        <div className="card-white p-5">
          <SectionTitle title="Facebook is not connected" />
          <p className="mt-2 text-[13px] text-muted">
            A Facebook Page access token and Page ID are required to manage your
            Page from here. Once those credentials are configured, offers,
            insights and comments will appear on this page.
          </p>
        </div>
      )}
      {status?.configured && !status?.ok && (
        <ErrorBox
          message={status.detail || "Could not reach the Facebook Page. Check the access token."}
          onRetry={loadStatus}
        />
      )}

      {configured && (
        <>
          {/* Insights */}
          {insights && (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <KpiTile label="Followers" value={fmtNum(insights.followers_count)} icon={Users} />
              <KpiTile label="Posts analysed" value={fmtNum(insights.posts_analyzed)} icon={Megaphone} />
              <KpiTile label="Reactions" value={fmtNum(insights.total_reactions)} icon={ThumbsUp} />
              <KpiTile label="Comments" value={fmtNum(insights.total_comments)} icon={ChatCircle} />
              <KpiTile label="Shares" value={fmtNum(insights.total_shares)} icon={ShareNetwork} />
              <KpiTile label="Engagement" value={fmtNum(insights.total_engagement)} icon={FacebookLogo} />
            </div>
          )}

          {/* Offer composer */}
          <div className="card-white p-5">
            <SectionTitle title="Post an offer" />
            <p className="mt-1 mb-3 text-[12.5px] text-muted">
              This publishes immediately to your Facebook Page{status.name ? ` (${status.name})` : ""}.
            </p>
            <div className="space-y-3">
              <textarea
                className={inputCls + " min-h-[110px] resize-y"}
                placeholder="Write your offer or announcement…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <input
                className={inputCls}
                placeholder="Optional link (https://…)"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={posting || !message.trim()}
                  onClick={submitPost}
                >
                  <PaperPlaneTilt size={15} /> {posting ? "Publishing…" : "Publish to Facebook"}
                </button>
                <span className="text-[11.5px] text-muted">{message.trim().length} characters</span>
              </div>
            </div>
          </div>

          {/* Recent posts */}
          <div>
            <SectionTitle title="Recent posts" />
            <p className="mt-1 mb-3 text-[12.5px] text-muted">
              Expand a post to read its comments with AI-assigned sentiment and reply.
            </p>
            {postsLoading ? (
              <div className="py-6"><Loading label="Loading posts…" /></div>
            ) : postsErr ? (
              <ErrorBox message={postsErr} />
            ) : !posts.length ? (
              <Empty label="No posts on this Page yet." />
            ) : (
              <div className="space-y-3">
                {posts.map((p) => (
                  <PostCard key={p.id} post={p} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default Social;
