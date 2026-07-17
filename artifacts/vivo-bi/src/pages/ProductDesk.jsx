import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/useApi";
import { KpiCard, DeskCoachingPanel, DeskIssuePanel } from "@/components/bi/DeskShared";

const API = "/product-desk";

const fmtKES = n => n == null ? "—" : "KES " + Number(n).toLocaleString();
const fmtN = n => n == null ? "—" : Number(n).toLocaleString();

function RiskBadge({ score }) {
  const color = score >= 70 ? "#dc2626" : score >= 40 ? "#d97706" : "#1a5c38";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11,
      fontWeight: 700, background: color + "22", color,
    }}>
      {Math.round(score)}
    </span>
  );
}

export default function ProductDesk() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useApi(API + "/overview", {}, { staleTime: 300000 });
  const [search, setSearch] = useState("");
  const [minWoc, setMinWoc] = useState(0);

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  if (error) return <div style={{ padding: 40, color: "#dc2626" }}>Failed to load Product Desk.</div>;

  const kpi = data?.kpis || {};
  const board = (data?.risk_board || []).filter(r =>
    (!search || r.style_name?.toLowerCase().includes(search.toLowerCase()) ||
     r.product_type?.toLowerCase().includes(search.toLowerCase())) &&
    (r.woc || 0) >= minWoc
  );

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#1c1917", margin: 0 }}>Product Desk</h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>
          Markdown risk board · Range vitality · Newness — as of {data?.as_of}
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 22 }}>
        <KpiCard label="Styles with Stock" value={fmtN(kpi.styles_with_stock)} color="#1a5c38" />
        <KpiCard label="Zero Sales (28d)" value={fmtN(kpi.zero_sales_28d)}
          sub="styles with stock but no sales" color="#dc2626" />
        <KpiCard label="Avg Fleet WOC" value={kpi.avg_woc ? kpi.avg_woc + "w" : "—"}
          sub="weeks of cover (store SOH)" color="#d97706" />
        <KpiCard label="Newness" value={kpi.newness_pct ? kpi.newness_pct + "%" : "—"}
          sub="revenue from styles <12w old" color="#4b7bec" />
        <KpiCard label="Dead Stock Value" value={kpi.dead_stock_value ? fmtKES(kpi.dead_stock_value) : "—"}
          sub="zero sales 28d × price" color="#6b7280" />
      </div>

      {/* AI Coaching */}
      <DeskCoachingPanel coaching={data?.coaching} desk="Product" />

      {/* Risk Board */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", padding: "16px 20px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1c1917" }}>
            Markdown Risk Board
          </span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search style or type…"
            style={{ marginLeft: "auto", padding: "5px 10px", borderRadius: 5, border: "1px solid #d1d5db", fontSize: 13, width: 200 }} />
          <select value={minWoc} onChange={e => setMinWoc(+e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 5, border: "1px solid #d1d5db", fontSize: 13 }}>
            <option value={0}>All WOC</option>
            <option value={8}>WOC ≥ 8w</option>
            <option value={12}>WOC ≥ 12w</option>
            <option value={20}>WOC ≥ 20w</option>
          </select>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>{board.length} styles</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f3f4f6" }}>
                {["Style","Type","SOH","Units 4w","Vel 12w","WOC","Vel Decline","Stock Value","Risk"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.slice(0, 30).map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "7px 8px", fontWeight: 500, color: "#1c1917", maxWidth: 220 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.style_name}>
                      {r.style_name}
                    </div>
                  </td>
                  <td style={{ padding: "7px 8px", color: "#6b7280" }}>{r.product_type || "—"}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}>{fmtN(r.soh)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right" }}>{fmtN(r.units_4w)}</td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#9ca3af" }}>
                    {r.units_12w ? (r.units_12w / 12).toFixed(1) : "—"}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 600,
                    color: (r.woc || 0) >= 20 ? "#dc2626" : (r.woc || 0) >= 12 ? "#d97706" : "#1a5c38" }}>
                    {r.woc >= 999 ? "∞" : (r.woc || 0) + "w"}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right",
                    color: (r.vel_decline_pct || 0) > 50 ? "#dc2626" : (r.vel_decline_pct || 0) > 20 ? "#d97706" : "#1a5c38" }}>
                    {r.vel_decline_pct != null ? (r.vel_decline_pct > 0 ? "▼ " : "▲ ") + Math.abs(r.vel_decline_pct) + "%" : "—"}
                  </td>
                  <td style={{ padding: "7px 8px", textAlign: "right", color: "#6b7280" }}>{fmtKES(r.stock_value)}</td>
                  <td style={{ padding: "7px 8px" }}><RiskBadge score={r.risk_score || 0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {board.length === 0 && (
            <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 13 }}>No styles match filters.</div>
          )}
        </div>
      </div>

      {/* Issues */}
      <DeskIssuePanel issues={data?.issues || []} desk="product" apiBase={"/api" + API}
        onRefresh={() => qc.invalidateQueries([API + "/overview"])} />
    </div>
  );
}
