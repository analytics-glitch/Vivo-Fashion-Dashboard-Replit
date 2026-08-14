/**
 * DeskShared.jsx — Shared UI components for all AI Desks (Phases 4-10).
 * Exports: DeskCoachingPanel, DeskIssuePanel, DeskGapPanel, KpiCard, SeverityBadge
 */
import { useState } from "react";
import { createPortal } from "react-dom";

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
const STATUS_COLOR = { critical: "#dc2626", high: "#d97706", normal: "#1a5c38", positive: "#0ea5e9" };

const DESK_SLUG = {
  "Retail":        "retail-desk",
  "Workforce":     "workforce-desk",
  "Customer":      "customer-desk",
  "Marketing":     "marketing-desk",
  "Supply Chain":  "supply-chain-desk",
  "Production":    "production-desk",
  "Product":       "product-desk",
};

function fmt(n) {
  if (n == null) return "—";
  return "KES " + Number(n).toLocaleString();
}

function printReport(report, desk) {
  const STATUS_LABEL = { critical: "CRITICAL", high: "HIGH RISK", normal: "NORMAL", positive: "POSITIVE" };
  const sColor = STATUS_COLOR[report.overall_status] || "#6b7280";
  const findings = (report.key_findings || []).map(f => `
    <div style="margin-bottom:18px;padding:14px 16px;border-left:4px solid ${SEV_COLOR[f.severity]||'#9ca3af'};background:#fafafa;border-radius:4px;">
      <div style="font-size:13px;font-weight:700;color:#111;margin-bottom:6px;">${f.heading||''}</div>
      <div style="font-size:12px;color:#374151;margin-bottom:4px;line-height:1.6;">${f.analysis||''}</div>
      <div style="font-size:11px;color:#6b7280;font-style:italic;margin-bottom:4px;">${f.evidence||''}</div>
      ${f.kes_impact != null ? `<div style="font-size:11px;font-weight:700;color:${SEV_COLOR[f.severity]||'#6b7280'}">KES impact: ${Number(f.kes_impact).toLocaleString()}</div>` : ''}
    </div>`).join('');
  const actions = (report.action_plan || []).map(a => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px 10px;font-size:11px;font-weight:700;color:${PRIO_COLOR[a.priority]||'#6b7280'};text-transform:uppercase;">${a.priority||''}</td>
      <td style="padding:8px 10px;font-size:12px;color:#111;">${a.action||''}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;">${a.owner||''}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;">${a.by_when||''}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;text-align:right;">${a.kes_impact != null ? 'KES '+Number(a.kes_impact).toLocaleString() : '—'}</td>
    </tr>`).join('');
  const risks = (report.risks_to_watch || []).map(r => `
    <div style="margin-bottom:10px;padding:10px 14px;background:#fffbeb;border-left:3px solid #d97706;border-radius:4px;">
      <div style="font-size:12px;font-weight:600;color:#111;margin-bottom:3px;">${r.risk||''}</div>
      <div style="font-size:11px;color:#6b7280;">Trigger: ${r.trigger||''}</div>
      <div style="font-size:11px;color:#1a5c38;">Mitigation: ${r.mitigation||''}</div>
    </div>`).join('');
  const html = `<!DOCTYPE html><html><head><title>${report.title||desk+' Report'}</title>
  <style>body{font-family:Georgia,serif;margin:40px;color:#111;max-width:900px;}
  h1{font-size:22px;font-weight:700;margin-bottom:4px;}
  h2{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#374151;margin:24px 0 10px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  thead{background:#f3f4f6;}th{padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;}
  @media print{body{margin:20px;}}
  </style></head><body>
  <h1>${report.title||desk+' Intelligence Report'}</h1>
  <div style="display:flex;gap:16px;align-items:center;margin-bottom:24px;flex-wrap:wrap;">
    <span style="padding:3px 12px;background:${sColor}22;color:${sColor};border-radius:4px;font-size:12px;font-weight:700;text-transform:uppercase;">${STATUS_LABEL[report.overall_status]||report.overall_status||''}</span>
    <span style="font-size:12px;color:#6b7280;">Generated ${report.generated_at||new Date().toISOString().slice(0,10)}</span>
  </div>
  <h2>Executive Summary</h2>
  <div style="font-size:14px;line-height:1.8;color:#1c1917;margin-bottom:16px;">${report.executive_summary||''}</div>
  <h2>Situation Assessment</h2>
  <div style="font-size:13px;line-height:1.7;color:#374151;margin-bottom:16px;">${report.situation_assessment||''}</div>
  <h2>Key Findings</h2>${findings}
  <h2>Action Plan</h2>
  <table><thead><tr><th>Priority</th><th>Action</th><th>Owner</th><th>By When</th><th style="text-align:right;">KES Impact</th></tr></thead>
  <tbody>${actions}</tbody></table>
  <h2>Trend Assessment</h2>
  <div style="font-size:13px;line-height:1.7;color:#374151;font-style:italic;margin-bottom:16px;">${report.trend_assessment||''}</div>
  <h2>Risks to Watch</h2>${risks}
  <div style="margin-top:24px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
    <div><h2 style="margin-top:0;">Data Limitations</h2><div style="font-size:12px;color:#6b7280;line-height:1.6;">${report.data_limitations||''}</div></div>
    <div><h2 style="margin-top:0;">Conclusion</h2><div style="font-size:14px;font-weight:600;color:#1c1917;line-height:1.7;">${report.conclusion||''}</div></div>
  </div>
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
    Vivo Fashion Group — Confidential Management Report · AI-generated analysis for human review
  </div>
  </body></html>`;
  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
}

function DeskReportViewer({ report, generatedAt, generatedBy, desk, onClose }) {
  const r = report;
  const sColor = STATUS_COLOR[r.overall_status] || "#6b7280";
  const STATUS_LABEL = { critical: "CRITICAL", high: "HIGH RISK", normal: "NORMAL", positive: "POSITIVE" };

  return createPortal(
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.55)", display: "flex",
        alignItems: "flex-start", justifyContent: "center",
        overflowY: "auto", padding: "32px 16px",
      }}
    >
      <div style={{
        background: "#fff", borderRadius: 12, width: "100%", maxWidth: 880,
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          background: "#1a5c38", padding: "20px 28px",
          display: "flex", alignItems: "flex-start", gap: 16,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#86efac", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>
              {desk} Desk — Intelligence Report
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", lineHeight: 1.3 }}>
              {r.title || `${desk} Intelligence Report`}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{
                padding: "2px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                background: sColor + "33", color: "#fff", border: `1px solid ${sColor}88`,
                textTransform: "uppercase",
              }}>
                {STATUS_LABEL[r.overall_status] || r.overall_status}
              </span>
              <span style={{ fontSize: 11, color: "#86efac" }}>
                Generated {generatedAt || r.generated_at}
                {generatedBy && generatedBy !== "system" ? ` · ${generatedBy}` : ""}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => printReport(r, desk)}
              style={{
                padding: "7px 16px", borderRadius: 6, border: "1px solid #86efac44",
                background: "rgba(255,255,255,0.12)", color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
              }}
            >
              Print / Export
            </button>
            <button
              onClick={onClose}
              style={{
                width: 32, height: 32, borderRadius: 6, border: "1px solid #86efac44",
                background: "rgba(255,255,255,0.12)", color: "#fff",
                cursor: "pointer", fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "24px 28px", overflowY: "auto", maxHeight: "80vh" }}>

          {/* Executive Summary */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
              Executive Summary
            </div>
            <div style={{
              fontSize: 14, lineHeight: 1.8, color: "#1c1917",
              background: "#f8faf8", borderLeft: "4px solid #1a5c38",
              borderRadius: "0 8px 8px 0", padding: "14px 18px",
            }}>
              {r.executive_summary}
            </div>
          </div>

          {/* Situation Assessment */}
          {r.situation_assessment && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                Situation Assessment
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.7, color: "#374151" }}>
                {r.situation_assessment}
              </div>
            </div>
          )}

          {/* Key Findings */}
          {(r.key_findings || []).length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Key Findings ({r.key_findings.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {r.key_findings.map((f, i) => (
                  <div key={i} style={{
                    background: SEV_BG[f.severity] || "#f9fafb",
                    border: `1px solid ${SEV_BORDER2[f.severity] || "#e5e7eb"}`,
                    borderLeft: `4px solid ${SEV_BORDER[f.severity] || "#9ca3af"}`,
                    borderRadius: 8, padding: "12px 16px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{
                        fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em",
                        color: SEV_BORDER[f.severity] || "#6b7280",
                      }}>{f.severity}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#111827", flex: 1 }}>{f.heading}</span>
                      {f.kes_impact != null && (
                        <span style={{
                          fontSize: 11, fontWeight: 700, color: SEV_BORDER[f.severity] || "#6b7280",
                          background: "#fff", borderRadius: 4, padding: "2px 8px",
                          border: `1px solid ${SEV_BORDER2[f.severity] || "#e5e7eb"}`,
                          whiteSpace: "nowrap",
                        }}>
                          KES {Number(f.kes_impact).toLocaleString()} impact
                        </span>
                      )}
                    </div>
                    {f.analysis && (
                      <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 4 }}>{f.analysis}</div>
                    )}
                    {f.evidence && (
                      <div style={{ fontSize: 11, color: "#6b7280", fontStyle: "italic" }}>{f.evidence}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Plan */}
          {(r.action_plan || []).length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Action Plan ({r.action_plan.length} actions)
              </div>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                      {["Priority", "Action", "Owner", "By When", "KES Impact"].map(h => (
                        <th key={h} style={{
                          padding: "8px 12px", textAlign: "left",
                          fontSize: 10, fontWeight: 700, color: "#6b7280",
                          textTransform: "uppercase", letterSpacing: "0.04em",
                          whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.action_plan.map((a, i) => (
                      <tr key={i} style={{ borderBottom: i < r.action_plan.length - 1 ? "1px solid #f3f4f6" : "none", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                        <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                          <span style={{
                            fontSize: 10, fontWeight: 800, textTransform: "uppercase",
                            color: PRIO_COLOR[a.priority] || "#6b7280",
                          }}>{a.priority}</span>
                        </td>
                        <td style={{ padding: "10px 12px" }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", marginBottom: 2 }}>{a.action}</div>
                          {a.rationale && <div style={{ fontSize: 11, color: "#6b7280" }}>{a.rationale}</div>}
                          {a.expected_impact && <div style={{ fontSize: 11, color: "#1a5c38", marginTop: 2 }}>{a.expected_impact}</div>}
                        </td>
                        <td style={{ padding: "10px 12px", fontSize: 12, color: "#374151", whiteSpace: "nowrap" }}>{a.owner}</td>
                        <td style={{ padding: "10px 12px", fontSize: 12, color: "#374151", whiteSpace: "nowrap" }}>{a.by_when}</td>
                        <td style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: a.kes_impact ? "#1a5c38" : "#9ca3af", whiteSpace: "nowrap", textAlign: "right" }}>
                          {a.kes_impact != null ? "KES " + Number(a.kes_impact).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Trend Assessment */}
          {r.trend_assessment && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                Trend Assessment
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.7, color: "#374151", fontStyle: "italic" }}>
                {r.trend_assessment}
              </div>
            </div>
          )}

          {/* Risks to Watch */}
          {(r.risks_to_watch || []).length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Risks to Watch
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {r.risks_to_watch.map((rw, i) => (
                  <div key={i} style={{
                    background: "#fffbeb", border: "1px solid #fde68a",
                    borderLeft: "3px solid #d97706", borderRadius: 6, padding: "10px 14px",
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e", marginBottom: 4 }}>{rw.risk}</div>
                    {rw.trigger && <div style={{ fontSize: 11, color: "#78350f", marginBottom: 2 }}>Trigger: {rw.trigger}</div>}
                    {rw.mitigation && <div style={{ fontSize: 11, color: "#1a5c38" }}>Mitigation: {rw.mitigation}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Data Limitations + Conclusion — 2 column */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 8 }}>
            {r.data_limitations && (
              <div style={{ background: "#f9fafb", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                  Data Limitations
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>{r.data_limitations}</div>
              </div>
            )}
            {r.conclusion && (
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "#1a5c38", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                  Conclusion
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1c1917", lineHeight: 1.6 }}>{r.conclusion}</div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: "#9ca3af", flex: 1 }}>
              Vivo Fashion Group · Confidential Management Report · AI-generated analysis for human review · claude-haiku-4-5
            </span>
            <button
              onClick={() => printReport(r, desk)}
              style={{
                padding: "7px 18px", borderRadius: 6, border: "1px solid #e5e7eb",
                background: "#1a5c38", color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}
            >
              Print / Export PDF
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function DeskCoachingPanel({ coaching, desk }) {
  const [expanded, setExpanded] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [reportError, setReportError] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);

  const structured = coaching?.structured;
  const risks = structured?.risks || [];
  const opportunities = structured?.opportunities || [];
  const proposals = structured?.proposals || [];
  const criticalRisks = risks.filter(r => r.severity === "critical");
  const highRisks = risks.filter(r => r.severity === "high");
  const hasStructured = risks.length > 0 || opportunities.length > 0 || proposals.length > 0;
  const isPlaceholder = !coaching?.note || coaching.note.includes("not configured") || coaching.note.includes("unavailable") ||
    /^\s*[{[]/.test(coaching.note);

  const slug = DESK_SLUG[desk] || (desk || "").toLowerCase().replace(/\s+/g, "-") + "-desk";
  const reportBase = `/api/${slug}`;

  async function generateReport() {
    setReportLoading(true);
    setReportError(null);
    try {
      const res = await fetch(reportBase + "/report", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setReportError(json.error || "Failed to generate report.");
      } else {
        setReportData(json);
        setReportOpen(true);
      }
    } catch (e) {
      setReportError("Network error — please try again.");
    }
    setReportLoading(false);
  }

  async function loadLatestReport() {
    try {
      const res = await fetch(reportBase + "/report/latest", {
      });
      const json = await res.json();
      if (json.report) { setReportData(json); setReportOpen(true); }
    } catch (e) { /* silent */ }
  }

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
          {/* Watchlist — the 2 things to check in the next 24-48h */}
          {structured?.watchlist?.length > 0 && (
            <div style={{
              background: "#f8fafc", border: "1px solid #e2e8f0",
              borderLeft: "3px solid #6366f1", borderRadius: 6,
              padding: "10px 14px", marginBottom: 12,
            }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>
                Watchlist — check within 24-48h
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {structured.watchlist.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#6366f1", minWidth: 14 }}>{i + 1}.</span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 12, color: "#1e293b" }}>{w.item}</span>
                      {w.check_by && (
                        <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: 8 }}>by {w.check_by}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
                          <span style={{
                            fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em",
                            color: SEV_BORDER[r.severity] || "#6b7280", flexShrink: 0,
                          }}>{r.severity}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#111827", flex: 1 }}>{r.title}</span>
                          {r.kes_at_risk != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: "#dc2626",
                              background: "#fef2f2", borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap",
                            }}>
                              KES {Number(r.kes_at_risk).toLocaleString()} at risk
                            </span>
                          )}
                        </div>
                        {r.evidence && (
                          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, lineHeight: 1.4 }}>{r.evidence}</div>
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                          {r.action && (
                            <div style={{ fontSize: 11, color: "#1a5c38", fontWeight: 500 }}>Action: {r.action}</div>
                          )}
                          {r.owner && (
                            <span style={{
                              fontSize: 10, color: "#6b7280", background: "#f3f4f6",
                              borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap",
                            }}>{r.owner}</span>
                          )}
                        </div>
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
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#111827", flex: 1 }}>{o.title}</span>
                          {o.kes_upside != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: "#1a5c38",
                              background: "#dcfce7", borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap",
                            }}>
                              +KES {Number(o.kes_upside).toLocaleString()} upside
                            </span>
                          )}
                        </div>
                        {o.evidence && (
                          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, lineHeight: 1.4 }}>{o.evidence}</div>
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                          {o.action && (
                            <div style={{ fontSize: 11, color: "#1a5c38", fontWeight: 500 }}>Action: {o.action}</div>
                          )}
                          {o.owner && (
                            <span style={{
                              fontSize: 10, color: "#6b7280", background: "#f3f4f6",
                              borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap",
                            }}>{o.owner}</span>
                          )}
                        </div>
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
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {proposals.map((p, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{
                      fontSize: 9, fontWeight: 800, textTransform: "uppercase", whiteSpace: "nowrap",
                      marginTop: 2, color: PRIO_COLOR[p.priority] || "#6b7280",
                      minWidth: 40,
                    }}>{p.priority}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "#111827", lineHeight: 1.4 }}>{p.text}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                        {p.timeframe && (
                          <span style={{ fontSize: 10, color: "#9ca3af" }}>{p.timeframe}</span>
                        )}
                        {p.owner && (
                          <span style={{
                            fontSize: 10, color: "#6b7280", background: "#f3f4f6",
                            borderRadius: 4, padding: "0px 5px",
                          }}>{p.owner}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary / plain note */}
          {coaching.note && !isPlaceholder && (
            <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6, fontStyle: "italic", marginTop: 4 }}>
              {coaching.note}
            </div>
          )}

          {/* Plain text fallback when no structured data */}
          {!hasStructured && coaching.note && !isPlaceholder && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "12px 14px" }}>
              <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.6 }}>{coaching.note}</p>
            </div>
          )}

          {/* Generate Full Report footer */}
          <div style={{
            marginTop: 12, paddingTop: 10, borderTop: "1px solid #f3f4f6",
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          }}>
            <button
              onClick={generateReport}
              disabled={reportLoading}
              style={{
                padding: "6px 16px", borderRadius: 6,
                background: reportLoading ? "#9ca3af" : "#1a5c38",
                color: "#fff", border: "none", cursor: reportLoading ? "not-allowed" : "pointer",
                fontSize: 12, fontWeight: 600,
              }}
            >
              {reportLoading ? "Generating report…" : "Generate Full Report"}
            </button>
            <button
              onClick={loadLatestReport}
              style={{
                padding: "6px 14px", borderRadius: 6,
                background: "none", color: "#6b7280",
                border: "1px solid #e5e7eb", cursor: "pointer",
                fontSize: 12,
              }}
            >
              View last report
            </button>
            {reportError && (
              <span style={{ fontSize: 11, color: "#dc2626" }}>{reportError}</span>
            )}
            <span style={{ fontSize: 10, color: "#d1d5db", marginLeft: "auto" }}>
              Report includes executive summary, action plan, and trend assessment
            </span>
          </div>
        </>
      )}

      {/* Report viewer modal (portal to body) */}
      {reportOpen && reportData?.report && (
        <DeskReportViewer
          report={reportData.report}
          generatedAt={reportData.generated_at}
          generatedBy={reportData.generated_by}
          desk={desk}
          onClose={() => setReportOpen(false)}
        />
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


  async function handleCreate() {
    if (!form.title.trim()) return;
    setLoading(true);
    try {
      await fetch(apiBase + "/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
