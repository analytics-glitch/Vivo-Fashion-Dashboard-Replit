/**
 * DeskShared.jsx — Shared UI components for all AI Desks (Phases 4-10).
 * Exports: DeskCoachingPanel, DeskIssuePanel, DeskGapPanel, KpiCard, SeverityBadge
 */
import { useState } from "react";

const SEV_COLOR = {
  critical: "#dc2626",
  high:     "#d97706",
  medium:   "#1a5c38",
  low:      "#6b7280",
};

const GAP_COLOR = {
  high:   "#dc2626",
  medium: "#d97706",
  low:    "#6b7280",
};

export function SeverityBadge({ severity }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: (SEV_COLOR[severity] || "#6b7280") + "22",
      color: SEV_COLOR[severity] || "#6b7280",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
    }}>
      {severity}
    </span>
  );
}

export function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: "#fff",
      borderRadius: 10,
      padding: "18px 22px",
      borderLeft: `4px solid ${color || "#1a5c38"}`,
      boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
      minWidth: 140,
      flex: 1,
    }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#1c1917" }}>{value ?? "—"}</div>
      {sub && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

const SEV_BORDER  = { critical: "#dc2626", high: "#d97706", medium: "#9ca3af", low: "#d1d5db" };
const SEV_BG      = { critical: "#fef2f2", high: "#fffbeb", medium: "#f9fafb", low: "#f9fafb" };
const SEV_BORDER2 = { critical: "#fca5a5", high: "#fde68a", medium: "#e5e7eb", low: "#e5e7eb" };
const PRIO_COLOR  = { high: "#dc2626", medium: "#d97706", low: "#6b7280" };

export function DeskCoachingPanel({ coaching, desk }) {
  const [expanded, setExpanded] = useState(true);
  const structured = coaching?.structured;
  const risks = structured?.risks || [];
  const opportunities = structured?.opportunities || [];
  const proposals = structured?.proposals || [];
  const criticalRisks = risks.filter(r => r.severity === "critical");
  const highRisks = risks.filter(r => r.severity === "high");
  const hasStructured = risks.length > 0 || opportunities.length > 0 || proposals.length > 0;
  const isPlaceholder = !coaching?.note || coaching.note.includes("not configured") || coaching.note.includes("unavailable");

  if (!coaching) return null;
  if (!hasStructured && isPlaceholder) return null;

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Escalation banner — shown even when collapsed */}
      {(criticalRisks.length > 0 || highRisks.length > 0) && (
        <div style={{
          background: criticalRisks.length > 0 ? "#fef2f2" : "#fffbeb",
          border: `1.5px solid ${criticalRisks.length > 0 ? "#fca5a5" : "#fde68a"}`,
          borderRadius: 8, padding: "9px 14px", marginBottom: 10,
          display: "flex", gap: 10, alignItems: "center",
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: criticalRisks.length > 0 ? "#dc2626" : "#d97706",
          }} />
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: criticalRisks.length > 0 ? "#991b1b" : "#92400e",
          }}>
            {criticalRisks.length > 0
              ? `ESCALATION — ${criticalRisks.length} critical risk${criticalRisks.length > 1 ? "s" : ""} require immediate attention`
              : `${highRisks.length} high-severity risk${highRisks.length > 1 ? "s" : ""} flagged — review proposals below`}
          </span>
        </div>
      )}

      {/* Panel header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: expanded ? 12 : 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#1a5c38", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          AI Intelligence — {desk} Desk
        </span>
        {coaching.model && (
          <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: "auto" }}>
            {coaching.model} · {coaching.generated_for}
          </span>
        )}
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
        >
          {expanded ? "hide" : "show"}
        </button>
      </div>

      {expanded && (
        <>
          {/* Risks + Opportunities — two-column grid */}
          {(risks.length > 0 || opportunities.length > 0) && (
            <div style={{
              display: "grid",
              gridTemplateColumns: risks.length > 0 && opportunities.length > 0 ? "1fr 1fr" : "1fr",
              gap: 12, marginBottom: proposals.length > 0 || coaching.note ? 12 : 0,
            }}>
              {risks.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                    Risks ({risks.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {risks.map((r, i) => (
                      <div key={i} style={{
                        background: SEV_BG[r.severity] || "#f9fafb",
                        border: `1px solid ${SEV_BORDER2[r.severity] || "#e5e7eb"}`,
                        borderLeft: `3px solid ${SEV_BORDER[r.severity] || "#9ca3af"}`,
                        borderRadius: 6, padding: "8px 10px",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span style={{
                            fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em",
                            color: SEV_BORDER[r.severity] || "#6b7280",
                          }}>{r.severity}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{r.title}</span>
                        </div>
                        {r.evidence && (
                          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, lineHeight: 1.4 }}>{r.evidence}</div>
                        )}
                        {r.action && (
                          <div style={{ fontSize: 11, color: "#1a5c38", fontWeight: 500 }}>Action: {r.action}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {opportunities.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#1a5c38", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                    Opportunities ({opportunities.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {opportunities.map((o, i) => (
                      <div key={i} style={{
                        background: "#f0fdf4", border: "1px solid #bbf7d0",
                        borderLeft: "3px solid #1a5c38", borderRadius: 6, padding: "8px 10px",
                      }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", marginBottom: 3 }}>{o.title}</div>
                        {o.evidence && (
                          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, lineHeight: 1.4 }}>{o.evidence}</div>
                        )}
                        {o.action && (
                          <div style={{ fontSize: 11, color: "#1a5c38", fontWeight: 500 }}>Action: {o.action}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Proposals */}
          {proposals.length > 0 && (
            <div style={{
              background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
              padding: "12px 14px", marginBottom: coaching.note ? 10 : 0,
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                Proposals
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {proposals.map((p, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{
                      fontSize: 9, fontWeight: 800, textTransform: "uppercase", whiteSpace: "nowrap",
                      marginTop: 2, color: PRIO_COLOR[p.priority] || "#6b7280",
                      minWidth: 40,
                    }}>{p.priority}</span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 12, color: "#111827" }}>{p.text}</span>
                      {p.timeframe && (
                        <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 8 }}>{p.timeframe}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary / plain note */}
          {coaching.note && !isPlaceholder && (
            <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6, fontStyle: "italic" }}>
              {coaching.note}
            </div>
          )}

          {/* Plain text fallback when no structured data */}
          {!hasStructured && coaching.note && !isPlaceholder && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "12px 14px" }}>
              <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.6 }}>{coaching.note}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function DeskGapPanel({ gaps }) {
  if (!gaps || gaps.length === 0) return null;
  return (
    <div style={{
      background: "#fff",
      borderRadius: 10,
      border: "1px solid #e5e7eb",
      padding: "16px 20px",
      marginBottom: 20,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
        Data Gaps Registered
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {gaps.map((g, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 12px", background: "#f9fafb", borderRadius: 6, borderLeft: `3px solid ${GAP_COLOR[g.impact] || "#6b7280"}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1c1917" }}>{g.gap_name?.replace(/_/g," ")}</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{g.details}</div>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, color: GAP_COLOR[g.impact] || "#6b7280", textTransform: "uppercase", whiteSpace: "nowrap" }}>{g.impact}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DeskIssuePanel({ issues = [], desk, apiBase, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", severity: "medium", owner_email: "" });
  const [loading, setLoading] = useState(false);

  const token = () => localStorage.getItem("vivo_token") || "";

  async function handleCreate() {
    if (!form.title.trim()) return;
    setLoading(true);
    try {
      await fetch(apiBase + "/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
        body: JSON.stringify(form),
      });
      setForm({ title: "", body: "", severity: "medium", owner_email: "" });
      setShowAdd(false);
      onRefresh?.();
    } catch(e) { console.error(e); }
    setLoading(false);
  }

  async function handleClose(id) {
    const by = localStorage.getItem("vivo_user_email") || "leadership";
    await fetch(`${apiBase}/issues/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
      body: JSON.stringify({ closed_by: by }),
    });
    onRefresh?.();
  }

  const open = issues.filter(i => i.status === "open");
  const closed = issues.filter(i => i.status === "closed").slice(0, 5);

  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Issue Register — {open.length} open
        </span>
        <button onClick={() => setShowAdd(s => !s)} style={{
          marginLeft: "auto", fontSize: 12, padding: "4px 12px", borderRadius: 5,
          background: showAdd ? "#f3f4f6" : "#1a5c38", color: showAdd ? "#374151" : "#fff",
          border: "none", cursor: "pointer", fontWeight: 600,
        }}>
          {showAdd ? "Cancel" : "+ Add Issue"}
        </button>
      </div>

      {showAdd && (
        <div style={{ background: "#f9fafb", borderRadius: 8, padding: 14, marginBottom: 12 }}>
          <input value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))}
            placeholder="Issue title"
            style={{ width: "100%", padding: "6px 10px", borderRadius: 5, border: "1px solid #d1d5db", fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
          <textarea value={form.body} onChange={e => setForm(f => ({...f, body: e.target.value}))}
            placeholder="Details (optional)"
            rows={2}
            style={{ width: "100%", padding: "6px 10px", borderRadius: 5, border: "1px solid #d1d5db", fontSize: 13, marginBottom: 8, boxSizing: "border-box", resize: "none" }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <select value={form.severity} onChange={e => setForm(f => ({...f, severity: e.target.value}))}
              style={{ flex: 1, padding: "6px 8px", borderRadius: 5, border: "1px solid #d1d5db", fontSize: 13 }}>
              {["low","medium","high","critical"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input value={form.owner_email} onChange={e => setForm(f => ({...f, owner_email: e.target.value}))}
              placeholder="Owner email (optional)"
              style={{ flex: 2, padding: "6px 10px", borderRadius: 5, border: "1px solid #d1d5db", fontSize: 13 }} />
          </div>
          <button onClick={handleCreate} disabled={loading || !form.title.trim()}
            style={{ padding: "6px 18px", background: "#1a5c38", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {loading ? "Saving…" : "Save Issue"}
          </button>
        </div>
      )}

      {open.length === 0 && !showAdd && (
        <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>No open issues.</p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {open.map(issue => (
          <div key={issue.id} style={{
            display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px",
            background: issue.source === "auto" ? "#fffbeb" : "#f9fafb",
            borderRadius: 6, borderLeft: `3px solid ${SEV_COLOR[issue.severity] || "#6b7280"}`,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1c1917" }}>
                {issue.source === "auto" && <span style={{ fontSize: 10, fontWeight: 700, color: "#d97706", marginRight: 6 }}>AUTO</span>}
                {issue.title}
              </div>
              {issue.body && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{issue.body}</div>}
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>
                {new Date(issue.opened_at).toLocaleDateString()} · <SeverityBadge severity={issue.severity} />
                {issue.owner_email && ` · ${issue.owner_email}`}
              </div>
            </div>
            <button onClick={() => handleClose(issue.id)} style={{
              fontSize: 11, padding: "3px 10px", borderRadius: 4, border: "1px solid #d1d5db",
              background: "#fff", cursor: "pointer", color: "#374151", whiteSpace: "nowrap",
            }}>Close</button>
          </div>
        ))}
        {closed.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ fontSize: 12, color: "#9ca3af", cursor: "pointer" }}>
              {closed.length} recently closed
            </summary>
            {closed.map(issue => (
              <div key={issue.id} style={{ padding: "6px 10px", fontSize: 12, color: "#9ca3af", textDecoration: "line-through" }}>
                {issue.title}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
