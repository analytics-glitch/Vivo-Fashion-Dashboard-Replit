import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/useApi";
import { KpiCard, DeskCoachingPanel, DeskIssuePanel, DeskGapPanel } from "@/components/bi/DeskShared";

const API = "/api/workforce-desk";

const pct = v => v == null ? "—" : v + "%";
const fmtKES = n => n == null ? "—" : "KES " + Number(n).toLocaleString();
const fmtN = n => n == null ? "—" : Number(n).toLocaleString();

const COUNTRY_COLOR = { Kenya: "#1a5c38", Uganda: "#d97706", Rwanda: "#00c853" };

function AttBadge({ rate }) {
  const color = (rate || 0) >= 90 ? "#1a5c38" : (rate || 0) >= 75 ? "#d97706" : "#dc2626";
  return <span style={{ fontWeight: 700, color }}>{pct(rate)}</span>;
}

export default function WorkforceDesk() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load Workforce Desk.</div>;

  const kpi = data?.kpis || {};
  const branches = data?.branches || [];
  const gaps = data?.gaps || [];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>Workforce Desk</h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
          Branch attendance · Sales per labour hour (approximate) — as of {data?.as_of}
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <KpiCard label="Branches Tracked" value={fmtN(kpi.branches_tracked)} color="#1a5c38" />
        <KpiCard label="Fleet Attendance" value={pct(kpi.fleet_attendance_rate)} sub="last 28 days" color="#d97706" />
        <KpiCard label="Avg Hours / Staff / Day" value={kpi.avg_hours_per_day ? kpi.avg_hours_per_day + "h" : "—"} color="#4b7bec" />
        <KpiCard label="Total Staff Tracked" value={fmtN(kpi.total_staff_tracked)} sub="unique employees L28D" color="#6b7280" />
      </div>

      {/* AI Coaching */}
      <DeskCoachingPanel coaching={data?.coaching} desk="Workforce" />

      {/* Data Gaps */}
      <DeskGapPanel gaps={gaps} />

      {/* Branch Table */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px", marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 14 }}>
          Branch Performance — Last 28 Days
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                {["Branch","Country","Headcount","Avg Hours","Attendance","Revenue L28D","Rev/Staff-Hr"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {branches.map((b, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "7px 8px", fontWeight: 500, color: "#1c1917" }}>{b.branch_name}</td>
                  <td style={{ padding: "7px 8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: COUNTRY_COLOR[b.branch_country] || "#9ca3af", flexShrink: 0 }} />
                      {b.branch_country || "—"}
                    </span>
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}>{fmtN(b.headcount)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#6b7280" }}>{b.avg_hours ? b.avg_hours + "h" : "—"}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}><AttBadge rate={b.attendance_rate} /></td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#6b7280" }}>
                    {b.net_sales_l28d ? fmtKES(Math.round(b.net_sales_l28d)) : <span style={{ color: "#d1d5db" }}>—</span>}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#9ca3af", fontStyle: "italic" }}>
                    {b.rev_per_staff_hr ? fmtKES(b.rev_per_staff_hr) : <span style={{ fontSize: 11 }}>approx.</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {branches.length === 0 && (
            <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 13 }}>No attendance data available.</div>
          )}
        </div>
        <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 12, marginBottom: 0 }}>
          Rev/Staff-Hr is approximate — branch name matching between attendance and sales data is fuzzy.
          Sales columns blank where branch name could not be matched.
        </p>
      </div>

      {/* Issues */}
      <DeskIssuePanel issues={data?.issues || []} desk="workforce" apiBase={API}
        onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
    </div>
  );
}
