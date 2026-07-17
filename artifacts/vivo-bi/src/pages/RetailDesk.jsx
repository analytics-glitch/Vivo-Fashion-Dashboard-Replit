import React, { useState, useMemo } from "react";
import { useApi } from "@/lib/useApi";

// ── Helpers ───────────────────────────────────────────────────────────────────

const KES = (v) =>
  v == null ? "—" : `KES ${Math.abs(v) >= 1_000_000
    ? (v / 1_000_000).toFixed(1) + "M"
    : Math.abs(v) >= 1_000
    ? (v / 1_000).toFixed(0) + "k"
    : v.toFixed(0)}`;

const PCT = (v, always = false) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

const STATUS_LABEL  = { ahead: "Ahead", at_risk: "At Risk", behind: "Behind", unknown: "—" };
const STATUS_COLOR  = { ahead: "#1a5c38", at_risk: "#d97706", behind: "#dc2626", unknown: "#6b7280" };
const STATUS_BG     = { ahead: "#f0fdf4", at_risk: "#fffbeb", behind: "#fef2f2", unknown: "#f9fafb" };
const SEV_COLOR     = { high: "#dc2626", medium: "#d97706", low: "#6b7280" };
const COUNTRY_COLOR = { Kenya: "#1a5c38", Uganda: "#d97706", Rwanda: "#00c853" };

function StatusBadge({ status, size = "sm" }) {
  const color = STATUS_COLOR[status] || "#6b7280";
  const bg    = STATUS_BG[status]    || "#f9fafb";
  const pad   = size === "lg" ? "6px 14px" : "2px 8px";
  const fs    = size === "lg" ? 13 : 11;
  return (
    <span style={{
      background: bg, color, border: `1px solid ${color}`,
      borderRadius: 4, padding: pad, fontSize: fs, fontWeight: 600,
      letterSpacing: "0.02em", whiteSpace: "nowrap",
    }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function CountryDot({ country }) {
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: COUNTRY_COLOR[country] || "#94a3b8", marginRight: 5,
      flexShrink: 0,
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
      <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Issue panel ───────────────────────────────────────────────────────────────

function IssueRow({ issue, onClose }) {
  const opened = issue.opened_at ? issue.opened_at.slice(0, 10) : "?";
  const daysSince = issue.opened_at
    ? Math.floor((Date.now() - new Date(issue.opened_at).getTime()) / 86400000)
    : 0;
  const stale = daysSince > 7;
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0",
      borderBottom: "1px solid #f3f4f6",
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%", marginTop: 6, flexShrink: 0,
        background: SEV_COLOR[issue.severity] || "#6b7280",
      }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{issue.title}</div>
        {issue.body && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, whiteSpace: "pre-line" }}>{issue.body}</div>}
        <div style={{ fontSize: 11, color: stale ? "#d97706" : "#9ca3af", marginTop: 3 }}>
          {stale ? `Stale — ${daysSince}d open` : `Opened ${opened}`}
          {issue.source === "auto" && " · auto-flagged"}
          {issue.owner_email && ` · ${issue.owner_email}`}
        </div>
      </div>
      {issue.status === "open" && (
        <button
          onClick={() => onClose(issue.id)}
          style={{ fontSize: 11, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}
        >
          Close
        </button>
      )}
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ store, title, body, severity: sev, owner_email: owner }),
      });
      if (r.ok) {
        setTitle(""); setBody(""); setOwner("");
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 14, marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Add issue</div>
      <input
        value={title} onChange={e => setTitle(e.target.value)}
        placeholder="Issue title"
        style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 4, padding: "6px 8px", fontSize: 12, marginBottom: 6, boxSizing: "border-box" }}
      />
      <textarea
        value={body} onChange={e => setBody(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 4, padding: "6px 8px", fontSize: 12, marginBottom: 6, boxSizing: "border-box", resize: "vertical" }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={sev} onChange={e => setSev(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 8px", fontSize: 12 }}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <input value={owner} onChange={e => setOwner(e.target.value)}
          placeholder="Owner email (optional)"
          style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 8px", fontSize: 12 }} />
        <button onClick={save} disabled={saving || !title.trim()}
          style={{ background: "#1a5c38", color: "#fff", border: "none", borderRadius: 4, padding: "5px 14px", fontSize: 12, cursor: "pointer", opacity: (saving || !title.trim()) ? 0.5 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Store deep-dive drawer ────────────────────────────────────────────────────

function StoreDrawer({ store, onClose }) {
  const enc  = encodeURIComponent(store);
  const { data, isLoading, error, refetch } = useApi(`/retail-desk/store/${enc}`, {}, { staleTime: 120_000 });
  const [showNewIssue, setShowNewIssue] = useState(false);

  const closeIssue = async (id) => {
    await fetch(`/api/retail-desk/issues/${id}/close`, { method: "POST", credentials: "include" });
    refetch();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 50, display: "flex",
    }}>
      <div onClick={onClose} style={{ flex: 1, background: "rgba(0,0,0,0.18)" }} />
      <div style={{
        width: 520, background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
        display: "flex", flexDirection: "column", overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid #e5e7eb", position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <CountryDot country={data?.country} />
                <span style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>{store}</span>
              </div>
              {data && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{data.country} · T12M {KES(data.t12m_net)}</div>}
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280" }}>✕</button>
          </div>
        </div>

        {isLoading && <div style={{ padding: 24, color: "#9ca3af", fontSize: 13 }}>Loading…</div>}
        {error    && <div style={{ padding: 24, color: "#dc2626", fontSize: 13 }}>Failed to load store data.</div>}

        {data && (
          <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Path status */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Growth Path — current month</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  ["MTD Actual",  KES(data.mtd?.actual),    null],
                  ["MTD Required", KES(data.path?.mtd_req), null],
                  ["Gap vs Path", KES(data.path?.gap_kes),
                    <StatusBadge status={data.path?.status} />],
                  ["Monthly Target", KES(data.path?.monthly_req), null],
                ].map(([label, val, badge]) => (
                  <div key={label} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>{label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: data.path?.gap_kes < 0 && label.includes("Gap") ? "#dc2626" : "#111827" }}>{val}</span>
                      {badge}
                    </div>
                  </div>
                ))}
              </div>
              {data.path?.gap_pct != null && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
                  {PCT(data.path.gap_pct)} vs prorated path · Store share {data.path.share_pct}% of retail fleet
                </div>
              )}
            </div>

            {/* Recent trend */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Recent Trend</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  ["L28D Net", KES(data.trend?.l28d_net)],
                  ["Prior 28D", KES(data.trend?.prev28d_net)],
                  ["MoM", data.trend?.mom_pct != null ? PCT(data.trend.mom_pct) : "—"],
                  ["MTD Transactions", (data.mtd?.transactions || 0).toLocaleString()],
                  ["MTD Avg Basket", KES(data.mtd?.avg_basket)],
                ].map(([label, val]) => (
                  <div key={label} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{val}</div>
                  </div>
                ))}
              </div>
              {/* 8-week sparkline table */}
              {data.trend?.weekly?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>8-week weekly net sales</div>
                  <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 40 }}>
                    {(() => {
                      const weeks = data.trend.weekly;
                      const maxVal = Math.max(...weeks.map(w => w.net_sales), 1);
                      return weeks.map((w, i) => (
                        <div key={i} title={`${w.week_start}: ${KES(w.net_sales)}`}
                          style={{ flex: 1, background: "#1a5c38", opacity: 0.2 + 0.8 * (w.net_sales / maxVal), borderRadius: "2px 2px 0 0", height: `${Math.max(4, (w.net_sales / maxVal) * 100)}%%` }} />
                      ));
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* Top categories */}
            {data.categories?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Top Categories (L28D)</div>
                {data.categories.map((c, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid #f3f4f6" }}>
                    <span style={{ fontSize: 12, color: "#374151" }}>{c.category}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{KES(c.net_sales)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* AI Coaching */}
            {(data.coaching || data.coaching_ai) && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
                  Retail Desk Coaching
                  {!data.coaching_ai && <span style={{ marginLeft: 6, fontSize: 10, color: "#d97706" }}>AI not configured</span>}
                </div>
                {data.coaching ? (
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#166534", lineHeight: 1.6, whiteSpace: "pre-line" }}>
                    {data.coaching}
                  </div>
                ) : (
                  <div style={{ color: "#9ca3af", fontSize: 12 }}>No coaching note available for today.</div>
                )}
              </div>
            )}

            {/* Issues */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                  Open Issues ({data.issues?.length || 0})
                </div>
                <button onClick={() => setShowNewIssue(v => !v)}
                  style={{ fontSize: 11, color: "#1a5c38", background: "none", border: "1px solid #1a5c38", borderRadius: 4, padding: "2px 10px", cursor: "pointer" }}>
                  {showNewIssue ? "Cancel" : "+ Add"}
                </button>
              </div>
              {showNewIssue && (
                <NewIssueForm store={store} onSaved={() => { setShowNewIssue(false); refetch(); }} />
              )}
              {data.issues?.length === 0 && !showNewIssue && (
                <div style={{ fontSize: 12, color: "#9ca3af" }}>No open issues.</div>
              )}
              {data.issues?.map(issue => (
                <IssueRow key={issue.id} issue={issue} onClose={closeIssue} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Store card ────────────────────────────────────────────────────────────────

function StoreCard({ card, onClick }) {
  const gapColor = card.status === "ahead" ? "#1a5c38" : card.status === "at_risk" ? "#d97706" : "#dc2626";
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <CountryDot country={card.country} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{card.store}</span>
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>{card.share_pct?.toFixed(1)}% of retail fleet</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <StatusBadge status={card.status} />
          {card.open_issues > 0 && (
            <span style={{ fontSize: 10, color: "#d97706", fontWeight: 600 }}>{card.open_issues} open issue{card.open_issues > 1 ? "s" : ""}</span>
          )}
        </div>
      </div>

      {/* MTD metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        {[
          ["MTD Actual", KES(card.mtd_net)],
          ["MTD Required", KES(card.mtd_req)],
          ["Gap", KES(card.gap_kes)],
        ].map(([label, val]) => (
          <div key={label}>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: label === "Gap" ? gapColor : "#111827" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Progress bar: actual vs required */}
      <MiniBar
        value={card.mtd_net}
        max={Math.max(card.mtd_req, card.mtd_net, 1)}
        color={STATUS_COLOR[card.status]}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#9ca3af", marginTop: 3 }}>
        <span>{PCT(card.gap_pct)} vs path</span>
        {card.mom_pct != null && <span>MoM {PCT(card.mom_pct)}</span>}
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

  const countries = useMemo(() => {
    const cs = [...new Set((data?.stores || []).map(c => c.country))].sort();
    return cs;
  }, [data]);

  if (isLoading) return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
      <div style={{ fontSize: 13, color: "#9ca3af" }}>Loading Retail Desk…</div>
      {[1,2,3].map(i => <div key={i} style={{ height: 80, width: "100%", maxWidth: 700, background: "#f3f4f6", borderRadius: 8 }} />)}
    </div>
  );

  if (error) return (
    <div style={{ padding: 32, color: "#dc2626", fontSize: 13 }}>
      Failed to load Retail Desk. {String(error)}
    </div>
  );

  const totalFleetGapPct = fleet?.total_gap_pct;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111827", margin: 0 }}>Retail Desk</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Phase 3 · Per-store growth path tracking and coaching · {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      {/* Fleet KPIs */}
      {fleet && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 24 }}>
          <FleetKPI
            label="Fleet MTD"
            value={KES(fleet.total_mtd)}
            sub={`Required ${KES(fleet.total_mtd_req)}`}
            color={fleet.total_gap_pct >= 0 ? "#1a5c38" : "#dc2626"}
          />
          <FleetKPI
            label="Fleet Gap"
            value={`${fleet.total_gap_pct >= 0 ? "+" : ""}${fleet.total_gap_pct?.toFixed(1)}%`}
            sub={KES(fleet.total_gap_kes)}
            color={fleet.total_gap_pct >= 0 ? "#1a5c38" : "#dc2626"}
          />
          <FleetKPI
            label="On Path"
            value={`${fleet.ahead} / ${fleet.total_stores}`}
            sub={`${fleet.at_risk} at risk · ${fleet.behind} behind`}
            color="#1a5c38"
          />
          <FleetKPI
            label="At Risk"
            value={fleet.at_risk}
            sub="stores (within −15%)"
            color="#d97706"
          />
          <FleetKPI
            label="Behind"
            value={fleet.behind}
            sub="stores (below −15%)"
            color={fleet.behind > 0 ? "#dc2626" : "#6b7280"}
          />
          <FleetKPI
            label="Open Issues"
            value={fleet.open_issues}
            sub="across all stores"
            color={fleet.open_issues > 0 ? "#d97706" : "#6b7280"}
          />
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Filter stores…"
          style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 10px", fontSize: 13, width: 180 }}
        />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}>
          <option value="all">All statuses</option>
          <option value="behind">Behind</option>
          <option value="at_risk">At Risk</option>
          <option value="ahead">Ahead</option>
        </select>
        <select value={filterCountry} onChange={e => setFilterCountry(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}>
          <option value="all">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={refetch}
          style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}>
          Refresh
        </button>
      </div>

      {/* Store count */}
      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>
        {stores.length} store{stores.length !== 1 ? "s" : ""}
        {filterStatus !== "all" || filterCountry !== "all" || search ? " (filtered)" : ""}
      </div>

      {/* Store grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 12 }}>
        {stores.map(card => (
          <StoreCard key={card.store} card={card} onClick={() => setSelectedStore(card.store)} />
        ))}
        {stores.length === 0 && (
          <div style={{ gridColumn: "1 / -1", padding: 32, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
            No stores match the current filters.
          </div>
        )}
      </div>

      {/* Note on path methodology */}
      <div style={{ marginTop: 24, padding: "12px 16px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, fontSize: 12, color: "#92400e" }}>
        Store path = each store's T12M share of total retail, applied to the same-store lever ({data?.stores?.[0] ? "60%" : "—"} of monthly growth milestone).
        Ahead = MTD actual above prorated target. At Risk = within −15%. Behind = more than −15% below.
        Click any card for the coaching note and issue register.
      </div>

      {/* Store drawer */}
      {selectedStore && (
        <StoreDrawer store={selectedStore} onClose={() => setSelectedStore(null)} />
      )}
    </div>
  );
}
