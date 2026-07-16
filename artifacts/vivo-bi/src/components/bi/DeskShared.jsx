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

export function DeskCoachingPanel({ coaching, desk }) {
  if (!coaching || !coaching.note) return null;
  const isPlaceholder = coaching.note.includes("not configured") || coaching.note.includes("unavailable");
  return (
    <div style={{
      background: isPlaceholder ? "#f9fafb" : "#f0fdf4",
      border: `1px solid ${isPlaceholder ? "#e5e7eb" : "#bbf7d0"}`,
      borderRadius: 10,
      padding: "16px 20px",
      marginBottom: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: isPlaceholder ? "#9ca3af" : "#1a5c38", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          AI Coaching — {desk} Desk
        </span>
        {coaching.model && (
          <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto" }}>
            {coaching.model} · {coaching.generated_for}
          </span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "#374151", lineHeight: 1.6 }}>
        {coaching.note}
      </p>
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
