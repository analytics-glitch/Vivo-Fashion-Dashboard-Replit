import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/useApi";
import { KpiCard, DeskCoachingPanel, DeskIssuePanel, DeskGapPanel } from "@/components/bi/DeskShared";

const API = "/production-desk";
const fmtN = n => n == null ? "—" : Number(n).toLocaleString();

const STATE_COLOR = {
  fully_planned: "#1a5c38", partially_planned: "#d97706",
  draft: "#9ca3af", bom_pending: "#4b7bec", unknown: "#e5e7eb",
};

export default function ProductionDesk() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load Production Desk.</div>;

  const kpi = data?.kpis || {};
  const byBuyer = data?.by_buyer || [];
  const byState = data?.by_state || [];
  const overdue = data?.overdue || [];
  const upcoming = data?.upcoming || [];
  const gaps = data?.gaps || [];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>Production Desk</h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
          Buying order pipeline · Overdue orders · By-buyer breakdown — as of {data?.as_of}
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <KpiCard label="Total Orders (18m)" value={fmtN(kpi.total_orders)} color="#1a5c38" />
        <KpiCard label="Active (future due)" value={fmtN(kpi.active_orders)} color="#4b7bec" />
        <KpiCard label="Overdue" value={fmtN(kpi.overdue_orders)}
          sub={`${fmtN(kpi.overdue_units)} units`}
          color={kpi.overdue_orders > 10 ? "#dc2626" : "#d97706"} />
        <KpiCard label="Due Next 30d" value={fmtN(kpi.due_next_30d)} color="#d97706" />
        <KpiCard label="Total Units" value={fmtN(kpi.total_units)} color="#1a5c38" />
        <KpiCard label="Buyers" value={fmtN(kpi.buyers)} color="#6b7280" />
      </div>

      {/* AI Coaching */}
      <DeskCoachingPanel coaching={data?.coaching} desk="Production" />

      {/* Data Gaps */}
      <DeskGapPanel gaps={gaps} />

      {/* State breakdown + By Buyer */}
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, marginBottom: 20 }}>
        {/* State donut-style list */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>By BO State</div>
          {byState.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: STATE_COLOR[s.state] || "#9ca3af", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "#374151", flex: 1, textTransform: "replace" }}>{s.state?.replace(/_/g," ")}</span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{fmtN(s.orders)}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{fmtN(s.units)}u</span>
            </div>
          ))}
        </div>

        {/* By Buyer */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>By Buyer</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                {["Buyer","Orders","Total Units","Overdue","Earliest Due"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "5px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byBuyer.map((b, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "7px 8px", fontWeight: 500 }}>{b.buyer}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#6b7280" }}>{fmtN(b.orders)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}>{fmtN(b.total_units)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: (b.overdue || 0) > 0 ? 700 : 400,
                    color: (b.overdue || 0) > 0 ? "#dc2626" : "#6b7280" }}>
                    {b.overdue || 0}
                  </td>
                  <td style={{ padding: "7px 8px", color: "#6b7280", fontSize: 12 }}>{b.earliest_due || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Overdue + Upcoming */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#dc2626", marginBottom: 12 }}>
            Overdue Orders {overdue.length > 0 && `(${overdue.length})`}
          </div>
          {overdue.length === 0 ? (
            <p style={{ fontSize: 13, color: "#1a5c38" }}>No overdue orders.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {overdue.slice(0, 12).map((o, i) => (
                <div key={i} style={{ padding: "8px 10px", borderRadius: 6, background: "#fef2f2", borderLeft: `3px solid ${(o.days_overdue || 0) > 30 ? "#dc2626" : "#d97706"}` }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1c1917" }}>
                    {o.style_name || o.product_name || o.order_ref}
                  </div>
                  <div style={{ display: "flex", gap: 10, fontSize: 11, marginTop: 3, color: "#6b7280" }}>
                    <span style={{ color: "#dc2626", fontWeight: 600 }}>{o.days_overdue}d overdue</span>
                    <span>{fmtN(o.order_qty)} units</span>
                    <span>Buyer: {o.buyer || "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>Due Next 30 Days</div>
          {upcoming.length === 0 ? (
            <p style={{ fontSize: 13, color: "#9ca3af" }}>No orders due in next 30 days.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {upcoming.map((u, i) => (
                <div key={i} style={{ padding: "7px 10px", borderRadius: 6, background: "#f0fdf4", borderLeft: "3px solid #1a5c38" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1c1917" }}>
                    {u.style_name || u.product_name || u.order_ref}
                  </div>
                  <div style={{ display: "flex", gap: 10, fontSize: 11, marginTop: 3, color: "#6b7280" }}>
                    <span style={{ color: "#1a5c38" }}>{u.expected_delivery_date}</span>
                    <span>{fmtN(u.order_qty)} units</span>
                    <span>Buyer: {u.buyer || "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Issues */}
      <DeskIssuePanel issues={data?.issues || []} desk="production" apiBase={"/api" + API}
        onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
    </div>
  );
}
