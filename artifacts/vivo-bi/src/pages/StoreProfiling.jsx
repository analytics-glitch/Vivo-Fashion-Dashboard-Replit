import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useApi } from "@/lib/useApi";
import { api } from "@/lib/api";

// ── Formatters ───────────────────────────────────────────────────────────────
const fmtKES = (v, compact = true) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (!compact) return `KES ${Number(v).toLocaleString()}`;
  if (a >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000)     return `KES ${(v / 1_000).toFixed(0)}k`;
  return `KES ${Number(v).toFixed(0)}`;
};
const fmtNum = (v) => v == null ? "—" : Number(v).toLocaleString();
const fmtPct = (v) => v == null ? "—" : `${Number(v).toFixed(1)}%`;
const fmt    = (f, v) => f === "kes" ? fmtKES(v, false) : f === "kes_c" ? fmtKES(v, true) : f === "kes_whole" ? (v == null ? "—" : `KES ${Number(v).toLocaleString(undefined, {maximumFractionDigits: 0})}`) : f === "pct" ? fmtPct(v) : fmtNum(v);

// ── Colour tokens ────────────────────────────────────────────────────────────
const C = {
  good:  { fg: "#15803d", bg: "#f0fdf4", bdr: "#86efac" },
  ok:    { fg: "#0f766e", bg: "#f0fdfa", bdr: "#99f6e4" },
  warn:  { fg: "#b45309", bg: "#fffbeb", bdr: "#fde68a" },
  bad:   { fg: "#dc2626", bg: "#fef2f2", bdr: "#fecaca" },
  crit:  { fg: "#7f1d1d", bg: "#fff1f2", bdr: "#fca5a5" },
  muted: { fg: "#6b7280", bg: "#f9fafb", bdr: "#e5e7eb" },
  amber: { fg: "#92400e", bg: "#fffbeb", bdr: "#fde68a" },
  blue:  { fg: "#1d4ed8", bg: "#eff6ff", bdr: "#bfdbfe" },
};
const BAR_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6","#f97316"];

function scorePct(pct, lowerBetter = false) {
  const v = lowerBetter ? 200 - pct : pct;
  if (v >= 100) return C.good;
  if (v >= 88)  return C.ok;
  if (v >= 70)  return C.warn;
  if (v >= 45)  return C.bad;
  return C.crit;
}

// ── Network Bucket Summary ────────────────────────────────────────────────────
const BUCKET_META = [
  { key: "behind_pace",   label: "Behind Pace",    icon: "🔴", tone: { fg: "#dc2626", bg: "#fef2f2", bdr: "#fecaca" }, desc: "Revenue attainment >15% below day pace" },
  { key: "on_pace",       label: "On Pace",         icon: "✅", tone: { fg: "#15803d", bg: "#f0fdf4", bdr: "#86efac" }, desc: "Tracking within 15% of day pace" },
  { key: "ahead_of_pace", label: "Ahead of Pace",   icon: "🚀", tone: { fg: "#1d4ed8", bg: "#eff6ff", bdr: "#bfdbfe" }, desc: "Revenue attainment >15% above day pace" },
  { key: "high_discount", label: "High Discount",   icon: "⚠️", tone: { fg: "#b45309", bg: "#fffbeb", bdr: "#fde68a" }, desc: "Discount rate >13% of gross revenue" },
  { key: "high_returns",  label: "High Returns",    icon: "↩️", tone: { fg: "#7f1d1d", bg: "#fff1f2", bdr: "#fca5a5" }, desc: "Return rate >5% of units sold" },
  { key: "low_stock",     label: "Low Stock",       icon: "📦", tone: { fg: "#78350f", bg: "#fff7ed", bdr: "#fed7aa" }, desc: "More than 5% below optimal stock" },
  { key: "overstocked",   label: "Overstocked",     icon: "🏭", tone: { fg: "#374151", bg: "#f3f4f6", bdr: "#d1d5db" }, desc: "More than 5% above optimal stock" },
  { key: "no_target",     label: "No Target Set",   icon: "❓", tone: { fg: "#6b7280", bg: "#f9fafb", bdr: "#e5e7eb" }, desc: "No monthly revenue target configured" },
];

const COUNTRY_BADGE = {
  Kenya:  { bg: "#f0fdf4", fg: "#15803d" },
  Uganda: { bg: "#fffbeb", fg: "#b45309" },
  Rwanda: { bg: "#f0fdfa", fg: "#0f766e" },
};

function StoreBucketSummary({ onSelectStore }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(null); // key of expanded bucket card

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api.get("/store-profile/network-summary", { timeout: 30000 })
      .then((r) => { if (!dead) setData(r.data); })
      .catch((e) => { if (!dead) setErr(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, []);

  const buckets = data?.buckets || {};
  const storeMap = useMemo(() => {
    const m = {};
    (data?.stores || []).forEach((s) => { m[s.store] = s; });
    return m;
  }, [data]);

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, marginBottom: 18, overflow: "hidden" }}>
      {/* Header row */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 20px", cursor: "pointer", borderBottom: open ? "1px solid #f3f4f6" : "none", userSelect: "none" }}
      >
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#111827" }}>🗺 Network Overview</span>
          <span style={{ marginLeft: 10, fontSize: 11, color: "#6b7280", fontWeight: 500 }}>
            {data ? `${data.stores?.length || 0} stores · Day ${data.days_done} of ${data.days_in_month} · Day pace ${data.day_pace_pct}%` : ""}
          </span>
        </div>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>{open ? "▲ hide" : "▼ show"}</span>
      </div>

      {open && (
        <div style={{ padding: "16px 20px" }}>
          {loading && (
            <div style={{ display: "flex", gap: 12 }}>
              {[1,2,3,4].map((i) => (
                <div key={i} style={{ flex: 1, height: 72, background: "#f3f4f6", borderRadius: 10, animation: "pulse 1.5s ease infinite" }} />
              ))}
            </div>
          )}
          {err && <div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, color: "#dc2626", fontSize: 13 }}>⚠ {err}</div>}
          {!loading && !err && data && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
              {BUCKET_META.map((bm) => {
                const stores = buckets[bm.key] || [];
                const isOpen = expanded === bm.key;
                return (
                  <div
                    key={bm.key}
                    style={{ border: `1px solid ${bm.tone.bdr}`, borderRadius: 10, background: bm.tone.bg, cursor: stores.length ? "pointer" : "default", transition: "box-shadow 0.15s" }}
                    onClick={() => stores.length && setExpanded(isOpen ? null : bm.key)}
                  >
                    <div style={{ padding: "11px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 14 }}>{bm.icon}</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: bm.tone.fg }}>{bm.label}</span>
                        <span style={{ marginLeft: "auto", fontSize: 20, fontWeight: 900, color: bm.tone.fg }}>{stores.length}</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: bm.tone.fg, opacity: 0.75, marginBottom: stores.length ? 6 : 0 }}>{bm.desc}</div>
                      {!isOpen && stores.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {stores.slice(0, 4).map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onSelectStore(s); }}
                              style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, border: `1px solid ${bm.tone.bdr}`, background: "#fff", color: bm.tone.fg, cursor: "pointer" }}
                            >
                              {s}
                            </button>
                          ))}
                          {stores.length > 4 && <span style={{ fontSize: 10, color: bm.tone.fg, padding: "2px 4px", fontWeight: 600 }}>+{stores.length - 4} more</span>}
                        </div>
                      )}
                    </div>
                    {/* Expanded detail */}
                    {isOpen && stores.length > 0 && (
                      <div style={{ borderTop: `1px solid ${bm.tone.bdr}`, padding: "10px 14px" }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {stores.map((s) => {
                            const sd = storeMap[s];
                            const cc = COUNTRY_BADGE[sd?.country] || {};
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onSelectStore(s); }}
                                style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 7, border: `1px solid ${bm.tone.bdr}`, background: "#fff", cursor: "pointer", textAlign: "left" }}
                              >
                                <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>{s}</span>
                                {sd?.country && (
                                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: cc.bg, color: cc.fg }}>{sd.country.slice(0, 3).toUpperCase()}</span>
                                )}
                                {sd?.attainment_pct != null && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: bm.tone.fg }}>{sd.attainment_pct}%</span>
                                )}
                                {bm.key === "high_discount" && sd?.discount_rate != null && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: bm.tone.fg }}>{sd.discount_rate}%</span>
                                )}
                                {bm.key === "high_returns" && sd?.return_rate != null && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: bm.tone.fg }}>{sd.return_rate}%</span>
                                )}
                                {(bm.key === "low_stock" || bm.key === "overstocked") && sd?.stock_variance_pct != null && (
                                  <span style={{ fontSize: 10, fontWeight: 700, color: bm.tone.fg }}>{sd.stock_variance_pct > 0 ? "+" : ""}{sd.stock_variance_pct}% vs optimal</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {/* Mini table for this bucket */}
                        {(bm.key === "behind_pace" || bm.key === "ahead_of_pace" || bm.key === "on_pace") && (
                          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10, fontSize: 11 }}>
                            <thead>
                              <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
                                <th style={{ textAlign: "left", padding: "4px 8px", color: "#6b7280", fontWeight: 700 }}>Store</th>
                                <th style={{ textAlign: "right", padding: "4px 8px", color: "#6b7280", fontWeight: 700 }}>Attainment</th>
                                <th style={{ textAlign: "right", padding: "4px 8px", color: "#6b7280", fontWeight: 700 }}>Day pace</th>
                              </tr>
                            </thead>
                            <tbody>
                              {stores.map((s) => {
                                const sd = storeMap[s];
                                const gap = sd?.attainment_pct != null ? (sd.attainment_pct - sd.day_pace_pct).toFixed(1) : null;
                                return (
                                  <tr key={s} style={{ borderBottom: "1px solid #f3f4f6" }}>
                                    <td style={{ padding: "5px 8px", fontWeight: 700, color: "#111827" }}>
                                      <button type="button" onClick={() => onSelectStore(s)} style={{ background: "none", border: "none", cursor: "pointer", color: "#111827", fontWeight: 700, fontSize: 11 }}>{s}</button>
                                    </td>
                                    <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 800, color: bm.tone.fg }}>{sd?.attainment_pct ?? "—"}%</td>
                                    <td style={{ padding: "5px 8px", textAlign: "right", color: "#6b7280" }}>
                                      {sd?.day_pace_pct ?? "—"}%
                                      {gap != null && <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: bm.tone.fg }}>({gap > 0 ? "+" : ""}{gap}pt)</span>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StoreProfileStorePicker({ stores, selected, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const allStores = selected?.length === 0;
  const selectedLabel = allStores
    ? "All Stores · Whole Business"
    : selected?.length === 1
      ? selected[0]
      : `${selected?.length || 0} stores selected`;

  const toggleStore = (name) => {
    if (allStores) {
      onChange([name]);
      return;
    }
    if (selected.includes(name)) {
      onChange(selected.length === 1 ? [] : selected.filter((s) => s !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div style={{ position: "relative", minWidth: 280 }}>
      {loading ? (
        <div style={{ width: 280, height: 44, background: "#374151", borderRadius: 8 }} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-testid="store-profile-picker"
            style={{ width: "100%", border: "1px solid #4b5563", borderRadius: 8, padding: "9px 16px", fontSize: 20, fontWeight: 800, color: "#fff", minWidth: 280, background: "#1f2937", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedLabel}</span>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>{open ? "▲" : "▼"}</span>
          </button>
          {open && (
            <div
              role="group"
              aria-label="Store filter"
              data-testid="store-profile-picker-menu"
              style={{ position: "absolute", zIndex: 20, top: "calc(100% + 6px)", left: 0, width: 330, maxWidth: "calc(100vw - 32px)", maxHeight: 360, overflowY: "auto", padding: 8, border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", boxShadow: "0 12px 28px rgba(17,24,39,.22)" }}
            >
              <button
                type="button"
                onClick={() => onChange([])}
                data-testid="store-profile-option-all"
                style={{ width: "100%", border: "none", borderRadius: 7, background: allStores ? "#eff6ff" : "#fff", color: "#111827", padding: "9px 10px", cursor: "pointer", textAlign: "left", fontWeight: 800, fontSize: 13 }}
              >
                <span style={{ display: "inline-block", width: 18 }}>{allStores ? "✓" : ""}</span>
                All Stores · Whole Business
              </button>
              <div style={{ height: 1, background: "#e5e7eb", margin: "6px 2px" }} />
              {stores.map((s) => {
                const checked = !allStores && selected.includes(s.store);
                return (
                  <label
                    key={s.store}
                    style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 7, cursor: "pointer", background: checked ? "#f0fdf4" : "#fff", color: "#111827", fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStore(s.store)}
                      data-testid={`store-profile-option-${s.store}`}
                    />
                    <span style={{ flex: 1 }}>{s.store}</span>
                    <span style={{ fontSize: 10, color: "#6b7280" }}>{s.country}</span>
                  </label>
                );
              })}
              <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 6, padding: "8px 10px 2px", fontSize: 11, color: "#6b7280" }}>
                Select one or more stores to combine their scorecard. Choose All Stores to include the whole business.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Primitives ───────────────────────────────────────────────────────────────
function Skeleton({ rows = 5 }) {
  return (
    <div style={{ padding: "8px 0" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ height: 18, background: "#f3f4f6", borderRadius: 4, marginBottom: 10, width: `${55 + (i % 5) * 9}%` }} />
      ))}
    </div>
  );
}
function ErrBox({ msg }) {
  return (
    <div style={{ padding: 16, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 14, border: "1px solid #fca5a5" }}>
      ⚠ {msg || "Could not load data"}
    </div>
  );
}
function Bar({ value, max, color = "#6366f1", h = 10 }) {
  const pct = max > 0 ? Math.min(value / max * 100, 100) : 0;
  return (
    <div style={{ background: "#e5e7eb", borderRadius: h, height: h, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: h, minWidth: pct > 0 ? 4 : 0, transition: "width 0.4s ease" }} />
    </div>
  );
}
function Pill({ children, c }) {
  const col = c || C.muted;
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: col.bg, color: col.fg, border: `1px solid ${col.bdr}`, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}
function Sparkline({ values, w = 90, h = 26 }) {
  const vals = (values || []).filter(v => v != null);
  if (vals.length < 2) return <span style={{ color: "#d1d5db" }}>—</span>;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pts = values.map((v, i) => v == null ? null : `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / range) * (h - 6)}`).filter(Boolean).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={up ? "#16a34a" : "#dc2626"} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
function SectionTitle({ icon, title, subtitle, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, margin: "28px 0 14px" }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#111827", letterSpacing: "-0.02em" }}>{icon} {title}</div>
        {subtitle && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

const STOCK_DIMENSIONS = [
  ["category", "Category"], ["subcategory", "Sub-category"], ["size", "Size"],
  ["primary_colour", "Primary colour"], ["print_plain", "Print / Plain"],
  ["price_band", "KES price bracket"],
];
const STOCK_STATUS = {
  well_below: C.bad, below: C.warn, on_target: C.good, above: C.blue,
  not_configured: C.muted,
};

function StockToSalesTable({ data }) {
  const [dimension, setDimension] = useState("category");
  const [showSizes, setShowSizes] = useState(false);

  if (!data) return null;
  const rows = data.stock_to_sales?.[dimension] || [];
  const sizeInfo = data.size_completeness || {};
  const th = { padding: "9px 11px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", color: "#6b7280", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" };
  
  return (
    <div data-testid="store-stock-to-sales" style={{ display: "grid", gap: 14 }}>
      {/* Evidence summary */}
      {data.evidence && data.evidence.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "11px 13px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>Evidence summary</div>
          <div style={{ display: "grid", gap: 3, marginTop: 5 }}>
            {data.evidence.map((e) => <div key={e.key} style={{ fontSize: 13, color: "#374151" }}><strong>• {e.summary}</strong></div>)}
          </div>
          <div style={{ marginTop: 5, color: "#9ca3af", fontSize: 11 }}>Evidence flags describe current stock conditions; they do not automatically label weak sales as a stock problem.</div>
        </div>
      )}

      {/* Stock to Sales Table */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: 14, display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
          <div><strong>Rolling 30-day stock to sales & weeks of cover</strong><div style={{ color: "#6b7280", fontSize: 12 }}>Current stock, sales mix, and WOC on the same basis for every dimension, including segments with no sales</div></div>
          <select value={dimension} onChange={e => setDimension(e.target.value)} aria-label="Stock-to-sales dimension" style={{ padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 7, background: "#fff" }}>{STOCK_DIMENSIONS.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr><th style={{...th,textAlign:"left"}}>Segment</th><th style={th}>Inventory</th><th style={th}>Units sold</th><th style={th}>Stock share</th><th style={th}>Sales share</th><th style={th}>Variance</th><th style={th}>Weeks cover</th></tr></thead><tbody>
          {rows.map(r => <tr key={r.segment} style={{ borderBottom: "1px solid #f3f4f6" }}><td style={{ padding: 10, fontWeight: 700 }}>{r.segment}</td><td style={{ padding: 10, textAlign: "right" }}>{fmtNum(r.inventory_units)}</td><td style={{ padding: 10, textAlign: "right" }}>{r.no_sales ? <Pill c={C.warn}>No sales</Pill> : fmtNum(r.units_sold)}</td><td style={{ padding: 10, textAlign: "right" }}>{fmtPct(r.stock_share_pct)}</td><td style={{ padding: 10, textAlign: "right" }}>{fmtPct(r.sales_share_pct)}</td><td style={{ padding: 10, textAlign: "right", fontWeight: 800, color: Math.abs(r.share_variance_pp) >= 10 ? C.bad.fg : "#374151" }}>{r.share_variance_pp > 0 ? "+" : ""}{r.share_variance_pp}pt</td><td style={{ padding: 10, textAlign: "right" }}>{r.weeks_of_cover == null ? "No sales" : `${r.weeks_of_cover}w`}</td></tr>)}
        </tbody></table></div>
      </div>

      {/* Size Completeness Gaps Table */}
      {sizeInfo.colour_styles_with_missing_sizes > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "11px 13px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div><strong>Missing Sizes Details</strong><div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>Inspect the {fmtNum(sizeInfo.colour_styles_with_missing_sizes)} colour-styles that have at least one missing size.</div></div>
            <button type="button" onClick={() => setShowSizes(v => !v)} style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 7, padding: "6px 10px", cursor: "pointer", fontWeight: 700 }}>{showSizes ? "Hide gaps" : `Inspect gaps`}</button>
          </div>
          {showSizes && <div style={{ overflowX: "auto", marginTop: 12, maxHeight: 330, overflowY: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}><thead><tr><th style={{...th,textAlign:"left"}}>Style</th><th style={{...th,textAlign:"left"}}>Primary colour</th><th style={{...th,textAlign:"left"}}>Expected</th><th style={{...th,textAlign:"left"}}>Present</th><th style={{...th,textAlign:"left"}}>Missing</th></tr></thead><tbody>
            {(sizeInfo.rows || []).map((r) => <tr key={`${r.style}|${r.primary_colour}`} style={{ borderBottom: "1px solid #f3f4f6" }}><td style={{ padding: 9, fontWeight: 700 }}>{r.style}</td><td style={{ padding: 9 }}>{r.primary_colour}</td><td style={{ padding: 9 }}>{r.expected_sizes.join(", ")}</td><td style={{ padding: 9 }}>{r.present_sizes.join(", ") || "None"}</td><td style={{ padding: 9, color: C.bad.fg, fontWeight: 700 }}>{r.missing_sizes.join(", ")}</td></tr>)}
          </tbody></table></div>}
        </div>
      )}
    </div>
  );
}

// ── KPI metadata ─────────────────────────────────────────────────────────────
const KPI_META = [
  { key: "revenue",                label: "Revenue",         f: "kes_c", vol: true,  unit: "" },
  { key: "units",                  label: "Items Sold",      f: "num",   vol: true,  unit: "items" },
  { key: "transactions",           label: "Transactions",    f: "num",   vol: true,  unit: "txns" },
  { key: "asp",                    label: "ASP",             f: "kes_whole", rate: true, note: "Revenue ÷ Units" },
  { key: "abv",                    label: "ABV",             f: "kes_whole", rate: true, note: "Revenue ÷ Transactions" },
  { key: "footfall",               label: "Footfall",        f: "num",   vol: true,  unit: "visitors" },
  { key: "conversion",             label: "Conversion",      f: "pct",   rate: true },
  { key: "customer_count",         label: "Customers",       f: "num",   vol: true,  unit: "customers" },
  { key: "new_customer_pct",       label: "% New Cust.",     f: "pct",   rate: true },
  { key: "returning_customer_pct", label: "% Returning",     f: "pct",   rate: true },
  { key: "discount_rate",          label: "Discount Rate",   f: "pct",   rate: true, lowerBetter: true },
  { key: "return_rate",            label: "Return Rate",     f: "pct",   rate: true, lowerBetter: true },
];

// health status vs baseline: compare projected full-month vs baseline (like-for-like)
function healthOf(projected, baseline, lowerBetter) {
  if (projected == null || baseline == null || baseline === 0) return null;
  let delta = (projected - baseline) / Math.abs(baseline) * 100;
  if (lowerBetter) delta = -delta;
  if (delta >= 3)   return { status: "strong", c: C.good,  label: "Strong",  delta };
  if (delta >= -6)  return { status: "steady", c: C.ok,    label: "Steady",  delta };
  if (delta >= -18) return { status: "watch",  c: C.warn,  label: "Watch",   delta };
  return { status: "issue", c: C.bad, label: "Issue", delta };
}

// ══════════════════════════════════════════════════════════════════════════════
// 0 · PRIORITY FOCUS — impact-ranked levers + metric interlinks
// ══════════════════════════════════════════════════════════════════════════════
const LEVER_C = {
  "traffic→sales":     C.blue,
  "traffic":           C.blue,
  "basket":            C.ok,
  "price/mix":         C.ok,
  "margin guardrail":  C.warn,
  "quality guardrail": C.warn,
  "pipeline":          C.muted,
  "assortment":        C.blue,
  "product mix":       C.ok,
};

function PriorityFocus({ rpt, stockData }) {
  const performanceDrivers = rpt?.priority_drivers || [];
  const productDrivers = (stockData?.recommendations || []).map((d, i) => ({
    ...d,
    rank: performanceDrivers.length + i + 1,
  }));
  const drivers = [...performanceDrivers, ...productDrivers];
  if (!drivers.length) {
    return (
      <div style={{ padding: "14px 18px", background: C.good.bg, border: `1px solid ${C.good.bdr}`, borderRadius: 10, fontSize: 14, color: C.good.fg }}>
        ✅ No metric is projecting below its baseline — hold the current playbook and defend conversion & basket.
      </div>
    );
  }
  const maxImpact = Math.max(...drivers.map(d => d.kes_impact || 0), 1);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {drivers.map(d => {
        const lc = LEVER_C[d.lever] || C.muted;
        const top = d.rank === 1;
        return (
          <div key={d.key} style={{ display: "flex", gap: 14, alignItems: "flex-start", background: "#fff", border: `1px solid ${top ? "#fca5a5" : "#e5e7eb"}`, borderLeft: `5px solid ${top ? C.bad.fg : lc.fg}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 15, background: top ? C.bad.bg : "#f3f4f6", color: top ? C.bad.fg : "#374151", border: `1px solid ${top ? C.bad.bdr : "#e5e7eb"}` }}>{d.rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>{d.label}</span>
                <Pill c={lc}>{d.lever}</Pill>
                <span style={{ fontSize: 12.5, color: "#6b7280" }}>{d.gap_text}</span>
              </div>
              <div style={{ fontSize: 13, color: "#4b5563", marginTop: 4 }}>{d.note}</div>
              {d.linked?.length > 0 && (
                <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 6 }}>
                  🔗 Moves with: {d.linked.map(k => KPI_META.find(m => m.key === k)?.label || k).join(" · ")}
                </div>
              )}
            </div>
            <div style={{ textAlign: "right", minWidth: 150, flexShrink: 0 }}>
              {d.kes_impact != null ? (
                <>
                  <div style={{ fontSize: 17, fontWeight: 900, color: top ? C.bad.fg : "#111827" }}>+{fmtKES(d.kes_impact)}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>if back to baseline{d.pct_of_gap != null ? ` · ~${d.pct_of_gap}% of gap` : ""}</div>
                  <div style={{ marginTop: 6, width: 140, marginLeft: "auto" }}>
                    <Bar value={d.kes_impact} max={maxImpact} color={top ? C.bad.fg : lc.fg} h={6} />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: d.source === "product" ? C.ok.fg : "#6b7280", fontWeight: d.source === "product" ? 800 : 400, fontStyle: d.source === "product" ? "normal" : "italic" }}>
                  {d.source === "product" ? "Product action" : "Future-month impact"}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11.5, color: "#9ca3af" }}>
        Impact = extra full-month revenue if that one metric returns to baseline while the others stay at their projected level. Levers overlap (e.g. ASP feeds ABV) — treat the ranking as where attention pays most, not additive amounts.
      </div>
    </div>
  );
}

// ── AI Diagnosis — model reads the health check and names the real issues ────
const SEV_C = { high: C.bad, medium: C.warn, low: C.muted };
function AiDiagnosis({ store }) {
  const { data, isLoading, error } = useApi("store-profile/ai-diagnosis", { store }, { enabled: !!store, staleTime: 30 * 60_000 });
  if (isLoading) {
    return (
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 18px", fontSize: 13, color: "#6b7280", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pulse" style={{ fontSize: 16 }}>🤖</span> AI is reading this store's health check…
      </div>
    );
  }
  if (error || !data || data.configured === false || data.error) return null;
  const issues = data.issues || [];
  if (!issues.length && !data.summary) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #c7d2fe", borderRadius: 12, padding: "16px 18px", marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>🤖</span>
        <span style={{ fontSize: 13.5, fontWeight: 800, color: "#3730a3" }}>AI Diagnosis</span>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>root-cause read of the numbers above</span>
      </div>
      {data.summary && <div style={{ fontSize: 13.5, color: "#374151", marginBottom: issues.length ? 10 : 0 }}>{data.summary}</div>}
      <div style={{ display: "grid", gap: 8 }}>
        {issues.map((it, i) => {
          const c = SEV_C[it.severity] || C.muted;
          const label = KPI_META.find(m => m.key === it.kpi)?.label || it.kpi;
          return (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: c.bg, border: `1px solid ${c.bdr}`, borderRadius: 8, padding: "10px 12px" }}>
              <Pill c={c}>{it.severity}</Pill>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#111827" }}>{label}</span>
                <span style={{ fontSize: 13, color: "#4b5563" }}> — {it.why}</span>
                {it.action && <div style={{ fontSize: 12.5, color: "#374151", marginTop: 3 }}><strong>Do:</strong> {it.action}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Driver interlink chain: how one metric leads to a change in the other
function DriverChain({ rpt }) {
  const statusByKey = useMemo(() => {
    const m = {};
    (rpt?.kpi_rows || []).forEach(r => { m[r.key] = r; });
    return m;
  }, [rpt]);
  const projected = rpt?.projected_eom || {};
  const expected  = rpt?.expected || {};

  const Node = ({ k, label, sub }) => {
    const meta = KPI_META.find(m => m.key === k);
    const h = healthOf(projected?.[k], expected?.[k], meta?.lowerBetter);
    const col = h?.c || C.muted;
    return (
      <div style={{ background: col.bg, border: `1.5px solid ${col.bdr}`, borderRadius: 10, padding: "10px 14px", textAlign: "center", minWidth: 108 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: "#111827" }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 900, color: col.fg, marginTop: 2 }}>{fmt(meta?.f === "kes_c" ? "kes_c" : meta?.f, projected?.[k])}</div>
        {sub && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{sub}</div>}
        {h && <div style={{ fontSize: 10, fontWeight: 700, color: col.fg, marginTop: 2 }}>{h.label}{h.delta != null ? ` ${h.delta > 0 ? "▲" : "▼"}${Math.abs(h.delta).toFixed(0)}%` : ""}</div>}
      </div>
    );
  };
  const Op = ({ children }) => (
    <div style={{ fontSize: 16, fontWeight: 900, color: "#9ca3af", padding: "0 2px", alignSelf: "center" }}>{children}</div>
  );

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px" }}>
      {/* Main revenue equation */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap", justifyContent: "center" }}>
        <Node k="footfall" label="Footfall" sub="visitors in" />
        <Op>×</Op>
        <Node k="conversion" label="Conversion" sub="visitors → buyers" />
        <Op>=</Op>
        <Node k="transactions" label="Transactions" sub="baskets sold" />
        <Op>×</Op>
        <Node k="abv" label="ABV" sub="value per basket" />
        <Op>=</Op>
        <Node k="revenue" label="Revenue" sub="net, projected" />
      </div>
      {/* Feeder relationships */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 16 }}>
        {[
          { kids: [["asp", "ASP"]], arrow: "→ ABV", note: "ABV = ASP × items per basket. Higher price per item lifts every basket." },
          { kids: [["discount_rate", "Discount Rate"]], arrow: "↓ ASP", note: "Deeper markdowns pull ASP (and so ABV) down — margin guardrail." },
          { kids: [["return_rate", "Return Rate"]], arrow: "↓ Revenue", note: "Returns subtract straight from net revenue after the sale." },
          { kids: [["new_customer_pct", "% New Cust."]], arrow: "→ future Footfall", note: "Today's new customers become the returning traffic of coming months." },
        ].map(({ kids, arrow, note }, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px" }}>
            {kids.map(([k, label]) => <Node key={k} k={k} label={label} />)}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#374151" }}>{arrow}</div>
              <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 2 }}>{note}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 12 }}>
        Node colour = projected month vs baseline (green strong · teal steady · amber watch · red issue). Fixing an upstream metric (left) flows into every metric to its right.
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 1 · STORE HEALTH CHECK — issue radar
// ══════════════════════════════════════════════════════════════════════════════
function TopKPIs({ rpt, stockData }) {
  const { mtd, projected_eom, expected } = rpt || {};
  const perfTiles = useMemo(() => {
    if (!rpt) return [];
    const sevRank = { issue: 0, watch: 1, steady: 2, strong: 3 };
    return KPI_META.map(m => {
      const h = healthOf(projected_eom?.[m.key], expected?.[m.key], m.lowerBetter);
      return { ...m, actual: mtd?.[m.key], proj: projected_eom?.[m.key], base: expected?.[m.key], h };
    }).sort((a, b) => (a.h ? sevRank[a.h.status] : 9) - (b.h ? sevRank[b.h.status] : 9));
  }, [rpt]); // eslint-disable-line react-hooks/exhaustive-deps

  const stockTiles = useMemo(() => {
    if (!stockData) return [];
    const inv = stockData.inventory || {};
    const styles = stockData.styles || {};
    const cStyles = stockData.colour_styles || {};
    const sc = stockData.size_completeness || {};
    const active = (stockData.lifecycle || []).find(l => l.lifecycle === "Active") || {};
    const retired = (stockData.lifecycle || []).find(l => l.lifecycle === "Retired") || {};

    const avgUnitsPerStyle = inv.actual && styles.actual ? Math.round(inv.actual / styles.actual) : null;
    const avgUnitsPerCStyle = inv.actual && cStyles.actual ? Math.round(inv.actual / cStyles.actual) : null;
    const missingPct = sc.assessable_colour_styles ? (sc.colour_styles_with_missing_sizes / sc.assessable_colour_styles * 100) : null;
    const formatStatus = (s) => s ? s.replace(/_/g, " ") : "";

    return [
      {
        key: "inv", label: "Inventory", actual: inv.actual, f: "num",
        note: "Current stock on hand", valSuffix: "units",
        h: inv.status ? { label: formatStatus(inv.status), c: STOCK_STATUS[inv.status] || C.muted, deltaLabel: inv.target ? `${fmtNum(inv.target)} target` : "No target configured" } : null,
      },
      {
        key: "styles", label: "Styles", actual: styles.actual, f: "num",
        note: "Distinct styles in stock", valSuffix: "styles",
        h: avgUnitsPerStyle ? { label: "avg depth", c: C.blue, deltaLabel: `${avgUnitsPerStyle} units per style` } : null,
      },
      {
        key: "cstyles", label: "Colour Styles", actual: cStyles.actual, f: "num",
        note: "Distinct colour-styles", valSuffix: "styles",
        h: avgUnitsPerCStyle ? { label: "avg depth", c: C.blue, deltaLabel: `${avgUnitsPerCStyle} units per colour style` } : null,
      },
      {
        key: "sizecomp", label: "Size Completeness", actual: sc.complete_colour_styles, f: "num",
        note: `of ${fmtNum(sc.assessable_colour_styles)} assessable`, valSuffix: "complete",
        h: missingPct != null ? { label: "gaps", c: missingPct >= 20 ? C.warn : C.good, deltaLabel: `${missingPct.toFixed(1)}% have ≥1 missing size` } : null,
      },
      {
        key: "active", label: "Active", actual: active.units, f: "num",
        note: "Current lifecycle", valSuffix: "units",
        h: active.inventory_share_pct != null ? { label: "mix", c: C.blue, deltaLabel: `${active.inventory_share_pct.toFixed(1)}% of total units` } : null,
      },
      {
        key: "retired", label: "Retired", actual: retired.units, f: "num",
        note: "Current lifecycle", valSuffix: "units",
        h: retired.inventory_share_pct != null ? { label: "mix", c: retired.inventory_share_pct >= 15 ? C.warn : C.good, deltaLabel: `${retired.inventory_share_pct.toFixed(1)}% of total units` } : null,
      }
    ];
  }, [stockData]);

  const counts = perfTiles.reduce((acc, t) => { if (t.h) acc[t.h.status] = (acc[t.h.status] || 0) + 1; return acc; }, {});

  return (
    <div>
      <SectionTitle icon={null} title="Store Scorecard KPIs"
        subtitle="Performance vs baseline alongside key product metrics"
        right={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {counts.issue  > 0 && <Pill c={C.bad}>{counts.issue} issue{counts.issue > 1 ? "s" : ""}</Pill>}
            {counts.watch  > 0 && <Pill c={C.warn}>{counts.watch} watch</Pill>}
            {(counts.steady || 0) + (counts.strong || 0) > 0 && <Pill c={C.good}>{(counts.steady || 0) + (counts.strong || 0)} healthy</Pill>}
          </div>
        } />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
        {perfTiles.map(t => {
          const c = t.h?.c || C.muted;
          return (
            <div key={t.key} style={{ background: "#fff", border: `1px solid ${c.bdr}`, borderLeft: `5px solid ${c.fg}`, borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t.label}</span>
                {t.h && <Pill c={c}>{t.h.label}</Pill>}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>
                {fmt(t.f, t.actual)}
                {t.key === "new_customer_pct" && mtd?.new_customers != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", marginLeft: 6 }}>· {mtd.new_customers} of {mtd.customer_count}</span>
                )}
                {t.key === "returning_customer_pct" && mtd?.returning_customers != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", marginLeft: 6 }}>· {mtd.returning_customers} of {mtd.customer_count}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>MTD{t.note ? ` · ${t.note}` : ""}</div>
              {t.h && (
                <div style={{ fontSize: 12, fontWeight: 700, marginTop: 6, color: c.fg }}>
                  {t.h.delta >= 0 ? "▲" : "▼"} {Math.abs(t.h.delta).toFixed(0)}% vs baseline
                  <span style={{ fontWeight: 400, color: "#9ca3af" }}> ({fmt(t.f, t.base)})</span>
                </div>
              )}
            </div>
          );
        })}
        {stockTiles.map(t => {
          const c = t.h?.c || C.muted;
          return (
            <div key={t.key} style={{ background: "#fff", border: `1px solid ${c.bdr}`, borderLeft: `5px solid ${c.fg}`, borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t.label}</span>
                {t.h && <Pill c={c}>{t.h.label}</Pill>}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>
                {fmt(t.f, t.actual)}
                {t.valSuffix && <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", marginLeft: 6 }}>{t.valSuffix}</span>}
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>{t.note}</div>
              {t.h && (
                <div style={{ fontSize: 12, fontWeight: 700, marginTop: 6, color: c.fg }}>
                  {t.h.deltaLabel}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 2 · AUGUST TARGET TRACKER — revenue headline + compact KPI table
// ══════════════════════════════════════════════════════════════════════════════
function RevenueBlock({ mtdRev, target, projected, daysDone, daysIn, daysLeft, reqDaily }) {
  const progPct = mtdRev && target ? Math.round(mtdRev / target * 100) : null;
  const projPct = projected && target ? Math.round(projected / target * 100) : null;
  const sc = projPct != null ? scorePct(projPct) : C.muted;
  const gap = target && projected ? Math.max(0, target - projected) : null;
  const dailyAvg = mtdRev && daysDone > 0 ? Math.round(mtdRev / daysDone) : null;
  // TOTAL sales needed per remaining day to land exactly on target (what the
  // store must actually ring up each day — not the lift over current pace).
  const totalDaily = target != null && mtdRev != null && daysLeft > 0
    ? Math.max(0, Math.round((target - mtdRev) / daysLeft))
    : null;

  return (
    <div style={{ background: "#fff", border: `2px solid ${sc.bdr}`, borderRadius: 14, padding: "22px 26px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em" }}>Revenue · August Target</div>
          <div style={{ fontSize: 38, fontWeight: 900, color: "#111827", lineHeight: 1.1, marginTop: 2 }}>{fmtKES(target, false)}</div>
        </div>
        {projPct != null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>Projected Month-End</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: sc.fg }}>{fmtKES(projected)}</div>
            <Pill c={sc}>{projPct}% of target</Pill>
          </div>
        )}
      </div>
      <Bar value={mtdRev || 0} max={target || 1} color={sc.fg} h={14} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280", margin: "6px 0 16px" }}>
        <span>MTD: <strong style={{ color: "#111827" }}>{fmtKES(mtdRev)} ({progPct ?? "—"}%)</strong> · {dailyAvg ? `${fmtKES(dailyAvg)}/day avg` : ""}</span>
        <span>Day {daysDone} of {daysIn}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <div style={{ background: C.blue.bg, border: `1px solid ${C.blue.bdr}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.blue.fg, textTransform: "uppercase" }}>📍 Where we are</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#111827", marginTop: 2 }}>{fmtKES(mtdRev, false)}</div>
        </div>
        <div style={{ background: C.amber.bg, border: `1px solid ${C.amber.bdr}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.amber.fg, textTransform: "uppercase" }}>🎯 Where we need to be</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.amber.fg, marginTop: 2 }}>{fmtKES(target, false)}</div>
        </div>
        <div style={{ background: gap > 0 ? C.bad.bg : C.good.bg, border: `1px solid ${gap > 0 ? C.bad.bdr : C.good.bdr}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: gap > 0 ? C.bad.fg : C.good.fg, textTransform: "uppercase" }}>⚡ What to do</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: gap > 0 ? C.bad.fg : C.good.fg, marginTop: 2 }}>
            {gap > 0 ? `Sell ${fmtKES(totalDaily, false)}/day` : "✓ On track"}
          </div>
          {gap > 0 && (
            <div style={{ fontSize: 11, color: "#374151" }}>
              total per day for the next {daysLeft} days
              {dailyAvg != null && reqDaily != null && (
                <> · currently {fmtKES(dailyAvg)}/day, so <strong>+{fmtKES(reqDaily)}/day more</strong></>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiTargetTable({ rpt }) {
  const { mtd, derived_targets, projected_eom, days_done, days_in_month, days_remaining, target_basis } = rpt || {};
  if (!rpt) return null;

  const rows = KPI_META.filter(m => m.key !== "revenue").map(m => {
    const actual = mtd?.[m.key];
    const tgt    = derived_targets?.[m.key];
    const proj   = projected_eom?.[m.key];
    const projPct = proj != null && tgt ? Math.round(proj / tgt * 100) : null;
    const sc = projPct != null ? scorePct(projPct, m.lowerBetter) : C.muted;

    let dailyAvg = null, needLabel = "—";
    if (m.vol) {
      dailyAvg = actual != null && days_done > 0 ? Math.round(actual / days_done) : null;
      const rem = actual != null && tgt != null ? Math.max(0, tgt - actual) : null;
      if (tgt == null)               needLabel = "no target set";
      else if (rem === 0)            needLabel = "✓ target reached";
      else if (days_remaining <= 0)  needLabel = "month complete";
      else if (rem != null)          needLabel = `${fmtNum(Math.round(rem / days_remaining))}/day for ${days_remaining}d`;
    } else if (tgt == null) {
      needLabel = "no target set";
    } else if (actual != null && tgt != null) {
      const gap = tgt - actual;
      const okDir = m.lowerBetter ? gap >= 0 : gap <= 0;
      needLabel = okDir
        ? "✓ at required level"
        : (m.lowerBetter ? `reduce by ${fmt(m.f, Math.abs(gap))}` : `lift by ${fmt(m.f, Math.abs(gap))}`);
    }
    return { ...m, actual, tgt, proj, projPct, sc, dailyAvg, needLabel, basis: target_basis?.[m.key] };
  });

  const th = { textAlign: "right", padding: "10px 14px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb" };
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 140 }}>KPI</th>
              <th style={{ ...th, background: "#eff6ff", color: C.blue.fg }}>MTD Actual</th>
              <th style={th}>Daily Avg</th>
              <th style={{ ...th, background: "#fffbeb", color: C.amber.fg }}>Month Target</th>
              <th style={th}>Projected</th>
              <th style={{ ...th, background: "#fff1f2", color: C.bad.fg, textAlign: "left", minWidth: 170 }}>⚡ What To Do</th>
              <th style={{ ...th, textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} style={{ borderBottom: "1px solid #f3f4f6", background: i % 2 ? "#fafafa" : "#fff" }}>
                <td style={{ padding: "11px 14px", fontWeight: 700, color: "#111827" }}>
                  {r.label}
                  {r.note && <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>{r.note}</div>}
                </td>
                <td style={{ textAlign: "right", padding: "11px 14px", fontWeight: 800, fontSize: 15, color: C.blue.fg, background: "#f8faff" }}>{fmt(r.f, r.actual)}</td>
                <td style={{ textAlign: "right", padding: "11px 14px", color: "#6b7280" }}>{r.vol ? (r.dailyAvg != null ? `${fmtNum(r.dailyAvg)}/day` : "—") : "n/a"}</td>
                <td style={{ textAlign: "right", padding: "11px 14px", fontWeight: 800, fontSize: 15, color: C.amber.fg, background: "#fffef5" }} title={r.basis || ""}>{fmt(r.f, r.tgt)}</td>
                <td style={{ textAlign: "right", padding: "11px 14px", color: "#374151" }}>{fmt(r.f, r.proj)}</td>
                <td style={{ padding: "11px 14px", fontWeight: 700, fontSize: 13, color: r.needLabel.startsWith("✓") ? C.good.fg : C.bad.fg }}>{r.needLabel}</td>
                <td style={{ textAlign: "center", padding: "11px 14px" }}>{r.projPct != null ? <Pill c={r.sc}>{r.projPct}%</Pill> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 3 · PRODUCT PROFILE — category mix + embedded targets
// ══════════════════════════════════════════════════════════════════════════════
function CategoryTargets({ store, rpt }) {
  const [selCat, setSelCat] = useState("");

  const targetUnits = rpt?.derived_targets?.units;
  const daysIn      = rpt?.days_in_month  || 31;
  const daysLeft    = rpt?.days_remaining || 28;
  const daysDone    = rpt?.days_done      || 0;

  const curMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  const { data: mtdMix, isLoading: loadMtd } = useApi(
    "store-profile/category-mix",
    { store, month: curMonth, ...(selCat ? { category: selCat } : {}) },
    { enabled: !!store }
  );
  const { data: baseMix, isLoading: loadBase } = useApi(
    "store-profile/category-mix", { store }, { enabled: !!store }
  );

  const totalBase = baseMix?.total_units || 0;
  const toTgt = (baseUnits) => (!targetUnits || !totalBase || !baseUnits) ? null : Math.round(targetUnits * (baseUnits / totalBase));

  const rows = useMemo(() => {
    if (!mtdMix) return [];
    const baseCats = baseMix?.categories || [];
    const enrich = (list, keyField, baseList, baseDen, mtdDen) => (list || []).map((row, ci) => {
      const name = row[keyField];
      const bc = (baseList || []).find(c => c[keyField] === name);
      const tgt = toTgt(bc?.units);
      const rem = tgt != null && row.units != null ? Math.max(0, tgt - row.units) : null;
      const da  = daysDone > 0 && row.units != null ? +(row.units / daysDone).toFixed(1) : null;
      const dn  = daysLeft > 0 && rem != null ? +(rem / daysLeft).toFixed(1) : null;
      // Same-scope denominators: store-level for categories, category-level for sub-categories
      const basePct = baseDen && bc?.units ? bc.units / baseDen * 100 : null;
      const mtdPct  = mtdDen && row.units ? row.units / mtdDen * 100 : null;
      const mixShift = basePct != null && mtdPct != null ? mtdPct - basePct : null;
      const soh = row.soh ?? null;
      // Days of stock at the pace the target demands (fall back to actual pace)
      const rate = (dn != null && dn > 0) ? dn : (da != null && da > 0 ? da : null);
      const coverDays = soh != null && rate ? Math.round(soh / rate) : null;
      const stockShort = soh != null && rem != null && rem > 0 && soh < rem;
      return {
        ...row, name, tgt, rem, dailyActual: da, dailyNeeded: dn,
        soh, coverDays, stockShort,
        dailyGap: dn != null && da != null ? dn - da : null,
        basePct, mtdPct, mixShift,
        baseAsp: bc?.asp,
        color: BAR_COLORS[ci % BAR_COLORS.length],
        hasSubs: !!(row.subcategories || []).length,
      };
    });
    if (!selCat) return enrich(mtdMix.categories || [], "category", baseCats, totalBase, mtdMix.total_units);
    const cat = (mtdMix.categories || []).find(c => c.category === selCat);
    const bc  = baseCats.find(c => c.category === selCat);
    return enrich(cat?.subcategories || [], "subcategory", bc?.subcategories || [], bc?.units, cat?.units);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtdMix, baseMix, selCat, targetUnits, totalBase, daysLeft, daysDone]);

  const loading = loadMtd || loadBase;
  const th = { padding: "10px 14px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb" };

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#374151" }}>
            {selCat ? `${selCat} → sub-categories` : "All categories"} · how each one is tracking against its August share of the store target
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
            Each row: how much is sold vs the month's goal, whether today's selling speed is enough, and if there's stock to get there.
          </div>
        </div>
        {selCat && (
          <button onClick={() => setSelCat("")}
            style={{ background: "none", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#374151" }}>
            ← All categories
          </button>
        )}
      </div>
      {loading && <div style={{ padding: 20 }}><Skeleton rows={6} /></div>}
      {!loading && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left", minWidth: 170 }}>{selCat ? "Sub-Category" : "Category"}</th>
                <th style={{ ...th, textAlign: "left", minWidth: 190 }} title="Units sold so far this month vs the full-month goal for this line">Month progress (units)</th>
                <th style={{ ...th, textAlign: "left", minWidth: 210 }} title="Selling speed today vs the speed needed for the rest of the month to still hit the goal">Selling fast enough?</th>
                <th style={{ ...th, textAlign: "right" }} title="Units in stock here now, and roughly how many days they last at the needed selling speed">Stock</th>
                <th style={{ ...th, textAlign: "right" }} title="This line's share of the store's sales this month vs its usual share over the last 6 months">Share of sales</th>
                <th style={{ ...th, textAlign: "right" }} title="Average selling price per unit this month">Avg price</th>
                <th style={{ ...th, textAlign: "right" }}>Revenue MTD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const onTrack = row.dailyGap != null ? row.dailyGap <= 0 : null;
                const bg = idx % 2 ? "#fafafa" : "#fff";
                const progPct = row.tgt && row.units != null ? Math.round(row.units / row.tgt * 100) : null;
                const aspDelta = row.asp != null && row.baseAsp ? (row.asp - row.baseAsp) / row.baseAsp * 100 : null;
                return (
                  <tr key={row.name} style={{ borderBottom: "1px solid #f3f4f6", background: bg, cursor: !selCat && row.hasSubs ? "pointer" : "default" }}
                      onClick={() => !selCat && row.hasSubs && setSelCat(row.name)}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f0f4ff")}
                      onMouseLeave={e => (e.currentTarget.style.background = bg)}>
                    <td style={{ padding: "12px 14px", fontWeight: 700, color: "#111827" }}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: row.color, marginRight: 9, verticalAlign: "middle" }} />
                      {row.name}
                      {!selCat && row.hasSubs && <span style={{ fontSize: 10, color: "#6366f1", marginLeft: 7 }}>↵ drill</span>}
                    </td>
                    {/* Month progress: sold X of Y with a bar */}
                    <td style={{ padding: "12px 14px" }}>
                      {row.tgt != null ? (
                        <>
                          <div style={{ fontSize: 13, marginBottom: 4 }}>
                            <strong style={{ fontSize: 15, color: "#111827" }}>{fmtNum(row.units)}</strong>
                            <span style={{ color: "#6b7280" }}> of {fmtNum(row.tgt)} sold</span>
                            <span style={{ fontWeight: 700, color: progPct >= Math.round(daysDone / daysIn * 100) ? C.good.fg : C.amber.fg, marginLeft: 6 }}>{progPct}%</span>
                          </div>
                          <div style={{ position: "relative", height: 7, background: "#e5e7eb", borderRadius: 4, maxWidth: 170 }}>
                            <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, progPct)}%`, background: progPct >= Math.round(daysDone / daysIn * 100) ? C.good.fg : C.amber.fg, borderRadius: 4 }} />
                            {/* marker: where progress SHOULD be by today */}
                            <div style={{ position: "absolute", top: -2, bottom: -2, left: `${Math.round(daysDone / daysIn * 100)}%`, width: 2, background: "#6b7280" }}
                                 title={`Should be at ~${Math.round(daysDone / daysIn * 100)}% by day ${daysDone}`} />
                          </div>
                          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>│ = where it should be by today</div>
                        </>
                      ) : (
                        <span style={{ fontSize: 13, color: "#6b7280" }}><strong style={{ color: "#111827" }}>{fmtNum(row.units)}</strong> sold · no target</span>
                      )}
                    </td>
                    {/* Selling fast enough? one verdict + the two speeds */}
                    <td style={{ padding: "12px 14px" }}>
                      {row.rem === 0 && row.tgt != null ? <Pill c={C.good}>✓ Target hit</Pill>
                      : row.dailyNeeded != null && row.dailyActual != null ? (
                        <>
                          <Pill c={onTrack ? C.good : C.bad}>{onTrack ? "✓ On track" : "Behind"}</Pill>
                          <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>
                            Selling <strong>{row.dailyActual}/day</strong> · needs <strong>{row.dailyNeeded}/day</strong>
                            {!onTrack && <span style={{ color: C.bad.fg }}> → sell {row.dailyGap.toFixed(1)} more per day</span>}
                          </div>
                        </>
                      ) : <span style={{ color: "#9ca3af" }}>—</span>}
                      {row.stockShort && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.amber.fg, marginTop: 3 }}>
                          ⚠ not enough stock to hit the goal — {fmtNum(row.soh)} left, {fmtNum(row.rem)} still to sell
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 13 }}>
                      {row.soh != null ? (
                        <>
                          <div style={{ fontWeight: 700, color: row.stockShort ? C.amber.fg : "#374151" }}>{fmtNum(row.soh)} units</div>
                          {row.coverDays != null && (
                            <div style={{ fontSize: 10, color: row.coverDays < daysLeft ? C.amber.fg : "#9ca3af" }}>
                              lasts ~{row.coverDays} days{row.coverDays < daysLeft ? ` — runs out before month-end` : ""}
                            </div>
                          )}
                        </>
                      ) : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 13 }}>
                      {row.mixShift != null && row.mtdPct != null ? (
                        <>
                          <div style={{ fontWeight: 700, color: "#374151" }}>{row.mtdPct.toFixed(0)}%</div>
                          <div style={{ fontSize: 10, color: Math.abs(row.mixShift) < 1.5 ? "#9ca3af" : row.mixShift > 0 ? C.good.fg : C.bad.fg }}>
                            usually {row.basePct.toFixed(0)}% {Math.abs(row.mixShift) < 1.5 ? "· steady" : row.mixShift > 0 ? "· gaining" : "· losing ground"}
                          </div>
                        </>
                      ) : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 14, fontWeight: 600, color: "#374151" }}>
                      {row.asp == null ? "—" : `KES ${Number(row.asp).toLocaleString(undefined, {maximumFractionDigits: 0})}`}
                      {aspDelta != null && Math.abs(aspDelta) >= 3 && (
                        <div style={{ fontSize: 10, color: aspDelta > 0 ? C.good.fg : C.bad.fg }}>{aspDelta > 0 ? "▲" : "▼"}{Math.abs(aspDelta).toFixed(0)}% vs norm</div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 14, color: "#374151" }}>{fmtKES(row.revenue)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: "center", padding: 36, color: "#9ca3af" }}>No category data for August yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 4 · TREND PROFILE — 6-month table with sparklines
// ══════════════════════════════════════════════════════════════════════════════
function TrendProfile({ trendData, loading }) {
  const months = trendData?.months || [];
  const th = { textAlign: "right", padding: "9px 12px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb" };
  if (loading) return <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 }}><Skeleton rows={8} /></div>;
  if (!months.length) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 130 }}>KPI</th>
              {months.map(m => <th key={m.month} style={th}>{m.label}</th>)}
              <th style={{ ...th, background: "#f3f4f6" }}>6M Avg</th>
              <th style={{ ...th, textAlign: "center" }}>Trend</th>
            </tr>
          </thead>
          <tbody>
            {KPI_META.map(({ key, label, f, note }, ri) => {
              const vals = months.map(m => m[key]);
              const valid = vals.filter(v => v != null);
              const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
              return (
                <tr key={key} style={{ borderBottom: "1px solid #f3f4f6", background: ri % 2 ? "#fafafa" : "#fff" }}>
                  <td style={{ padding: "9px 12px", fontWeight: 700, color: "#374151" }}>
                    {label}
                    {note && <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>{note}</div>}
                  </td>
                  {vals.map((v, i) => {
                    const prev = vals[i - 1];
                    const chg = v != null && prev != null && prev !== 0 ? (v - prev) / Math.abs(prev) * 100 : null;
                    return (
                      <td key={i} style={{ textAlign: "right", padding: "9px 12px", color: "#6b7280" }}>
                        {fmt(f, v)}
                        {chg != null && Math.abs(chg) >= 2 && (
                          <div style={{ fontSize: 10, color: chg >= 0 ? "#16a34a" : "#dc2626" }}>{chg >= 0 ? "▲" : "▼"}{Math.abs(chg).toFixed(0)}%</div>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: "right", padding: "9px 12px", fontWeight: 700, color: "#374151", background: "#f3f4f6" }}>{fmt(f, avg)}</td>
                  <td style={{ padding: "9px 12px", textAlign: "center" }}><Sparkline values={vals} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 5 · ACTION PLAN
// ══════════════════════════════════════════════════════════════════════════════
const P_STYLE = {
  critical: { ...C.crit, icon: "🚨" },
  high:     { ...C.bad,  icon: "⚠️" },
  medium:   { ...C.warn, icon: "●" },
  good:     { ...C.good, icon: "✓" },
  info:     { ...C.muted, icon: "ℹ" },
};
function ActionPlan({ actions }) {
  if (!actions?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {actions.map((a, i) => {
        const p = P_STYLE[a.priority] || P_STYLE.info;
        return (
          <div key={i} style={{ border: `1px solid ${p.bdr}`, background: p.bg, borderRadius: 10, padding: "13px 17px", display: "flex", gap: 13, alignItems: "flex-start" }}>
            <div style={{ fontSize: 19, flexShrink: 0, lineHeight: 1, marginTop: 2 }}>{p.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: p.fg }}>
                {a.title}
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: p.fg, color: "#fff", borderRadius: 3, padding: "1px 6px", textTransform: "uppercase" }}>{a.priority}</span>
              </div>
              <div style={{ fontSize: 13, color: "#374151", marginTop: 4, lineHeight: 1.65 }}>{a.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// WEEKEND vs WEEKDAY — which metrics behave differently on weekends
// ══════════════════════════════════════════════════════════════════════════════
const WKND_META = [
  { key: "revenue_day",  label: "Revenue / day",      f: "kes" },
  { key: "txns_day",     label: "Transactions / day", f: "num" },
  { key: "units_day",    label: "Items sold / day",   f: "num" },
  { key: "footfall_day", label: "Footfall / day",     f: "num" },
  { key: "conversion",   label: "Conversion",         f: "pct" },
  { key: "abv",          label: "Basket value (ABV)", f: "kes_whole" },
  { key: "asp",          label: "Item price (ASP)",   f: "kes_whole" },
];
const wkndFmt = (f, v) => v == null ? "—" : f === "kes" ? fmtKES(v) : f === "kes_whole" ? `KES ${Number(v).toLocaleString(undefined, {maximumFractionDigits: 0})}` : f === "pct" ? `${v}%` : fmtNum(v);

function WeekendProfile({ store }) {
  const { data, isLoading } = useApi("store-profile/weekday-weekend", { store }, { enabled: !!store, staleTime: 10 * 60_000 });
  if (isLoading) return <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 }}><Skeleton rows={4} /></div>;
  if (!data) return null;
  const { weekday, weekend, deltas_pct: d } = data;

  // Rank metrics by how differently they behave on weekends
  const ranked = WKND_META.filter(m => d?.[m.key] != null).sort((a, b) => Math.abs(d[b.key]) - Math.abs(d[a.key]));
  const top = ranked[0];
  const takeaway = top
    ? (d[top.key] > 0
        ? `Weekends run on ${top.label.toLowerCase()} — it's ${Math.abs(d[top.key]).toFixed(0)}% higher than a weekday. Protect it: staffing, stock and displays should peak Sat–Sun.`
        : `${top.label} drops ${Math.abs(d[top.key]).toFixed(0)}% on weekends — that's the weekend leak to fix first.`)
    : null;

  const th = { padding: "10px 14px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb", textAlign: "right" };
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 12, color: "#6b7280" }}>
        Average per day over the last 8 full weeks ({data.window?.from} → {data.window?.to}) · weekend = Sat & Sun
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 160 }}>Metric</th>
              <th style={th}>Weekday avg</th>
              <th style={{ ...th, background: "#eff6ff", color: C.blue.fg }}>Weekend avg</th>
              <th style={th}>Weekend vs Weekday</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((m, i) => {
              const dv = d[m.key];
              const big = Math.abs(dv) >= 10;
              return (
                <tr key={m.key} style={{ borderBottom: "1px solid #f3f4f6", background: i % 2 ? "#fafafa" : "#fff" }}>
                  <td style={{ padding: "11px 14px", fontWeight: 700, color: "#111827" }}>{m.label}</td>
                  <td style={{ textAlign: "right", padding: "11px 14px", color: "#374151" }}>{wkndFmt(m.f, weekday?.[m.key])}</td>
                  <td style={{ textAlign: "right", padding: "11px 14px", fontWeight: 800, color: C.blue.fg, background: "#f8faff" }}>{wkndFmt(m.f, weekend?.[m.key])}</td>
                  <td style={{ textAlign: "right", padding: "11px 14px" }}>
                    <span style={{ fontWeight: big ? 800 : 600, color: Math.abs(dv) < 3 ? "#6b7280" : dv > 0 ? C.good.fg : C.bad.fg }}>
                      {dv > 0 ? "▲" : "▼"} {Math.abs(dv).toFixed(0)}%
                    </span>
                  </td>
                </tr>
              );
            })}
            {ranked.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", padding: 30, color: "#9ca3af" }}>Not enough recent data to compare</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {takeaway && (
        <div style={{ padding: "12px 20px", borderTop: "1px solid #f3f4f6", background: "#f0f9ff", fontSize: 13, color: "#0c4a6e", fontWeight: 600 }}>
          💡 {takeaway}
        </div>
      )}
      <WeekendCategories cats={data.categories} />
    </div>
  );
}

// What sells on weekends — top categories by weekend-vs-weekday shift
function WeekendCategories({ cats }) {
  if (!cats || cats.length === 0) return null;
  const overIdx  = cats.filter(c => (c.delta_pct ?? 0) > 0);
  const underIdx = cats.filter(c => (c.delta_pct ?? 0) <= 0);
  const th = { padding: "9px 14px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb", textAlign: "right" };
  const top = overIdx[0];
  return (
    <div style={{ borderTop: "1px solid #e5e7eb" }}>
      <div style={{ padding: "12px 20px 4px", fontSize: 14, fontWeight: 800, color: "#111827" }}>
        What sells on weekends
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: "#6b7280" }}>
          revenue per day, weekend vs weekday — biggest shifts first
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 140 }}>Category</th>
              <th style={th}>Weekday rev/day</th>
              <th style={{ ...th, background: "#eff6ff", color: C.blue.fg }}>Weekend rev/day</th>
              <th style={th}>Weekend units/day</th>
              <th style={th}>Weekend share</th>
              <th style={th}>Weekend vs Weekday</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c, i) => {
              const dv = c.delta_pct;
              const shareShift = (c.weekend_share_pct != null && c.weekday_share_pct != null)
                ? Math.round((c.weekend_share_pct - c.weekday_share_pct) * 10) / 10 : null;
              return (
                <tr key={c.category} style={{ borderBottom: "1px solid #f3f4f6", background: i % 2 ? "#fafafa" : "#fff" }}>
                  <td style={{ padding: "9px 14px", fontWeight: 700, color: "#111827" }}>{c.category}</td>
                  <td style={{ textAlign: "right", padding: "9px 14px", color: "#374151" }}>{fmtKES(c.weekday_rev_day)}</td>
                  <td style={{ textAlign: "right", padding: "9px 14px", fontWeight: 800, color: C.blue.fg, background: "#f8faff" }}>{fmtKES(c.weekend_rev_day)}</td>
                  <td style={{ textAlign: "right", padding: "9px 14px", color: "#374151" }}>{fmtNum(c.weekend_units_day)}</td>
                  <td style={{ textAlign: "right", padding: "9px 14px", color: "#374151" }}>
                    {c.weekend_share_pct != null ? `${c.weekend_share_pct}%` : "—"}
                    {shareShift != null && Math.abs(shareShift) >= 0.5 && (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: shareShift > 0 ? C.good.fg : C.bad.fg }}>
                        ({shareShift > 0 ? "+" : ""}{shareShift}pt)
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right", padding: "9px 14px" }}>
                    {dv == null ? <span style={{ color: "#9ca3af" }}>—</span> : (
                      <span style={{ fontWeight: Math.abs(dv) >= 15 ? 800 : 600, color: Math.abs(dv) < 3 ? "#6b7280" : dv > 0 ? C.good.fg : C.bad.fg }}>
                        {dv > 0 ? "▲" : "▼"} {Math.abs(dv).toFixed(0)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(top || underIdx[0]) && (
        <div style={{ padding: "10px 20px", borderTop: "1px solid #f3f4f6", background: "#f0f9ff", fontSize: 13, color: "#0c4a6e", fontWeight: 600 }}>
          💡 {top
            ? `${top.category} over-indexes most on weekends (+${Math.abs(top.delta_pct).toFixed(0)}% rev/day) — lead Sat–Sun displays and stock with it.`
            : `No category over-indexes on weekends — ${underIdx[0].category} drops the most (${underIdx[0].delta_pct}%).`}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE — the Store Profile
// ══════════════════════════════════════════════════════════════════════════════
export default function StoreProfiling() {
  const LS_KEY = "vivo_store_profile_last_store";

  const { data: locsData, isLoading: locsLoading } = useApi("store-profile/locations");
  const stores = locsData?.stores || [];

  const [selectedStores, setSelectedStores] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (!saved) return null;
      if (saved.trim().startsWith("[")) {
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? parsed : null;
      }
      if ((saved || "").trim().toLowerCase() === "all stores") return [];
      return saved.split(",").map((s) => s.trim()).filter(Boolean);
    } catch { return null; }
  });
  useEffect(() => {
    if (selectedStores === null && stores.length) setSelectedStores([stores[0].store]);
  }, [selectedStores, stores]);
  const store = selectedStores === null
    ? null
    : selectedStores.length === 0
      ? "All Stores"
      : selectedStores.join(",");
  useEffect(() => {
    if (selectedStores !== null) {
      try { localStorage.setItem(LS_KEY, store); } catch {}
    }
  }, [selectedStores, store]);

  const { data: trendData, isLoading: trendLoading } = useApi("store-profile/kpi-trend", { store }, { enabled: !!store });
  const { data: rpt, isLoading: rptLoading, error: rptError } = useApi(
    "store-profile/performance-report", { store }, { enabled: !!store, staleTime: 5 * 60_000 }
  );
  const { data: stockData, isLoading: stockLoading, error: stockError } = useApi(
    "store-profile/stock-diagnosis", { store }, { enabled: !!store, staleTime: 5 * 60_000 }
  );

  const storeCountry = useMemo(
    () => selectedStores?.length === 1 ? stores.find(s => s.store === selectedStores[0])?.country || "" : "",
    [stores, selectedStores]
  );
  const COUNTRY_C = { Kenya: { bg: "#f0fdf4", fg: "#15803d" }, Uganda: { bg: "#fffbeb", fg: "#b45309" }, Rwanda: { bg: "#f0fdfa", fg: "#0f766e" } };
  const cc = COUNTRY_C[storeCountry] || { bg: "#f3f4f6", fg: "#6b7280" };

  const {
    days_done = 0, days_in_month = 31, days_remaining = 28,
    target_revenue, required_daily_revenue,
    mtd, projected_eom, expected_source, actions = [], woc, msi, soh,
  } = rpt || {};

  // Stock health flag
  const stockFlag = woc == null ? null
    : woc < 6  ? { c: C.bad,  label: "Low cover — replenish risk" }
    : woc > 30 ? { c: C.warn, label: "Heavy cover — overstock risk" }
    : { c: C.good, label: "Healthy cover" };

  const handleSelectStore = useCallback((s) => setSelectedStores([s]), []);

  return (
    <div style={{ maxWidth: 1340, margin: "0 auto", padding: "20px 16px" }}>
      {/* ── Network bucket summary ── */}
      <StoreBucketSummary onSelectStore={handleSelectStore} />

      {/* ── Store identity header ── */}
      <div style={{ background: "linear-gradient(135deg, #111827 0%, #1f2937 100%)", borderRadius: 14, padding: "22px 26px", marginBottom: 20, color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.1em", marginBottom: 6 }}>STORE SCORECARD</div>
            <StoreProfileStorePicker
              stores={stores}
              selected={selectedStores}
              onChange={setSelectedStores}
              loading={locsLoading || selectedStores === null}
            />
            <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {storeCountry && <span style={{ padding: "3px 10px", borderRadius: 5, fontSize: 12, fontWeight: 700, background: cc.bg, color: cc.fg }}>{storeCountry}</span>}
              <span style={{ fontSize: 13, color: "#d1d5db" }}>August {new Date().getFullYear()} · Day {days_done} of {days_in_month} · {days_remaining} days left</span>
              {expected_source && <span style={{ fontSize: 12, color: "#9ca3af" }}>Baseline: {expected_source}</span>}
            </div>
          </div>
          {/* Quick facts */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {[
              { label: "Stock on Hand", val: fmtNum(soh), sub: "units" },
              { label: "Weeks of Cover", val: woc != null ? `${woc}w` : "—", sub: stockFlag?.label, subColor: stockFlag?.c?.fg },
              { label: "Months of Stock", val: msi != null ? `${msi}mo` : "—", sub: "MSI" },
              { label: "MTD Revenue", val: fmtKES(mtd?.revenue), sub: `${target_revenue ? Math.round((mtd?.revenue || 0) / target_revenue * 100) : "—"}% of target` },
            ].map(({ label, val, sub, subColor }) => (
              <div key={label} style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "12px 18px", minWidth: 130 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 900, marginTop: 3 }}>{val}</div>
                {sub && <div style={{ fontSize: 11, color: subColor ? "#fbbf24" : "#9ca3af", marginTop: 1 }}>{sub}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {store && (
        <>
          {rptError && <ErrBox msg={rptError?.message} />}
          {rptLoading && <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 24 }}><Skeleton rows={6} /></div>}

          {/* 1 · Top KPIs — Unified Grid */}
          {(rpt || stockData) && <TopKPIs rpt={rpt} stockData={stockData} />}

          {/* 1b · Stock-to-Sales Table */}
          {stockData && (
            <div style={{ marginTop: 28 }}>
              <StockToSalesTable data={stockData} />
            </div>
          )}

          {/* 1c · Priority Focus — impact-ranked levers to hit target */}
          {rpt && (
            <>
              <SectionTitle icon={null} title="Priority Focus"
                subtitle="Ranked by revenue impact — fix the top item first, it recovers the most of the gap to target" />
              <PriorityFocus rpt={rpt} stockData={stockData} />
              <AiDiagnosis store={store} />
              <SectionTitle icon={null} title="How the Metrics Interlink"
                subtitle="One metric leads to a change in the next — the revenue equation this store runs on" />
              <DriverChain rpt={rpt} />
            </>
          )}

          {/* 2 · August Target Tracker */}
          {rpt && (
            <>
              <SectionTitle icon="🎯" title="August Target Tracker"
                subtitle="Where we are · where we need to be · what to do — every KPI against the monthly budget" />
              {!target_revenue && (
                <div style={{ padding: "14px 18px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, marginBottom: 14, fontSize: 14, color: "#92400e" }}>
                  ⚠ No August budget target found for this store — tracking against historical baseline only.
                </div>
              )}
              {target_revenue && (
                <RevenueBlock mtdRev={mtd?.revenue} target={target_revenue} projected={projected_eom?.revenue}
                  daysDone={days_done} daysIn={days_in_month} daysLeft={days_remaining} reqDaily={required_daily_revenue} />
              )}
              <KpiTargetTable rpt={rpt} />
            </>
          )}

          {/* 2b · Weekend vs Weekday */}
          <SectionTitle icon="📅" title="Weekend vs Weekday"
            subtitle="How the last 8 weeks split — which metrics behave differently on weekends, so you know what to keep doing (and what leaks)" />
          <WeekendProfile store={store} />

          {/* 3 · Product Profile */}
          <SectionTitle icon="👗" title="Product Profile"
            subtitle="Category & sub-category performance — MTD progress vs targets, plus mix shifts vs the store's 6-month norm" />
          <CategoryTargets store={store} rpt={rpt} />

          {/* 4 · Priority Actions */}
          {rpt && actions.length > 0 && (
            <>
              <SectionTitle icon="⚡" title="Priority Actions" subtitle="Data-driven steps, ordered by urgency" />
              <ActionPlan actions={actions} />
            </>
          )}

          {/* 5 · Trend Profile */}
          <SectionTitle icon="📈" title="6-Month Trend Profile"
            subtitle="How this store has been performing — the baseline behind the targets" />
          <TrendProfile trendData={trendData} loading={trendLoading} />

          <div style={{ height: 30 }} />
        </>
      )}
    </div>
  );
}
