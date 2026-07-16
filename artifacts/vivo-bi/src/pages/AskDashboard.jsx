/**
 * AskDashboard — /ask page.
 *
 * Snapshot-grounded Q&A using the day's live business data.
 * Model: claude-sonnet-4-5 (Anthropic, server-side). No streaming.
 * Evidence snapshot is shown in a collapsible "Data used" section.
 */
import React, { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Sparkle, PaperPlaneTilt, CaretDown, CaretUp, Warning } from "@phosphor-icons/react";
import { Loading } from "@/components/common";

const PLACEHOLDERS = [
  "Which store had the highest sales this morning?",
  "How many transactions across all stores today?",
  "What is the average basket size today vs last week?",
  "Which store is tracking furthest below baseline today?",
  "How many loyalty sign-ups so far today?",
];

function placeholder() {
  return PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
}

export default function AskDashboard() {
  const [question, setQuestion]     = useState("");
  const [result, setResult]         = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [configured, setConfigured] = useState(true);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const textareaRef = useRef(null);
  const ph          = useRef(placeholder());

  const submit = async () => {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setShowSnapshot(false);
    try {
      const res = await api.post("/ai/ask", { question: q });
      setResult(res.data);
    } catch (e) {
      if (e?.response?.status === 503 || e?.response?.data?.configured === false) {
        setConfigured(false);
      } else {
        setError(
          e?.response?.data?.error ||
          "Could not reach the AI service. Please try again in a moment."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Sparkle size={18} weight="duotone" className="text-brand" />
        </div>
        <div>
          <h1 className="text-[22px] font-bold text-foreground leading-tight">Ask the Dashboard</h1>
          <p className="text-[13px] text-muted mt-0.5">
            Ask questions about today's sales, footfall, and performance.
            Answers are grounded in live business data — not general knowledge.
          </p>
        </div>
      </div>

      {/* Not configured notice */}
      {!configured && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <Warning size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-[12.5px] text-amber-800">
            <p className="font-semibold">AI not configured</p>
            <p className="mt-0.5 opacity-80">
              The <code className="bg-amber-100 rounded px-0.5">ANTHROPIC_API_KEY</code> deployment secret is not set.
              Add it in the deployment settings and republish.
            </p>
          </div>
        </div>
      )}

      {/* Input card */}
      <div className="card-white p-5 space-y-3">
        <label className="text-[12px] font-semibold text-muted uppercase tracking-wide">
          Your question
        </label>
        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKey}
          placeholder={ph.current}
          rows={3}
          maxLength={600}
          disabled={loading || !configured}
          className="w-full text-[13.5px] border border-border/60 rounded-lg px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/40 disabled:opacity-50 placeholder:text-muted/40"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted/50">
            {question.length > 0 ? `${question.length}/600 · ` : ""}
            Cmd+Enter to submit
          </span>
          <button
            onClick={submit}
            disabled={!question.trim() || loading || !configured}
            className="flex items-center gap-1.5 bg-brand text-white text-[13px] font-semibold px-4 py-1.5 rounded-lg hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Thinking…
              </>
            ) : (
              <>
                <PaperPlaneTilt size={14} weight="bold" />
                Ask
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-[12.5px] text-red-800">
          <Warning size={14} className="flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Answer */}
      {loading && (
        <div className="card-white p-6 flex items-center justify-center">
          <Loading label="Analysing today's data…" />
        </div>
      )}

      {result && !loading && (
        <div className="card-white p-5 space-y-4">
          {/* Answer text */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkle size={13} weight="duotone" className="text-brand" />
              <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">Answer</span>
              <span className="text-[10px] text-muted/50 ml-auto">{result.date}</span>
            </div>
            <p className="text-[14px] text-foreground leading-relaxed whitespace-pre-wrap">
              {result.answer}
            </p>
          </div>

          {/* Data used collapsible */}
          {result.snapshot && (
            <div className="border-t border-border/30 pt-3">
              <button
                onClick={() => setShowSnapshot((v) => !v)}
                className="flex items-center gap-1 text-[11.5px] text-muted hover:text-foreground transition-colors"
              >
                {showSnapshot ? <CaretUp size={12} /> : <CaretDown size={12} />}
                Data used to answer this
              </button>
              {showSnapshot && (
                <pre className="mt-2 text-[10.5px] text-muted/80 bg-sand/60 border border-border/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed font-mono">
                  {result.snapshot}
                </pre>
              )}
            </div>
          )}

          {/* New question shortcut */}
          <div className="border-t border-border/30 pt-3">
            <button
              onClick={() => {
                setResult(null);
                setQuestion("");
                setTimeout(() => textareaRef.current?.focus(), 50);
              }}
              className="text-[12px] text-brand hover:underline"
            >
              Ask another question
            </button>
          </div>
        </div>
      )}

      {/* Tip card (shown when no result yet) */}
      {!result && !loading && (
        <div className="rounded-lg border border-border/40 bg-sand/30 px-4 py-3">
          <p className="text-[11.5px] text-muted font-semibold mb-1.5">What you can ask</p>
          <ul className="space-y-1 text-[11.5px] text-muted/80">
            <li>· Sales totals, transaction counts, average basket for any store today</li>
            <li>· Footfall and conversion rates by store</li>
            <li>· Loyalty sign-ups, redemptions or reactivations today</li>
            <li>· Which stores are above or below their normal baseline today</li>
            <li>· 7-day rolling sales or trend questions</li>
          </ul>
          <p className="mt-2 text-[10.5px] text-muted/50">
            Answers draw from live data as of today. Historical deep-dives are better served by the BI pages.
          </p>
        </div>
      )}
    </div>
  );
}
