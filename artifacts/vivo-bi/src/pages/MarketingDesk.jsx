import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { KpiCard, DeskCoachingPanel, DeskIssuePanel, DeskGapPanel } from "@/components/bi/DeskShared";

const API = "/api/marketing-desk";
const fmtN = n => n == null ? "—" : Number(n).toLocaleString();

const PLATFORM_COLOR = { instagram: "#e1306c", facebook: "#1877f2", x: "#14171a", google: "#4285f4" };
const SENTIMENT_COLOR = { positive: "#1a5c38", neutral: "#6b7280", negative: "#dc2626" };

export default function MarketingDesk() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load Marketing Desk.</div>;

  const social = data?.social || [];
  const loyalty = data?.loyalty || {};
  const gaps = data?.gaps || [];

  const totalItems = social.reduce((s, r) => s + (r.total_items || 0), 0);
  const totalNeedsReply = social.reduce((s, r) => s + (r.needs_reply || 0), 0);
  const totalPositive = social.reduce((s, r) => s + (r.positive || 0), 0);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>Marketing Desk</h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
          Social inbox · Loyalty health · Data gaps — as of {data?.as_of}
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <KpiCard label="Social Items (all time)" value={fmtN(totalItems)} color="#e1306c" />
        <KpiCard label="Needs Reply" value={fmtN(totalNeedsReply)} sub="unanswered social items" color="#dc2626" />
        <KpiCard label="Positive Sentiment" value={totalItems ? Math.round(totalPositive / totalItems * 100) + "%" : "—"}
          sub="of all social items" color="#1a5c38" />
        <KpiCard label="Loyalty Members" value={fmtN(loyalty.total_members)}
          sub={`${loyalty.active_30d || 0} active last 30d`} color="#4b7bec" />
        <KpiCard label="Campaigns Tracked" value="0" sub="no data yet — see gaps" color="#6b7280" />
      </div>

      {/* AI Coaching */}
      <DeskCoachingPanel coaching={data?.coaching} desk="Marketing" />

      {/* Data Gaps — prominent since this desk is mostly gaps */}
      <DeskGapPanel gaps={gaps} />

      {/* Social Inbox Table */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px", marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 14 }}>Social Inbox — By Platform</div>
        {social.length === 0 ? (
          <p style={{ fontSize: 13, color: "#9ca3af" }}>No social feedback data.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                {["Platform","Total","Last 7d","Last 30d","Positive","Negative","Needs Reply","Replied"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {social.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "7px 8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: PLATFORM_COLOR[r.platform] || "#9ca3af" }} />
                      <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{r.platform}</span>
                    </span>
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 600 }}>{fmtN(r.total_items)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#6b7280" }}>{fmtN(r.items_7d)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#6b7280" }}>{fmtN(r.items_30d)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: SENTIMENT_COLOR.positive }}>{fmtN(r.positive)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: SENTIMENT_COLOR.negative }}>{fmtN(r.negative)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: (r.needs_reply || 0) > 0 ? 700 : 400, color: (r.needs_reply || 0) > 0 ? "#dc2626" : "#1c1917" }}>{fmtN(r.needs_reply)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#1a5c38" }}>{fmtN(r.replied)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 10, marginBottom: 0 }}>
          Full social inbox available in CRM · Inbox. Respond to items from there.
        </p>
      </div>

      {/* Issues */}
      <DeskIssuePanel issues={data?.issues || []} desk="marketing" apiBase={API}
        onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
    </div>
  );
}
