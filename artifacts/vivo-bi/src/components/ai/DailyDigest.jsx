/**
 * DailyDigest — Today's AI-ranked insight cards on the Overview page.
 *
 * Fetches GET /api/ai/insights (today, ranked by revenue_impact desc).
 * Collapsible panel: open by default, collapses to a count badge.
 * Store filter, thumbs up/down feedback, weekly stats strip.
 * Gracefully hidden when AI is not configured (no key set).
 */
import React, { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  ThumbsUp,
  ThumbsDown,
  CaretDown,
  CaretUp,
  Sparkle,
  ArrowUp,
  ArrowDown,
  X,
} from "@phosphor-icons/react";

// ── Severity colour / icon ────────────────────────────────────────────────────

function insightColour(insightType, sigma) {
  const absZ = Math.abs(sigma || 0);
  if (insightType === "dip") {
    return absZ >= 3 ? "text-red-600"    : "text-orange-500";
  }
  return absZ >= 3 ? "text-emerald-600" : "text-blue-600";
}

function InsightArrow({ insightType }) {
  if (insightType === "dip")
    return <ArrowDown weight="bold" className="inline w-3.5 h-3.5 text-orange-500 mr-0.5" />;
  return <ArrowUp weight="bold" className="inline w-3.5 h-3.5 text-emerald-600 mr-0.5" />;
}

// ── Evidence chip ─────────────────────────────────────────────────────────────

function EvidenceChip({ evidence, metricLabel }) {
  if (!evidence) return null;
  const { today, baseline, delta_pct, window: win } = evidence;
  if (today === undefined || baseline === undefined) return null;

  const pct  = delta_pct != null ? Math.abs(delta_pct).toFixed(1) : null;
  const dirn = (delta_pct || 0) >= 0 ? "above" : "below";
  const fmtN = (v) =>
    v === null || v === undefined ? "—"
    : Math.abs(v) >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : Math.abs(v) >= 1_000
      ? `${(v / 1_000).toFixed(0)}K`
      : String(Number(v).toFixed(1));

  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] bg-sand/60 border border-border/40 rounded px-1.5 py-0.5 text-muted font-mono whitespace-nowrap">
      {pct && <>{pct}% {dirn} {win || "baseline"} · </>}
      <span className="text-foreground/70">{fmtN(today)}</span>
      <span className="opacity-50">vs</span>
      <span>{fmtN(baseline)}</span>
    </span>
  );
}

// ── Single insight card ───────────────────────────────────────────────────────

function InsightCard({ insight, onFeedback, onView }) {
  const [open, setOpen]       = useState(false);
  const [voting, setVoting]   = useState(false);
  const [myVote, setMyVote]   = useState(insight.my_feedback);
  const [counts, setCounts]   = useState({
    useful:     insight.useful_count     || 0,
    not_useful: insight.not_useful_count || 0,
  });

  // Fire view ping when card is first expanded
  const handleExpand = () => {
    if (!open) onView(insight.id);
    setOpen((v) => !v);
  };

  const handleVote = async (signal) => {
    if (voting) return;
    const prev = myVote;
    setMyVote(signal);
    setCounts((c) => {
      const next = { ...c };
      if (prev) next[prev] = Math.max(0, next[prev] - 1);
      next[signal] = (next[signal] || 0) + 1;
      return next;
    });
    setVoting(true);
    try {
      await onFeedback(insight.id, signal);
    } catch {
      setMyVote(prev);
      setCounts(({ useful, not_useful }) => ({
        useful:     insight.useful_count     || 0,
        not_useful: insight.not_useful_count || 0,
      }));
    } finally {
      setVoting(false);
    }
  };

  const col = insightColour(insight.insight_type, insight.sigma);

  return (
    <div className="border border-border/50 rounded-lg bg-white overflow-hidden">
      {/* Header row */}
      <button
        onClick={handleExpand}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-sand/30 transition-colors"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] font-semibold leading-snug ${col}`}>
            <InsightArrow insightType={insight.insight_type} />
            {insight.headline}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <span className="text-[10px] bg-sand/70 border border-border/30 rounded px-1.5 py-px text-muted font-medium">
              {insight.store}
            </span>
            <span className="text-[10px] bg-sand/70 border border-border/30 rounded px-1.5 py-px text-muted font-medium">
              {insight.metric_label}
            </span>
            <EvidenceChip evidence={insight.evidence} metricLabel={insight.metric_label} />
          </div>
        </div>
        <div className="flex-shrink-0 mt-0.5 text-muted">
          {open ? <CaretUp size={14} /> : <CaretDown size={14} />}
        </div>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="px-4 pb-3 border-t border-border/30 pt-2.5">
          {insight.body && (
            <p className="text-[12.5px] text-foreground/80 leading-relaxed mb-3">
              {insight.body}
            </p>
          )}
          {/* Feedback buttons */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted">Was this useful?</span>
            <button
              onClick={() => handleVote("useful")}
              disabled={voting}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                myVote === "useful"
                  ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                  : "border-border/40 text-muted hover:border-emerald-300 hover:text-emerald-600"
              }`}
            >
              <ThumbsUp size={12} weight={myVote === "useful" ? "fill" : "regular"} />
              <span>{counts.useful > 0 ? counts.useful : ""}</span>
            </button>
            <button
              onClick={() => handleVote("not_useful")}
              disabled={voting}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                myVote === "not_useful"
                  ? "border-red-400 bg-red-50 text-red-700"
                  : "border-border/40 text-muted hover:border-red-300 hover:text-red-600"
              }`}
            >
              <ThumbsDown size={12} weight={myVote === "not_useful" ? "fill" : "regular"} />
              <span>{counts.not_useful > 0 ? counts.not_useful : ""}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DailyDigest() {
  const { user } = useAuth();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [storeFilter, setStore] = useState("");

  const fetchInsights = useCallback(async (store) => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (store) params.store = store;
      const res = await api.get("/ai/insights", { params });
      setData(res.data);
    } catch (e) {
      // 503 = AI not configured; treat as "no data" rather than error
      if (e?.response?.status === 503 || e?.response?.data?.configured === false) {
        setData({ configured: false, insights: [], week_stats: { useful: 0, not_useful: 0 } });
      } else if (e?.response?.status !== 404) {
        setError("Could not load insights");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInsights(storeFilter);
  }, [fetchInsights, storeFilter]);

  const handleFeedback = useCallback(async (id, signal) => {
    await api.post(`/ai/insights/${id}/feedback`, { signal });
  }, []);

  const handleView = useCallback(async (id) => {
    try {
      await api.post(`/ai/insights/${id}/view`);
    } catch {
      // best-effort
    }
  }, []);

  // Not configured → silent (no banner)
  if (!loading && data && data.configured === false) return null;

  // Error → silent (don't break Overview)
  if (!loading && error) return null;

  const insights    = data?.insights || [];
  const weekStats   = data?.week_stats || { useful: 0, not_useful: 0 };
  const totalVotes  = weekStats.useful + weekStats.not_useful;

  // Get unique stores from today's insights for the filter dropdown
  const stores = [...new Set(insights.map((i) => i.store))].sort();

  if (!loading && insights.length === 0 && !storeFilter) return null;

  return (
    <div className="card-white p-5" data-testid="daily-digest-section">
      {/* Panel header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkle size={16} weight="duotone" className="text-brand" />
          <span className="text-[13px] font-bold text-foreground">Today's Insights</span>
          {!loading && insights.length > 0 && (
            <span className="text-[10px] bg-brand/10 text-brand font-semibold rounded-full px-1.5 py-px">
              {insights.length}
            </span>
          )}
          <span className="text-[10px] text-muted/60 font-normal">
            AI-ranked by severity &amp; revenue impact
          </span>
        </div>
        <div className="flex items-center gap-2">
          {stores.length > 1 && !collapsed && (
            <select
              value={storeFilter}
              onChange={(e) => setStore(e.target.value)}
              className="text-[11px] border border-border/50 rounded px-1.5 py-0.5 bg-white text-muted focus:outline-none"
            >
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="text-[11px] text-muted hover:text-foreground flex items-center gap-0.5 transition-colors"
          >
            {collapsed ? (
              <>
                <CaretDown size={12} /> Show
              </>
            ) : (
              <>
                <CaretUp size={12} /> Hide
              </>
            )}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 rounded-lg bg-sand/50 animate-pulse" />
              ))}
            </div>
          ) : insights.length === 0 ? (
            <p className="text-[12px] text-muted text-center py-4">
              {storeFilter
                ? `No anomalies for ${storeFilter} today.`
                : "No significant anomalies detected today. Performance is tracking within normal range."}
            </p>
          ) : (
            <div className="space-y-2">
              {insights.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  onFeedback={handleFeedback}
                  onView={handleView}
                />
              ))}
            </div>
          )}

          {/* Weekly feedback stats strip */}
          {totalVotes > 0 && (
            <div className="mt-3 pt-3 border-t border-border/30 flex items-center gap-2 text-[10.5px] text-muted">
              <Sparkle size={11} className="text-brand/50" />
              <span>This week:</span>
              <span className="text-emerald-600 font-medium">{weekStats.useful} useful</span>
              <span>/</span>
              <span className="text-red-500 font-medium">{weekStats.not_useful} not useful</span>
              <span className="opacity-50">· feedback shapes future thresholds</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
