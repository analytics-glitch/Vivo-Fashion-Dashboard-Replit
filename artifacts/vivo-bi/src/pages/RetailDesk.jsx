import React, { useState, useMemo, useCallback } from "react";
import { useApi } from "@/lib/useApi";
import { DeskCoachingPanel } from "@/components/bi/DeskShared";

// ── Helpers ───────────────────────────────────────────────────────────────────

const KES = (v) =>
  v == null ? "—" : `KES ${Math.abs(v) >= 1_000_000
    ? (v / 1_000_000).toFixed(1) + "M"
    : Math.abs(v) >= 1_000
    ? (v / 1_000).toFixed(0) + "k"
    : Number(v).toFixed(0)}`;

const PCT = (v) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

// ── 4-bucket status model ─────────────────────────────────────────────────────

const STATUS_LABEL = {
  act_now:      "Act Now",
  watch:        "Watch",
  on_track:     "On Track",
  outperforming:"Outperforming",
  // legacy aliases (should not appear but handled gracefully)
  behind:       "Act Now",
  at_risk:      "Watch",
  ahead:        "On Track",
  unknown:      "Unknown",
};
const STATUS_COLOR = {
  act_now:      "#dc2626",
  watch:        "#d97706",
  on_track:     "#1a5c38",
  outperforming:"#0f766e",
  behind:       "#dc2626",
  at_risk:      "#d97706",
  ahead:        "#1a5c38",
  unknown:      "#6b7280",
};
const STATUS_BG = {
  act_now:      "#fef2f2",
  watch:        "#fffbeb",
  on_track:     "#f0fdf4",
  outperforming:"#f0fdfa",
  behind:       "#fef2f2",
  at_risk:      "#fffbeb",
  ahead:        "#f0fdf4",
  unknown:      "#f9fafb",
};
const SEV_COLOR   = { high: "#dc2626", medium: "#d97706", low: "#6b7280" };
const COUNTRY_COLOR = { Kenya: "#1a5c38", Uganda: "#d97706", Rwanda: "#00c853" };
const CONF_COLOR    = { high: "#1a5c38", medium: "#d97706", low: "#9ca3af" };
const OUTCOME_LABEL = { pending: "Pending", accurate: "Accurate", inaccurate: "Inaccurate", partial: "Partial" };
const OUTCOME_COLOR = { pending: "#9ca3af", accurate: "#1a5c38", inaccurate: "#dc2626", partial: "#d97706" };
const VERDICT_STYLE = {
  performing:     { bg: "#f0fdf4", border: "#86efac", color: "#166534", label: "Performing" },
  underperforming:{ bg: "#fef2f2", border: "#fca5a5", color: "#991b1b", label: "Underperforming" },
  mixed:          { bg: "#fffbeb", border: "#fde68a", color: "#92400e", label: "Mixed" },
};

// ── Small UI atoms ────────────────────────────────────────────────────────────

function StatusBadge({ status, size = "sm" }) {
  const color = STATUS_COLOR[status] || "#6b7280";
  const bg    = STATUS_BG[status]    || "#f9fafb";
  return (
    <span style={{
      background: bg, color, border: `1px solid ${color}`,
      borderRadius: 4,
      padding: size === "lg" ? "5px 12px" : "2px 8px",
      fontSize: size === "lg" ? 13 : 11,
      fontWeight: 700, letterSpacing: "0.02em", whiteSpace: "nowrap",
    }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function CountryDot({ country }) {
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: COUNTRY_COLOR[country] || "#94a3b8", marginRight: 5, flexShrink: 0,
    }} />
  );
}

function MiniBar({ value, max, color = "#1a5c38" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.3s" }} />
    </div>
  );
}

function FleetKPI({ label, value, sub, color }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "14px 18px" }}>
      <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 500, letterSpacing: "0.04em",
        textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em",
      textTransform: "uppercase", marginBottom: 8 }}>
      {children}
    </div>
  );
}

function TrendArrow({ pct, size = 12 }) {
  if (pct == null) return <span style={{ fontSize: size, color: "#9ca3af" }}>—</span>;
  const up   = pct >= 0;
  return (
    <span style={{ fontSize: size, fontWeight: 700, color: up ? "#1a5c38" : "#dc2626" }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

// ── Exception queue row ───────────────────────────────────────────────────────

function QueueRow({ card, onClick, showIssue = true }) {
  const gapColor = STATUS_COLOR[card.status] || "#6b7280";
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
        cursor: "pointer", borderRadius: 6, borderLeft: `3px solid ${gapColor}`,
        background: "#fff", border: `1px solid #e5e7eb`, borderLeftColor: gapColor,
        borderLeftWidth: 3, transition: "box-shadow 0.12s",
      }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.07)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      {/* Store identity */}
      <div style={{ width: 200, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <CountryDot country={card.country} />
          <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{card.store}</span>
        </div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>
          {card.share_pct?.toFixed(1)}% of fleet
        </div>
      </div>

      {/* Top issue or win description */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {showIssue && card.top_issue ? (
          <>
            <div style={{ fontSize: 12, color: "#111827", fontWeight: 500,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {card.top_issue.title}
            </div>
            {card.top_issue.owner_role && (
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>
                Owner: {card.top_issue.owner_role}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
            {card.status === "outperforming"
              ? `${PCT(card.gap_pct)} ahead of path · MoM ${PCT(card.mom_pct)}`
              : card.open_issues > 0
              ? `${card.open_issues} open issue${card.open_issues > 1 ? "s" : ""}`
              : "No flagged issues"}
          </div>
        )}
      </div>

      {/* KES at stake */}
      <div style={{ width: 100, textAlign: "right", flexShrink: 0 }}>
        {card.open_issues_kes > 0 ? (
          <>
            <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>KES at stake</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: gapColor }}>
              {KES(card.open_issues_kes)}
            </div>
          </>
        ) : card.gap_kes < 0 ? (
          <>
            <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>MTD gap</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: gapColor }}>
              {KES(card.gap_kes)}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>MTD ahead</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1a5c38" }}>
              {KES(card.gap_kes)}
            </div>
          </>
        )}
      </div>

      {/* MoM trend */}
      <div style={{ width: 70, textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: "#9ca3af" }}>MoM</div>
        <TrendArrow pct={card.mom_pct} size={11} />
      </div>

      {/* Issues badge */}
      <div style={{ width: 48, textAlign: "right", flexShrink: 0 }}>
        {card.open_issues > 0 && (
          <span style={{ fontSize: 11, background: "#fef2f2", color: "#dc2626",
            border: "1px solid #fecaca", borderRadius: 4, padding: "2px 6px", fontWeight: 700 }}>
            {card.open_issues}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Exception queues block ────────────────────────────────────────────────────

function ExceptionQueues({ queues, onSelectStore }) {
  const { act_now = [], watch = [], wins = [] } = queues || {};

  const QueueSection = ({ title, items, accentColor, emptyMsg, showIssue }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: accentColor,
          display: "inline-block", flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          textTransform: "uppercase", color: accentColor }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>
          — {items.length} store{items.length !== 1 ? "s" : ""}
        </span>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9ca3af", paddingLeft: 16, fontStyle: "italic" }}>
          {emptyMsg}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map(card => (
            <QueueRow
              key={card.store}
              card={card}
              onClick={() => onSelectStore(card.store)}
              showIssue={showIssue}
            />
          ))}
        </div>
      )}
    </div>
  );

  if (!act_now.length && !watch.length && !wins.length) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
      padding: "18px 20px", marginBottom: 24 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 16,
        display: "flex", alignItems: "center", gap: 8 }}>
        Exception Queues
        <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>— ranked by KES impact</span>
      </div>
      <QueueSection
        title="Act Now"
        items={act_now}
        accentColor="#dc2626"
        emptyMsg="No stores require immediate action."
        showIssue={true}
      />
      <QueueSection
        title="Watch"
        items={watch}
        accentColor="#d97706"
        emptyMsg="No stores flagged for close monitoring."
        showIssue={true}
      />
      <QueueSection
        title="Outperforming"
        items={wins}
        accentColor="#0f766e"
        emptyMsg="No outperforming stores yet."
        showIssue={false}
      />
    </div>
  );
}

// ── Issue components ──────────────────────────────────────────────────────────

function IssueRow({ issue, onStatusChange, onClose }) {
  const [acting, setActing] = useState(false);
  const daysSince = issue.opened_at
    ? Math.floor((Date.now() - new Date(issue.opened_at).getTime()) / 86400000)
    : 0;
  const stale = daysSince > 7 && issue.status === "open";

  const updateStatus = async (newStatus) => {
    setActing(true);
    try {
      if (newStatus === "closed") {
        await fetch(`/api/retail-desk/issues/${issue.id}/close`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          credentials: "include", body: JSON.stringify({}),
        });
      } else {
        await fetch(`/api/retail-desk/issues/${issue.id}/status`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          credentials: "include", body: JSON.stringify({ status: newStatus }),
        });
      }
      onStatusChange?.();
    } finally {
      setActing(false);
    }
  };

  const statusColor = {
    open: "#6b7280", acknowledged: "#d97706", in_progress: "#2563eb", closed: "#1a5c38"
  }[issue.status] || "#6b7280";

  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid #f3f4f6" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", marginTop: 6, flexShrink: 0,
          background: SEV_COLOR[issue.severity] || "#6b7280" }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{issue.title}</div>
              {issue.body && (
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, whiteSpace: "pre-line",
                  maxHeight: 60, overflow: "hidden" }}>
                  {issue.body}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                {issue.kes_impact > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#dc2626" }}>
                    {KES(issue.kes_impact)} at stake
                  </span>
                )}
                {issue.owner_role && (
                  <span style={{ fontSize: 11, color: "#6b7280" }}>Owner: {issue.owner_role}</span>
                )}
                <span style={{ fontSize: 11, color: stale ? "#d97706" : "#9ca3af", fontWeight: stale ? 600 : 400 }}>
                  {stale ? `Stale — ${daysSince}d` : `${daysSince}d ago`}
                  {issue.source === "auto" && " · auto"}
                  {issue.rule_key && ` · ${issue.rule_key.replace(/_/g, " ")}`}
                </span>
                <span style={{ fontSize: 11, color: statusColor, fontWeight: 600, textTransform: "capitalize" }}>
                  {(issue.status || "open").replace("_", " ")}
                </span>
              </div>
            </div>
            {/* Status action buttons */}
            {issue.status !== "closed" && (
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {issue.status === "open" && (
                  <button onClick={() => updateStatus("acknowledged")} disabled={acting}
                    style={{ fontSize: 10, color: "#d97706", background: "#fffbeb",
                      border: "1px solid #fde68a", borderRadius: 4, padding: "2px 7px",
                      cursor: "pointer", fontWeight: 600, opacity: acting ? 0.5 : 1 }}>
                    Acknowledge
                  </button>
                )}
                {issue.status !== "in_progress" && (
                  <button onClick={() => updateStatus("in_progress")} disabled={acting}
                    style={{ fontSize: 10, color: "#2563eb", background: "#eff6ff",
                      border: "1px solid #bfdbfe", borderRadius: 4, padding: "2px 7px",
                      cursor: "pointer", fontWeight: 600, opacity: acting ? 0.5 : 1 }}>
                    In Progress
                  </button>
                )}
                <button onClick={() => updateStatus("closed")} disabled={acting}
                  style={{ fontSize: 10, color: "#6b7280", background: "none",
                    border: "1px solid #e5e7eb", borderRadius: 4, padding: "2px 7px",
                    cursor: "pointer", opacity: acting ? 0.5 : 1 }}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewIssueForm({ store, onSaved }) {
  const [title, setTitle]   = useState("");
  const [body,  setBody]    = useState("");
  const [sev,   setSev]     = useState("medium");
  const [owner, setOwner]   = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const r = await fetch("/api/retail-desk/issues", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ store, title, body, severity: sev, owner_email: owner }),
      });
      if (r.ok) { setTitle(""); setBody(""); setOwner(""); onSaved(); }
    } finally { setSaving(false); }
  };

  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8,
      padding: 14, marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Add issue</div>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Issue title"
        style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 4, padding: "6px 8px",
          fontSize: 12, marginBottom: 6, boxSizing: "border-box" }} />
      <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Description (optional)"
        rows={2}
        style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 4, padding: "6px 8px",
          fontSize: 12, marginBottom: 6, boxSizing: "border-box", resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={sev} onChange={e => setSev(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 8px", fontSize: 12 }}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <input value={owner} onChange={e => setOwner(e.target.value)}
          placeholder="Owner (optional)" style={{ flex: 1, border: "1px solid #d1d5db",
            borderRadius: 4, padding: "4px 8px", fontSize: 12 }} />
        <button onClick={save} disabled={saving || !title.trim()}
          style={{ background: "#1a5c38", color: "#fff", border: "none", borderRadius: 4,
            padding: "5px 14px", fontSize: 12, cursor: "pointer",
            opacity: (saving || !title.trim()) ? 0.5 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function CorrectionForm({ store, onSaved }) {
  const [text, setText]    = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/retail-desk/store/${encodeURIComponent(store)}/correction`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ correction_text: text }),
      });
      if (r.ok) { setText(""); onSaved(); }
    } finally { setSaving(false); }
  };
  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: 12, marginTop: 8 }}>
      <textarea value={text} onChange={e => setText(e.target.value)}
        placeholder="Describe the correction — what was wrong and what the AI should know"
        rows={3}
        style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 4, padding: "6px 8px",
          fontSize: 12, marginBottom: 8, boxSizing: "border-box", resize: "vertical" }} />
      <button onClick={save} disabled={saving || !text.trim()}
        style={{ background: "#1a5c38", color: "#fff", border: "none", borderRadius: 4,
          padding: "5px 14px", fontSize: 12, cursor: "pointer",
          opacity: (saving || !text.trim()) ? 0.5 : 1 }}>
        {saving ? "Submitting…" : "Submit correction"}
      </button>
    </div>
  );
}

// ── Analysis sub-components ────────────────────────────────────────────────────

function MetricRow({ item, variant }) {
  const isGood  = variant === "working";
  const accent  = isGood ? "#1a5c38" : "#dc2626";
  const accentBg= isGood ? "#f0fdf4" : "#fef2f2";
  return (
    <div style={{ background: accentBg, border: `1px solid ${isGood ? "#bbf7d0" : "#fecaca"}`,
      borderRadius: 6, padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: accent }}>{item.metric}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{item.value}</span>
            {item.variance && (
              <span style={{ fontSize: 11, color: "#6b7280" }}>({item.variance} vs {item.benchmark})</span>
            )}
          </div>
          {item.driver && <div style={{ fontSize: 11, color: accent, marginTop: 3 }}>{item.driver}</div>}
          {item.root_cause && <div style={{ fontSize: 11, color: "#dc2626", marginTop: 3, fontStyle: "italic" }}>{item.root_cause}</div>}
          {item.action && (
            <div style={{ fontSize: 11, color: "#374151", marginTop: 4, fontWeight: 500 }}>
              Action: {item.action}
              {item.owner && <span style={{ color: "#6b7280" }}> · {item.owner}</span>}
            </div>
          )}
          {item.why_chosen && (
            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{item.why_chosen}</div>
          )}
        </div>
        {item.expected_impact && (
          <div style={{ fontSize: 11, fontWeight: 600, color: accent, flexShrink: 0 }}>
            {item.expected_impact}
          </div>
        )}
      </div>
    </div>
  );
}

function PredictionRow({ pred, onRecordOutcome }) {
  const [recording, setRecording] = useState(false);
  const [actVal, setActVal]       = useState("");
  const [outcome, setOutcome]     = useState("accurate");

  const record = async () => {
    setRecording(true);
    try {
      await fetch(`/api/retail-desk/predictions/${pred.id}/outcome`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: outcome, actual_value: actVal }),
      });
      onRecordOutcome?.();
    } finally { setRecording(false); }
  };

  const confColor = CONF_COLOR[pred.confidence] || "#9ca3af";
  const outColor  = OUTCOME_COLOR[pred.status]  || "#9ca3af";
  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
      padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{pred.metric_name}</div>
          <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#6b7280" }}>Current: {pred.current_value || "—"}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>
              Predicted: {pred.predicted_value || "—"}
            </span>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>{pred.time_horizon || "4 weeks"}</span>
          </div>
          {pred.rationale && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{pred.rationale}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <span style={{ fontSize: 10, color: confColor, fontWeight: 700, textTransform: "uppercase" }}>
            {pred.confidence}
          </span>
          <span style={{ fontSize: 11, color: outColor, fontWeight: 600 }}>
            {OUTCOME_LABEL[pred.status] || pred.status}
          </span>
        </div>
      </div>
      {pred.status === "pending" && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input value={actVal} onChange={e => setActVal(e.target.value)}
            placeholder="Actual value"
            style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 8px", fontSize: 11, width: 120 }} />
          <select value={outcome} onChange={e => setOutcome(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "3px 6px", fontSize: 11 }}>
            <option value="accurate">Accurate</option>
            <option value="inaccurate">Inaccurate</option>
            <option value="partial">Partial</option>
          </select>
          <button onClick={record} disabled={recording}
            style={{ background: "#1a5c38", color: "#fff", border: "none", borderRadius: 4,
              padding: "3px 10px", fontSize: 11, cursor: "pointer", opacity: recording ? 0.5 : 1 }}>
            Record
          </button>
        </div>
      )}
      {pred.status !== "pending" && pred.actual_value && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#6b7280" }}>
          Actual: {pred.actual_value} · Recorded {pred.recorded_date || ""}
        </div>
      )}
    </div>
  );
}

// ── Store drawer ──────────────────────────────────────────────────────────────

function StoreDrawer({ store, onClose }) {
  const [activeTab, setActiveTab]     = useState("analysis");
  const [showCorrect, setShowCorrect] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);

  const { data, isLoading, error, refetch } = useApi(
    `/retail-desk/store/${encodeURIComponent(store)}`,
    {},
    { staleTime: 60_000 },
  );

  const closeIssue = useCallback(async (id) => {
    await fetch(`/api/retail-desk/issues/${id}/close`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify({}),
    });
    refetch();
  }, [refetch]);

  const updateIssueStatus = useCallback(async (id, newStatus) => {
    if (newStatus === "closed") return closeIssue(id);
    await fetch(`/api/retail-desk/issues/${id}/status`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify({ status: newStatus }),
    });
    refetch();
  }, [closeIssue, refetch]);

  const an = (() => {
    if (!data?.analysis) return null;
    if (typeof data.analysis === "string") {
      try { return JSON.parse(data.analysis); } catch { return null; }
    }
    return typeof data.analysis === "object" ? data.analysis : null;
  })();

  const tabs = [
    { id: "analysis",    label: "Analysis" },
    { id: "path",        label: "Growth Path" },
    { id: "trend",       label: "Trend" },
    { id: "issues",      label: `Issues (${data?.issues?.filter(i => i.status !== "closed").length || 0})` },
    { id: "predictions", label: `Predictions (${data?.predictions?.length || 0})` },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
    }}>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)" }} />
      {/* Panel */}
      <div style={{
        position: "relative", zIndex: 101,
        width: 520, maxWidth: "100vw", height: "100dvh",
        background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.1)",
        display: "flex", flexDirection: "column", overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 0", borderBottom: "1px solid #e5e7eb", paddingBottom: 16,
          position: "sticky", top: 0, background: "#fff", zIndex: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                {data?.country && <CountryDot country={data.country} />}
                <h2 style={{ fontSize: 18, fontWeight: 800, color: "#111827", margin: 0 }}>{store}</h2>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {data?.path?.status && <StatusBadge status={data.analysis?.composite_status || data.path?.status} />}
                {data?.t12m_net && (
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    T12M {KES(data.t12m_net)}
                  </span>
                )}
                {an?.verdict && (() => {
                  const vs = VERDICT_STYLE[an.verdict];
                  return vs ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: vs.color,
                      background: vs.bg, border: `1px solid ${vs.border}`, borderRadius: 4,
                      padding: "2px 8px" }}>
                      {vs.label}
                    </span>
                  ) : null;
                })()}
              </div>
            </div>
            <button onClick={onClose}
              style={{ background: "none", border: "none", fontSize: 20, color: "#6b7280",
                cursor: "pointer", padding: 4, lineHeight: 1 }}>
              ×
            </button>
          </div>
          {/* Top action from AI */}
          {an?.top_action && (
            <div style={{ marginTop: 10, padding: "8px 12px", background: "#fffbeb",
              border: "1px solid #fde68a", borderRadius: 6, fontSize: 12,
              color: "#92400e", fontWeight: 500 }}>
              {an.top_action}
            </div>
          )}
          {/* Tabs */}
          <div style={{ display: "flex", gap: 0, marginTop: 14, borderBottom: "none" }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                style={{
                  fontSize: 12, fontWeight: activeTab === t.id ? 700 : 400,
                  color: activeTab === t.id ? "#1a5c38" : "#6b7280",
                  background: "none", border: "none",
                  borderBottom: activeTab === t.id ? "2px solid #1a5c38" : "2px solid transparent",
                  padding: "6px 12px 8px", cursor: "pointer",
                }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
          {isLoading && <div style={{ fontSize: 13, color: "#9ca3af" }}>Loading…</div>}
          {error && <div style={{ fontSize: 12, color: "#dc2626" }}>Failed to load store data.</div>}

          {/* ══ ANALYSIS TAB ══ */}
          {activeTab === "analysis" && !isLoading && (
            <>
              {an ? (
                <>
                  {/* What's working */}
                  {an.what_working?.length > 0 && (
                    <div>
                      <SectionLabel>What is Working</SectionLabel>
                      {an.what_working.map((item, i) => (
                        <MetricRow key={i} item={item} variant="working" />
                      ))}
                    </div>
                  )}

                  {/* What's misbehaving */}
                  {an.what_misbehaving?.length > 0 && (
                    <div>
                      <SectionLabel>What Needs Attention</SectionLabel>
                      {an.what_misbehaving.map((item, i) => (
                        <MetricRow key={i} item={item} variant="misbehaving" />
                      ))}
                    </div>
                  )}

                  {/* Signal vs noise */}
                  {an.signal_vs_noise?.length > 0 && (
                    <div>
                      <SectionLabel>Signal vs Noise</SectionLabel>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {an.signal_vs_noise.map((s, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                            <span style={{
                              flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 6px",
                              borderRadius: 4, color: "#fff",
                              background: s.type === "signal" ? "#1a5c38" : "#9ca3af",
                            }}>
                              {(s.type || "").toUpperCase()}
                            </span>
                            <span style={{ color: "#374151" }}>
                              <span style={{ fontWeight: 600 }}>{s.item}</span>
                              {s.reason && <span style={{ color: "#6b7280" }}> — {s.reason}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Opportunity */}
                  {an.opportunity?.description && (
                    <div>
                      <SectionLabel>Opportunity</SectionLabel>
                      <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8,
                        padding: "14px 16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between",
                          alignItems: "flex-start", gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#166534" }}>
                              {an.opportunity.lever}
                            </div>
                            <div style={{ fontSize: 12, color: "#166534", marginTop: 4 }}>
                              {an.opportunity.description}
                            </div>
                            {an.opportunity.how && (
                              <div style={{ fontSize: 12, color: "#166534", marginTop: 6,
                                borderTop: "1px solid #bbf7d0", paddingTop: 6 }}>
                                {an.opportunity.how}
                              </div>
                            )}
                          </div>
                          {(an.opportunity.kes_upside > 0) && (
                            <div style={{ textAlign: "right", flexShrink: 0 }}>
                              <div style={{ fontSize: 10, color: "#166534", fontWeight: 600 }}>
                                Potential upside
                              </div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: "#166534" }}>
                                {KES(an.opportunity.kes_upside)}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Actions — with save-to-queue button */}
                  {an.actions?.length > 0 && (
                    <div>
                      <SectionLabel>Recommended Actions</SectionLabel>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {an.actions.map((act, i) => (
                          <ActionCard key={i} act={act} store={store} index={i} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Data availability */}
                  {an.metric_map && (
                    <div>
                      <SectionLabel>Data Availability</SectionLabel>
                      {an.metric_map.available?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                          {an.metric_map.available.map((m, i) => (
                            <span key={i} style={{ fontSize: 10, background: "#f0fdf4", color: "#166534",
                              border: "1px solid #bbf7d0", borderRadius: 4, padding: "2px 7px" }}>
                              {m}
                            </span>
                          ))}
                        </div>
                      )}
                      {an.metric_map.absent?.length > 0 && (
                        <div style={{ fontSize: 11, color: "#9ca3af" }}>
                          <span style={{ fontWeight: 600 }}>Not available: </span>
                          {an.metric_map.absent.map((a, i) => (
                            <span key={i} title={a.would_have_told_you}>
                              {a.metric}{i < an.metric_map.absent.length - 1 ? ", " : ""}
                            </span>
                          ))}
                        </div>
                      )}
                      {an.data_gaps && (
                        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{an.data_gaps}</div>
                      )}
                    </div>
                  )}

                  {/* Correction channel */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between",
                      alignItems: "center", marginBottom: 8 }}>
                      <SectionLabel>Correct this analysis</SectionLabel>
                      <button onClick={() => setShowCorrect(v => !v)}
                        style={{ fontSize: 11, color: "#6b7280", background: "none",
                          border: "1px solid #e5e7eb", borderRadius: 4, padding: "2px 10px",
                          cursor: "pointer" }}>
                        {showCorrect ? "Cancel" : "Flag correction"}
                      </button>
                    </div>
                    {showCorrect && (
                      <CorrectionForm store={store} onSaved={() => { setShowCorrect(false); refetch(); }} />
                    )}
                    {data?.corrections?.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6, fontWeight: 600 }}>
                          PRIOR CORRECTIONS ({data.corrections.filter(c => c.applied).length} applied)
                        </div>
                        {data.corrections.map((c, i) => (
                          <div key={i} style={{ fontSize: 11, color: "#6b7280", padding: "4px 0",
                            borderBottom: "1px solid #f3f4f6", display: "flex", gap: 8 }}>
                            <span style={{ flexShrink: 0, fontWeight: 600,
                              color: c.applied ? "#1a5c38" : "#d97706" }}>
                              {c.applied ? "Applied" : "Pending"}
                            </span>
                            <span style={{ flex: 1 }}>{c.correction_text}</span>
                            <span style={{ flexShrink: 0, color: "#9ca3af" }}>{String(c.corr_date)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Fallback: no structured analysis */}
                  <div>
                    <SectionLabel>Recent Trend</SectionLabel>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      {[
                        ["L28D Net",      KES(data?.trend?.l28d_net)],
                        ["Prior 28D",     KES(data?.trend?.prev28d_net)],
                        ["MoM",           data?.trend?.mom_pct != null ? PCT(data.trend.mom_pct) : "—"],
                        ["Transactions",  (data?.mtd?.transactions || 0).toLocaleString()],
                        ["Avg Basket",    KES(data?.mtd?.avg_basket)],
                      ].map(([label, val]) => (
                        <div key={label} style={{ background: "#f9fafb", border: "1px solid #e5e7eb",
                          borderRadius: 6, padding: "8px 10px" }}>
                          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {data?.coaching && (
                    <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8,
                      padding: "12px 14px", fontSize: 13, color: "#166534",
                      lineHeight: 1.6, whiteSpace: "pre-line" }}>
                      {data.coaching}
                    </div>
                  )}
                  {!data?.coaching_ai && (
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>
                      AI analyst not configured — set ANTHROPIC_API_KEY to enable.
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ══ GROWTH PATH TAB ══ */}
          {activeTab === "path" && !isLoading && (
            <>
              <div>
                <SectionLabel>Growth Path — current month</SectionLabel>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    ["MTD Actual",     KES(data?.mtd?.actual)],
                    ["MTD Required",   KES(data?.path?.mtd_req)],
                    ["Gap vs Path",    KES(data?.path?.gap_kes)],
                    ["Monthly Target", KES(data?.path?.monthly_req)],
                  ].map(([label, val]) => (
                    <div key={label} style={{ background: "#f9fafb", border: "1px solid #e5e7eb",
                      borderRadius: 6, padding: "10px 12px" }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 15, fontWeight: 700,
                        color: label.includes("Gap") && (data?.path?.gap_kes || 0) < 0 ? "#dc2626" : "#111827" }}>
                        {val}
                      </div>
                    </div>
                  ))}
                </div>
                {data?.path?.gap_pct != null && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
                    {PCT(data.path.gap_pct)} vs prorated path · Store share {data.path.share_pct}% of fleet
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══ TREND TAB ══ */}
          {activeTab === "trend" && !isLoading && (
            <>
              <div>
                <SectionLabel>Recent Trend</SectionLabel>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                  {[
                    ["L28D Net",     KES(data?.trend?.l28d_net)],
                    ["Prior 28D",    KES(data?.trend?.prev28d_net)],
                    ["MoM",          data?.trend?.mom_pct != null ? PCT(data.trend.mom_pct) : "—"],
                    ["Transactions", (data?.mtd?.transactions || 0).toLocaleString()],
                    ["Avg Basket",   KES(data?.mtd?.avg_basket)],
                  ].map(([label, val]) => (
                    <div key={label} style={{ background: "#f9fafb", border: "1px solid #e5e7eb",
                      borderRadius: 6, padding: "8px 10px" }}>
                      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{val}</div>
                    </div>
                  ))}
                </div>
                {data?.trend?.weekly?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>8-week weekly net sales</div>
                    <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 44 }}>
                      {(() => {
                        const weeks  = data.trend.weekly;
                        const maxVal = Math.max(...weeks.map(w => w.net_sales), 1);
                        return weeks.map((w, i) => (
                          <div key={i} title={`${w.week_start}: ${KES(w.net_sales)}`}
                            style={{ flex: 1, background: "#1a5c38",
                              opacity: 0.2 + 0.8 * (w.net_sales / maxVal),
                              borderRadius: "2px 2px 0 0",
                              height: `${Math.max(4, (w.net_sales / maxVal) * 100)}%` }} />
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>
              {data?.categories?.length > 0 && (
                <div>
                  <SectionLabel>Top Categories (L28D)</SectionLabel>
                  {data.categories.map((c, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between",
                      padding: "5px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ fontSize: 12, color: "#374151" }}>{c.category}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>
                        {KES(c.net_sales)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ══ ISSUES TAB ══ */}
          {activeTab === "issues" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: 12 }}>
                <SectionLabel>
                  Issues ({data?.issues?.filter(i => i.status !== "closed").length || 0} open)
                </SectionLabel>
                <button onClick={() => setShowNewIssue(v => !v)}
                  style={{ fontSize: 11, color: "#1a5c38", background: "none",
                    border: "1px solid #1a5c38", borderRadius: 4, padding: "2px 10px",
                    cursor: "pointer" }}>
                  {showNewIssue ? "Cancel" : "+ Add"}
                </button>
              </div>
              {showNewIssue && (
                <NewIssueForm store={store} onSaved={() => { setShowNewIssue(false); refetch(); }} />
              )}
              {(data?.issues || []).filter(i => i.status !== "closed").length === 0 && !showNewIssue && (
                <div style={{ fontSize: 12, color: "#9ca3af" }}>No open issues.</div>
              )}
              {(data?.issues || []).map(issue => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  onStatusChange={refetch}
                  onClose={closeIssue}
                />
              ))}
            </div>
          )}

          {/* ══ PREDICTIONS TAB ══ */}
          {activeTab === "predictions" && (
            <div>
              <SectionLabel>Predictions ({data?.predictions?.length || 0})</SectionLabel>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
                AI-generated predictions. Record actual outcomes to close the learning loop.
              </div>
              {(data?.predictions || []).length === 0 && (
                <div style={{ fontSize: 12, color: "#9ca3af" }}>
                  No predictions yet — they appear after the first AI analysis.
                </div>
              )}
              {(data?.predictions || []).map(p => (
                <PredictionRow key={p.id} pred={p} onRecordOutcome={refetch} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Action card with save-to-queue ────────────────────────────────────────────

function ActionCard({ act, store, index }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const saveToQueue = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/retail-desk/actions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          store,
          action_text: act.action,
          owner: act.owner,
          expected_kes: act.kes_impact || null,
          source: "ai",
        }),
      });
      if (r.ok) setSaved(true);
    } finally { setSaving(false); }
  };

  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
      padding: "10px 12px" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: "#1a5c38",
          borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0 }}>
          {index + 1}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{act.action}</div>
          <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            {act.owner && <span style={{ fontSize: 11, color: "#6b7280" }}>Owner: {act.owner}</span>}
            {act.deadline && <span style={{ fontSize: 11, color: "#6b7280" }}>By: {act.deadline}</span>}
            {act.expected_impact && (
              <span style={{ fontSize: 11, fontWeight: 600, color: "#1a5c38" }}>{act.expected_impact}</span>
            )}
          </div>
        </div>
        <button onClick={saveToQueue} disabled={saving || saved}
          style={{ fontSize: 10, color: saved ? "#1a5c38" : "#6b7280",
            background: saved ? "#f0fdf4" : "none",
            border: `1px solid ${saved ? "#bbf7d0" : "#e5e7eb"}`,
            borderRadius: 4, padding: "2px 8px", cursor: saved ? "default" : "pointer",
            flexShrink: 0, fontWeight: 600, opacity: saving ? 0.5 : 1 }}>
          {saved ? "Saved" : saving ? "…" : "Add to queue"}
        </button>
      </div>
    </div>
  );
}

// ── Store card ────────────────────────────────────────────────────────────────

function StoreCard({ card, onClick }) {
  const gapColor = STATUS_COLOR[card.status] || "#6b7280";
  const hasIssues = card.open_issues > 0;
  return (
    <div
      onClick={onClick}
      style={{
        background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
        padding: "14px 16px", cursor: "pointer", transition: "box-shadow 0.15s",
        borderLeft: `3px solid ${STATUS_COLOR[card.status] || "#e5e7eb"}`,
      }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 2px 12px rgba(0,0,0,0.08)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      {/* Store name + status */}
      <div style={{ display: "flex", justifyContent: "space-between",
        alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <CountryDot country={card.country} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{card.store}</span>
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>
            {card.share_pct?.toFixed(1)}% of fleet
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <StatusBadge status={card.status} />
          {hasIssues && (
            <span style={{ fontSize: 10, color: "#d97706", fontWeight: 600 }}>
              {card.open_issues} issue{card.open_issues > 1 ? "s" : ""}
              {card.open_issues_kes > 0 ? ` · ${KES(card.open_issues_kes)}` : ""}
            </span>
          )}
        </div>
      </div>

      {/* MTD metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        {[
          ["MTD",     KES(card.mtd_net)],
          ["Required",KES(card.mtd_req)],
          ["Gap",     KES(card.gap_kes)],
        ].map(([label, val]) => (
          <div key={label}>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 600,
              color: label === "Gap" ? gapColor : "#111827" }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <MiniBar
        value={card.mtd_net}
        max={Math.max(card.mtd_req, card.mtd_net, 1)}
        color={STATUS_COLOR[card.status]}
      />

      {/* Bottom row: path gap + MoM + run-rate */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10,
        color: "#9ca3af", marginTop: 4, flexWrap: "wrap", gap: 4 }}>
        <span>{PCT(card.gap_pct)} vs path</span>
        <div style={{ display: "flex", gap: 8 }}>
          {card.mom_pct != null && (
            <span>MoM <TrendArrow pct={card.mom_pct} size={10} /></span>
          )}
          {card.run_rate_gap_pct != null && (
            <span style={{ color: card.run_rate_gap_pct < -10 ? "#dc2626" : "#9ca3af" }}>
              T3M <TrendArrow pct={card.run_rate_gap_pct} size={10} />
            </span>
          )}
        </div>
      </div>

      {/* Top issue digest */}
      {card.top_issue && (
        <div style={{ marginTop: 8, padding: "6px 8px", background: "#fffbeb",
          border: "1px solid #fde68a", borderRadius: 4, fontSize: 11, color: "#92400e",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {card.top_issue.title}
        </div>
      )}
    </div>
  );
}

// ── Actions queue strip ───────────────────────────────────────────────────────

function ActionsStrip() {
  const { data } = useApi("/retail-desk/actions", { scope: "active" }, { staleTime: 120_000 });
  const actions = data?.actions || [];
  const overdue = actions.filter(a => a.overdue);
  if (actions.length === 0) return null;

  const updateAction = async (id, status) => {
    await fetch(`/api/retail-desk/actions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify({ status }),
    });
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
      padding: "16px 20px", marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#111827" }}>
          Actions Queue
          {overdue.length > 0 && (
            <span style={{ marginLeft: 8, fontSize: 11, color: "#dc2626",
              background: "#fef2f2", border: "1px solid #fecaca",
              borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
              {overdue.length} overdue
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>{actions.length} active</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {actions.slice(0, 8).map(a => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10,
            padding: "7px 10px", background: a.overdue ? "#fef2f2" : "#f9fafb",
            border: `1px solid ${a.overdue ? "#fecaca" : "#e5e7eb"}`, borderRadius: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#111827",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.action_text}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 11, color: "#6b7280" }}>{a.store}</span>
                {a.owner && <span style={{ fontSize: 11, color: "#9ca3af" }}>· {a.owner}</span>}
                {a.due_date && (
                  <span style={{ fontSize: 11, color: a.overdue ? "#dc2626" : "#9ca3af", fontWeight: a.overdue ? 600 : 400 }}>
                    · Due {a.due_date}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => updateAction(a.id, "done")}
              style={{ fontSize: 10, color: "#1a5c38", background: "#f0fdf4",
                border: "1px solid #bbf7d0", borderRadius: 4, padding: "2px 8px",
                cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>
              Done
            </button>
          </div>
        ))}
        {actions.length > 8 && (
          <div style={{ fontSize: 11, color: "#9ca3af", paddingLeft: 10 }}>
            +{actions.length - 8} more actions
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RetailDesk() {
  const [selectedStore, setSelectedStore] = useState(null);
  const [filterStatus, setFilterStatus]   = useState("all");
  const [filterCountry, setFilterCountry] = useState("all");
  const [search, setSearch]               = useState("");

  const { data, isLoading, error, refetch } = useApi(
    "/retail-desk/overview", {}, { staleTime: 120_000, refetchInterval: 180_000 }
  );

  const fleet = data?.fleet_summary;
  const queues = data?.exception_queues;

  const stores = useMemo(() => {
    let list = data?.stores || [];
    if (filterStatus  !== "all") list = list.filter(c => c.status === filterStatus);
    if (filterCountry !== "all") list = list.filter(c => c.country === filterCountry);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c => c.store.toLowerCase().includes(q));
    }
    return list;
  }, [data, filterStatus, filterCountry, search]);

  const countries = useMemo(() => (
    [...new Set((data?.stores || []).map(c => c.country))].sort()
  ), [data]);

  if (isLoading) return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, color: "#9ca3af" }}>Loading Retail Desk…</div>
      {[1,2,3].map(i => (
        <div key={i} style={{ height: 80, width: "100%", maxWidth: 700,
          background: "#f3f4f6", borderRadius: 8 }} />
      ))}
    </div>
  );

  if (error) return (
    <div style={{ padding: 32, color: "#dc2626", fontSize: 13 }}>
      Failed to load Retail Desk. {String(error)}
    </div>
  );

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111827", margin: 0 }}>
          Retail Desk
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Per-store growth path tracking, issue register and coaching ·{" "}
          {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      {/* Fleet KPIs */}
      {fleet && (
        <div style={{ display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
          <FleetKPI label="Fleet MTD" value={KES(fleet.total_mtd)}
            sub={`Required ${KES(fleet.total_mtd_req)}`}
            color={fleet.total_gap_pct >= 0 ? "#1a5c38" : "#dc2626"} />
          <FleetKPI label="Fleet Gap"
            value={`${fleet.total_gap_pct >= 0 ? "+" : ""}${fleet.total_gap_pct?.toFixed(1)}%`}
            sub={KES(fleet.total_gap_kes)}
            color={fleet.total_gap_pct >= 0 ? "#1a5c38" : "#dc2626"} />
          <FleetKPI label="Act Now" value={fleet.act_now}
            sub="stores need intervention"
            color={fleet.act_now > 0 ? "#dc2626" : "#6b7280"} />
          <FleetKPI label="Watch" value={fleet.watch}
            sub="stores to monitor"
            color={fleet.watch > 0 ? "#d97706" : "#6b7280"} />
          <FleetKPI label="On Track" value={fleet.on_track}
            sub={`+ ${fleet.outperforming || 0} outperforming`}
            color="#1a5c38" />
          <FleetKPI label="Open Issues" value={fleet.open_issues}
            sub={fleet.open_issues_kes > 0 ? `${KES(fleet.open_issues_kes)} at stake` : "across fleet"}
            color={fleet.open_issues > 0 ? "#d97706" : "#6b7280"} />
        </div>
      )}

      {/* Fleet AI Intelligence */}
      {data?.fleet_coaching && (
        <DeskCoachingPanel coaching={data.fleet_coaching} desk="Retail Fleet" />
      )}

      {/* Exception queues */}
      {queues && (
        <ExceptionQueues queues={queues} onSelectStore={setSelectedStore} />
      )}

      {/* Actions queue */}
      <ActionsStrip />

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center",
        marginBottom: 16, flexWrap: "wrap" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Filter stores…"
          style={{ border: "1px solid #d1d5db", borderRadius: 6,
            padding: "6px 10px", fontSize: 13, width: 180 }}
        />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 6,
            padding: "6px 10px", fontSize: 13 }}>
          <option value="all">All statuses</option>
          <option value="act_now">Act Now</option>
          <option value="watch">Watch</option>
          <option value="on_track">On Track</option>
          <option value="outperforming">Outperforming</option>
        </select>
        <select value={filterCountry} onChange={e => setFilterCountry(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 6,
            padding: "6px 10px", fontSize: 13 }}>
          <option value="all">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={refetch}
          style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280", background: "none",
            border: "1px solid #e5e7eb", borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}>
          Refresh
        </button>
      </div>

      {/* Store count */}
      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>
        {stores.length} store{stores.length !== 1 ? "s" : ""}
        {filterStatus !== "all" || filterCountry !== "all" || search ? " (filtered)" : ""}
      </div>

      {/* Store grid */}
      <div style={{ display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
        {stores.map(card => (
          <StoreCard key={card.store} card={card} onClick={() => setSelectedStore(card.store)} />
        ))}
        {stores.length === 0 && (
          <div style={{ gridColumn: "1 / -1", padding: 32, textAlign: "center",
            color: "#9ca3af", fontSize: 13 }}>
            No stores match the current filters.
          </div>
        )}
      </div>

      {/* Methodology note */}
      <div style={{ marginTop: 24, padding: "12px 16px", background: "#f9fafb",
        border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, color: "#6b7280" }}>
        Status model: composite of path gap, MoM trend, T3M run-rate, and consecutive weeks behind.
        Act Now = structural underperformance requiring manager intervention.
        Watch = slipping or mixed signals. On Track = meeting path with stable trend.
        Outperforming = materially ahead and accelerating. Issues auto-flagged by 9 deterministic rules.
      </div>

      {/* Store drawer */}
      {selectedStore && (
        <StoreDrawer store={selectedStore} onClose={() => setSelectedStore(null)} />
      )}
    </div>
  );
}
