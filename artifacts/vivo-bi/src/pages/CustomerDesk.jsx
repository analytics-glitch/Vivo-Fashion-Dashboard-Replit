import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { KpiCard, DeskCoachingPanel, DeskIssuePanel, DeskGapPanel } from "@/components/bi/DeskShared";

const API = "/api/customer-desk";

const fmtKES = n => n == null ? "—" : "KES " + Number(n).toLocaleString();
const fmtN = n => n == null ? "—" : Number(n).toLocaleString();
const pct = v => v == null ? "—" : v + "%";

const COUNTRY_COLOR = { Kenya: "#1a5c38", Uganda: "#d97706", Rwanda: "#00c853", Online: "#4b7bec" };

export default function CustomerDesk() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load Customer Desk.</div>;

  const kpi = data?.kpis || {};
  const cohort = data?.cohort || [];
  const bands = data?.clv_bands || [];
  const byCountry = data?.by_country || [];
  const loyalty = data?.loyalty || {};

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>Customer Desk</h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
          Retention · CLV · Reactivation · Loyalty — as of {data?.as_of}
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <KpiCard label="Total Customers" value={fmtN(kpi.total_customers)} color="#1a5c38" />
        <KpiCard label="Repeat Rate" value={pct(kpi.repeat_rate)} sub="≥2 purchases" color="#4b7bec" />
        <KpiCard label="Avg CLV" value={fmtKES(kpi.avg_clv)} color="#1a5c38" />
        <KpiCard label="Churned (90d+)" value={fmtN(kpi.churned_90d)} sub="no purchase in 90 days" color="#dc2626" />
        <KpiCard label="Reactivated L30D" value={fmtN(kpi.reactivated_30d)} sub="returned after 90d+ gap" color="#d97706" />
        <KpiCard label="New Customers L30D" value={fmtN(kpi.new_30d)} color="#00c853" />
      </div>

      {/* AI Coaching */}
      <DeskCoachingPanel coaching={data?.coaching} desk="Customer" />

      {/* Data Gaps */}
      <DeskGapPanel gaps={data?.gaps || []} />

      {/* Two column: cohort + CLV bands */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* Cohort Retention */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>Monthly Cohort Retention</div>
          {cohort.length === 0 ? (
            <p style={{ fontSize: 13, color: "#9ca3af" }}>No cohort data.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                  {["Cohort","Size","Returned","Retention"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "5px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohort.map((c, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                    <td style={{ padding: "6px 8px" }}>{c.label}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmtN(c.cohort_size)}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmtN(c.returned_at_least_once)}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600,
                      color: (c.retention_pct || 0) >= 40 ? "#1a5c38" : (c.retention_pct || 0) >= 20 ? "#d97706" : "#dc2626" }}>
                      {pct(c.retention_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* CLV Bands */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>CLV Distribution</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                {["Band","Customers","Avg Spend","Total Spend"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "5px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 500 }}>{b.band}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmtN(b.customers)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#6b7280" }}>{fmtKES(b.avg_spend)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmtKES(b.total_spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Country + Loyalty */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>By Country</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                {["Country","Customers","Avg CLV","Total Spend"].map(h => (
                  <th key={h} style={{ padding: "5px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textAlign: "left", textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byCountry.map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: COUNTRY_COLOR[c.country] || "#9ca3af" }} />
                      {c.country}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmtN(c.customers)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#6b7280" }}>{fmtKES(c.avg_clv)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmtKES(c.total_spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>Loyalty Programme</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[["Total Members", fmtN(loyalty.total_members)],
              ["Active Last 30d", fmtN(loyalty.active_30d)],
              ["New Last 30d", fmtN(loyalty.new_30d)],
              ["Avg Member Spend", fmtKES(loyalty.avg_spend)],
              ["Vivo Members", fmtN(loyalty.vivo_members)],
              ["Shop Zetu Members", fmtN(loyalty.sz_members)],
            ].map(([label, value]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #f9fafb", paddingBottom: 6 }}>
                <span style={{ fontSize: 13, color: "#6b7280" }}>{label}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1c1917" }}>{value}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 10, marginBottom: 0 }}>
            Loyalty is a separate member programme at /loyalty — only 17 enrolled members currently.
          </p>
        </div>
      </div>

      {/* Issues */}
      <DeskIssuePanel issues={data?.issues || []} desk="customer" apiBase={API}
        onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
    </div>
  );
}
