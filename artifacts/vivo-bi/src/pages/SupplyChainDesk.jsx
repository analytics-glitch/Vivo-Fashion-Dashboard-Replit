import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/useApi";
import { KpiCard, DeskCoachingPanel, DeskIssuePanel, DeskGapPanel } from "@/components/bi/DeskShared";

const API = "/api/supply-chain-desk";
const fmtKES = n => n == null ? "—" : "KES " + Number(n).toLocaleString();
const fmtN = n => n == null ? "—" : Number(n).toLocaleString();
const pct = v => v == null ? "—" : v + "%";

export default function SupplyChainDesk() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load Supply Chain Desk.</div>;

  const kpi = data?.kpis || {};
  const suppliers = data?.suppliers || [];
  const overdue = data?.overdue || [];
  const gaps = data?.gaps || [];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>Supply Chain Desk</h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
          Fabric PO performance · Supplier on-time · Overdue orders — as of {data?.as_of}
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <KpiCard label="Total Fabric POs" value={fmtN(kpi.total_pos)} color="#1a5c38" />
        <KpiCard label="Suppliers" value={fmtN(kpi.total_suppliers)} color="#4b7bec" />
        <KpiCard label="Receipt Fill Rate" value={pct(kpi.receipt_fill_rate)}
          sub="qty received / ordered" color={kpi.receipt_fill_rate >= 90 ? "#1a5c38" : "#d97706"} />
        <KpiCard label="Overdue POs" value={fmtN(kpi.overdue_pos)}
          sub="past planned date" color={kpi.overdue_pos > 5 ? "#dc2626" : "#d97706"} />
        <KpiCard label="Open PO Value" value={fmtKES(kpi.open_po_value)} color="#6b7280" />
        <KpiCard label="Total PO Value" value={fmtKES(kpi.total_value_kes)} color="#1a5c38" />
      </div>

      {/* AI Coaching */}
      <DeskCoachingPanel coaching={data?.coaching} desk="Supply Chain" />

      {/* Data Gaps */}
      <DeskGapPanel gaps={gaps} />

      {/* Two columns: supplier table + overdue list */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* Supplier Performance */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>Top Suppliers by Value</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                  {["Supplier","POs","Value","Fill Rate","Overdue"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "5px 6px", fontSize: 10, color: "#6b7280", fontWeight: 600, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {suppliers.slice(0, 15).map((s, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                    <td style={{ padding: "6px 6px", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.supplier}>{s.supplier}</td>
                    <td style={{ padding: "6px 6px", textAlign: "right", color: "#6b7280" }}>{fmtN(s.pos)}</td>
                    <td style={{ padding: "6px 6px", textAlign: "right" }}>{fmtKES(s.total_value)}</td>
                    <td style={{ padding: "6px 6px", textAlign: "right", fontWeight: 600,
                      color: (s.fill_rate || 0) >= 90 ? "#1a5c38" : "#d97706" }}>
                      {pct(s.fill_rate)}
                    </td>
                    <td style={{ padding: "6px 6px", textAlign: "right",
                      color: (s.overdue_lines || 0) > 0 ? "#dc2626" : "#6b7280", fontWeight: (s.overdue_lines || 0) > 0 ? 700 : 400 }}>
                      {s.overdue_lines || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Overdue POs */}
        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginBottom: 12 }}>
            Overdue PO Lines
            {overdue.length > 0 && <span style={{ marginLeft: 8, fontSize: 11, color: "#dc2626", fontWeight: 600 }}>{overdue.length} lines</span>}
          </div>
          {overdue.length === 0 ? (
            <p style={{ fontSize: 13, color: "#1a5c38" }}>No overdue POs.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {overdue.slice(0, 15).map((o, i) => (
                <div key={i} style={{
                  padding: "8px 10px", borderRadius: 6, background: "#fef2f2",
                  borderLeft: `3px solid ${(o.days_overdue || 0) > 30 ? "#dc2626" : "#d97706"}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1c1917" }}>{o.po_name} — {o.supplier}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{o.product_name}</div>
                  <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11 }}>
                    <span style={{ color: "#dc2626", fontWeight: 600 }}>{o.days_overdue}d overdue</span>
                    <span style={{ color: "#6b7280" }}>Planned: {o.date_planned}</span>
                    <span style={{ color: "#6b7280" }}>{fmtKES(o.total_value)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Issues */}
      <DeskIssuePanel issues={data?.issues || []} desk="supply_chain" apiBase={API}
        onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
    </div>
  );
}
