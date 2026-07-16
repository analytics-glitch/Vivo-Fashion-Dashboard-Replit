import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/useApi";

const API = "/api/chair";

const PRIORITY_COLOR = { critical: "#dc2626", high: "#d97706", medium: "#1a5c38", low: "#6b7280" };
const DESK_LABEL = {
  product: "Product", workforce: "Workforce", customer: "Customer",
  marketing: "Marketing", supply_chain: "Supply Chain",
  production_garment: "Production", retail: "Retail", cross: "Cross-Desk",
};

function PriorityBadge({ priority }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10,
      fontWeight: 700, background: (PRIORITY_COLOR[priority] || "#6b7280") + "22",
      color: PRIORITY_COLOR[priority] || "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em",
    }}>{priority}</span>
  );
}

function QuestionCard({ q, onAnswer, onRefresh }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const token = () => localStorage.getItem("vivo_token") || "";
  const answeredBy = () => localStorage.getItem("vivo_user_email") || "Stephen";

  async function submit() {
    if (!answer.trim()) return;
    setLoading(true);
    try {
      await fetch(`${API}/questions/${q.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
        body: JSON.stringify({ answer, answered_by: answeredBy() }),
      });
      setShowAnswer(false);
      setAnswer("");
      onRefresh?.();
    } catch(e) { console.error(e); }
    setLoading(false);
  }

  const isAnswered = q.status === "answered";

  return (
    <div style={{
      background: isAnswered ? "#f9fafb" : "#fff",
      borderRadius: 10,
      border: "1px solid #e5e7eb",
      borderLeft: `4px solid ${PRIORITY_COLOR[q.priority] || "#6b7280"}`,
      padding: "14px 18px",
      marginBottom: 12,
      opacity: isAnswered ? 0.8 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <PriorityBadge priority={q.priority} />
            {q.source_desk && (
              <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 500 }}>
                {DESK_LABEL[q.source_desk] || q.source_desk} Desk
              </span>
            )}
            <span style={{ fontSize: 11, color: "#d1d5db", marginLeft: "auto" }}>
              {q.run_date}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 14, color: "#1c1917", fontWeight: 500, lineHeight: 1.5 }}>
            {q.question}
          </p>
          {isAnswered && q.answer && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: "#f0fdf4", borderRadius: 6, borderLeft: "3px solid #1a5c38" }}>
              <div style={{ fontSize: 11, color: "#1a5c38", fontWeight: 700, marginBottom: 4 }}>
                {q.answered_by} · {q.answered_at ? new Date(q.answered_at).toLocaleDateString() : ""}
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{q.answer}</p>
            </div>
          )}
        </div>
        {!isAnswered && (
          <button onClick={() => setShowAnswer(s => !s)} style={{
            fontSize: 12, padding: "5px 14px", borderRadius: 5,
            background: showAnswer ? "#f3f4f6" : "#1a5c38",
            color: showAnswer ? "#374151" : "#fff",
            border: "none", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap",
          }}>
            {showAnswer ? "Cancel" : "Answer"}
          </button>
        )}
      </div>
      {showAnswer && !isAnswered && (
        <div style={{ marginTop: 10 }}>
          <textarea value={answer} onChange={e => setAnswer(e.target.value)}
            placeholder="Your answer or decision…"
            rows={3}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, resize: "none", boxSizing: "border-box" }} />
          <button onClick={submit} disabled={loading || !answer.trim()} style={{
            marginTop: 6, padding: "6px 16px", background: "#1a5c38", color: "#fff",
            border: "none", borderRadius: 5, cursor: "pointer", fontSize: 13, fontWeight: 600,
          }}>
            {loading ? "Saving…" : "Save Answer"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function TheChair() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);

  const token = () => localStorage.getItem("vivo_token") || "";

  async function triggerRun() {
    setRunning(true);
    setRunResult(null);
    try {
      const resp = await fetch(API + "/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
        body: JSON.stringify({}),
      });
      const result = await resp.json();
      setRunResult(result);
      qc.invalidateQueries([API + "/overview"]);
    } catch(e) {
      setRunResult({ error: String(e) });
    }
    setRunning(false);
  }

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load The Chair.</div>;

  const questions = data?.questions || [];
  const openQ = questions.filter(q => q.status === "open");
  const answeredQ = questions.filter(q => q.status === "answered");
  const synthesis = data?.synthesis;
  const deskSummary = data?.desk_issues_summary || [];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>The Chair</h1>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
            Weekly strategic synthesis across all AI Desks · Questions Register — as of {data?.as_of}
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <button onClick={triggerRun} disabled={running} style={{
            padding: "8px 18px", background: running ? "#9ca3af" : "#1a5c38",
            color: "#fff", border: "none", borderRadius: 6, cursor: running ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600,
          }}>
            {running ? "Running synthesis…" : "Run Weekly Synthesis"}
          </button>
          {data?.last_run && (
            <span style={{ fontSize: 11, color: "#9ca3af" }}>Last run: {data.last_run}</span>
          )}
        </div>
      </div>

      {runResult && (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: runResult.error ? "#fef2f2" : "#f0fdf4",
          border: `1px solid ${runResult.error ? "#fca5a5" : "#bbf7d0"}`, marginBottom: 16, fontSize: 13 }}>
          {runResult.error ? `Error: ${runResult.error}` :
            `Synthesis complete — ${runResult.questions_generated} questions generated. Preview: ${runResult.synthesis_preview}`}
        </div>
      )}

      {/* Weekly Synthesis */}
      {synthesis?.note && (
        <div style={{ background: "#fff8f0", border: "1px solid #fed7aa", borderRadius: 10, padding: "16px 20px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#d97706", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Weekly Synthesis
            </span>
            {synthesis.model && (
              <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto" }}>
                {synthesis.model} · {synthesis.generated_for}
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 14, color: "#374151", lineHeight: 1.7 }}>{synthesis.note}</p>
        </div>
      )}

      {/* Desk Issues Summary */}
      {deskSummary.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "14px 18px", marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Open Issues Across Desks</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {deskSummary.map((d, i) => (
              <div key={i} style={{ padding: "6px 12px", borderRadius: 6, background: "#f9fafb", fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: "#1c1917" }}>{DESK_LABEL[d.desk] || d.desk}</span>
                <span style={{ color: "#6b7280" }}>{d.open_count} open</span>
                {d.high_sev > 0 && <span style={{ color: "#dc2626", fontWeight: 700 }}>{d.high_sev} high</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open Questions */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>
          Open Questions for Stephen ({openQ.length})
        </div>
        {openQ.length === 0 ? (
          <div style={{ padding: "20px", background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
            No open questions. Run a synthesis to generate new ones.
          </div>
        ) : (
          openQ.map(q => (
            <QuestionCard key={q.id} q={q} onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
          ))
        )}
      </div>

      {/* Answered Questions */}
      {answeredQ.length > 0 && (
        <details>
          <summary style={{ fontSize: 13, color: "#9ca3af", cursor: "pointer", marginBottom: 10 }}>
            {answeredQ.length} answered questions
          </summary>
          {answeredQ.slice(0, 10).map(q => (
            <QuestionCard key={q.id} q={q} onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
          ))}
        </details>
      )}
    </div>
  );
}
