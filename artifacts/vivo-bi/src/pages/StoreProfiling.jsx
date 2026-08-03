import React, { useState, useEffect, useMemo } from "react";
import { useApi } from "@/lib/useApi";

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmtKES = (v, compact = true) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (!compact) return `KES ${Number(v).toLocaleString()}`;
  if (a >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000)     return `KES ${(v / 1_000).toFixed(0)}k`;
  return `KES ${Number(v).toFixed(0)}`;
};
const fmtNum  = (v) => (v == null ? "—" : Number(v).toLocaleString());
const fmtPct  = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
const fmtAuto = (fmt, v, compact = true) => {
  if (fmt === "kes") return fmtKES(v, compact);
  if (fmt === "pct") return fmtPct(v);
  return fmtNum(v);
};

// ── Colour system ──────────────────────────────────────────────────────────────
const STATUS = {
  good:     { color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  medium:   { color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  high:     { color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  critical: { color: "#7f1d1d", bg: "#fff1f2", border: "#fca5a5" },
  low:      { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
};
const PRIORITY = {
  critical: STATUS.critical,
  high:     STATUS.high,
  medium:   STATUS.medium,
  good:     STATUS.good,
  info:     STATUS.low,
};
const PRIORITY_ICON = { critical: "🚨", high: "⚠️", medium: "●", good: "✓", info: "ℹ" };

function statusFromPct(pct, lowerBetter = false) {
  if (pct == null) return "low";
  const v = lowerBetter ? 200 - pct : pct;
  if (v >= 95) return "good";
  if (v >= 80) return "medium";
  return "high";
}

// ── Shared atoms ───────────────────────────────────────────────────────────────
function Card({ title, subtitle, children, action, accent }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${accent || "#e5e7eb"}`, borderRadius: 10, marginBottom: 20, overflow: "hidden" }}>
      <div style={{
        padding: "14px 20px 12px",
        borderBottom: "1px solid #f3f4f6",
        background: accent ? `${accent}10` : "#fff",
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{subtitle}</div>}
        </div>
        {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      </div>
      <div style={{ padding: "16px 20px" }}>{children}</div>
    </div>
  );
}

function Skeleton({ rows = 5, height = 18 }) {
  return (
    <div style={{ padding: "8px 0" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          height, background: "#f3f4f6", borderRadius: 4,
          marginBottom: 10, width: `${60 + (i % 4) * 10}%`,
          animation: "pulse 1.5s ease-in-out infinite",
        }} />
      ))}
    </div>
  );
}

function ErrorMsg({ msg }) {
  return (
    <div style={{ padding: 14, background: "#fef2f2", borderRadius: 6, color: "#dc2626", fontSize: 13, border: "1px solid #fecaca" }}>
      ⚠ {msg || "Could not load data"}
    </div>
  );
}

function StatusPill({ status, children }) {
  const s = STATUS[status] || STATUS.low;
  return (
    <span style={{
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function MiniBar({ pct, color = "#6366f1", max = 100 }) {
  const w = Math.min((pct ?? 0) / max * 100, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, background: "#f3f4f6", borderRadius: 3, height: 7, maxWidth: 80 }}>
        <div style={{ width: `${w}%`, background: color, height: "100%", borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color: "#374151", minWidth: 40, textAlign: "right" }}>{fmtPct(pct)}</span>
    </div>
  );
}

function Sparkline({ values, small }) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return <span style={{ color: "#d1d5db", fontSize: 10 }}>–</span>;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const w = small ? 48 : 64;
  const h = small ? 18 : 22;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = v == null ? h / 2 : h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const last  = nums[nums.length - 1];
  const first = nums[0];
  const color = last >= first ? "#16a34a" : "#dc2626";
  return (
    <svg width={w} height={h} style={{ overflow: "visible", verticalAlign: "middle", display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={parseFloat(pts.split(" ").pop().split(",")[0])} cy={parseFloat(pts.split(" ").pop().split(",")[1])} r={2.5} fill={color} />
    </svg>
  );
}

function AttainmentBar({ pct, lowerBetter }) {
  if (pct == null) return <span style={{ color: "#9ca3af" }}>—</span>;
  const status = statusFromPct(pct, lowerBetter);
  const s = STATUS[status];
  const w = Math.min(pct, 130);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, background: "#e5e7eb", borderRadius: 3, height: 8, maxWidth: 90, position: "relative", overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(w, 100)}%`,
          background: s.color, height: "100%", borderRadius: 3,
          transition: "width 0.4s ease",
        }} />
        {pct > 100 && (
          <div style={{ position: "absolute", right: 0, top: 0, height: "100%", width: 3, background: "#374151" }} />
        )}
      </div>
      <span style={{ fontWeight: 700, color: s.color, minWidth: 46, fontSize: 12 }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION A — 6-Month Performance Baseline
// ══════════════════════════════════════════════════════════════════════════════

const SECTION_A_KPIS = [
  { key: "units",                  label: "Items Sold",         fmt: "num", note: null },
  { key: "revenue",                label: "Revenue (Net KES)",  fmt: "kes", note: null },
  { key: "contribution",           label: "Contribution",       fmt: "kes", note: "Net revenue proxy (no per-store COGS)" },
  { key: "transactions",           label: "Transactions",       fmt: "num", note: null },
  { key: "abv",                    label: "ABV",                fmt: "kes", note: "Average Basket Value" },
  { key: "asp",                    label: "ASP",                fmt: "kes", note: "Average Selling Price" },
  { key: "footfall",               label: "Footfall",           fmt: "num", note: null },
  { key: "conversion",             label: "Conversion Rate",    fmt: "pct", note: null },
  { key: "new_customer_pct",       label: "% New Customers",    fmt: "pct", note: null },
  { key: "returning_customer_pct", label: "% Returning",        fmt: "pct", note: null },
  { key: "customer_count",         label: "Customer Numbers",   fmt: "num", note: null },
  { key: "discount_rate",          label: "Discount Rate",      fmt: "pct", note: null },
  { key: "return_rate",            label: "Return Rate",        fmt: "pct", note: null },
];

function SectionA({ trendData, loading, error }) {
  if (loading) return <Card title="A — 6-Month Performance Baseline"><Skeleton rows={13} /></Card>;
  if (error)   return <Card title="A — 6-Month Performance Baseline"><ErrorMsg msg={error?.message} /></Card>;
  if (!trendData) return null;

  const months = trendData.months || [];

  // Compute 6-month averages
  const avgOf = (key) => {
    const vals = months.map((m) => m[key]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };

  const TH = ({ children, right }) => (
    <th style={{
      textAlign: right ? "right" : "left",
      padding: "7px 10px", color: "#6b7280", fontWeight: 600, fontSize: 12,
      borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb",
    }}>{children}</th>
  );

  return (
    <Card
      title="A — 6-Month Performance Baseline"
      subtitle={months.length > 0 ? `${months[0].label} → ${months[months.length - 1].label}` : "Last 6 full months"}
      action={
        <div style={{ fontSize: 12, color: "#6b7280", textAlign: "right" }}>
          {trendData.current_woc != null && (
            <div>WOC <strong style={{ color: "#374151" }}>{trendData.current_woc}w</strong>
              {trendData.current_msi != null && <> · MSI <strong style={{ color: "#374151" }}>{trendData.current_msi}mo</strong></>}
              {" · "}SOH <strong style={{ color: "#374151" }}>{fmtNum(trendData.current_soh)}</strong>
            </div>
          )}
        </div>
      }
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <TH>KPI</TH>
              {months.map((m) => <TH key={m.month} right>{m.label}</TH>)}
              <TH right>6M Avg</TH>
              <TH>Trend</TH>
            </tr>
          </thead>
          <tbody>
            {SECTION_A_KPIS.map(({ key, label, fmt, note }) => {
              const vals  = months.map((m) => m[key] ?? m["revenue"]);  // revenue fallback for contribution
              const kVals = months.map((m) => key === "contribution" ? m["revenue"] : m[key]);
              const avg   = key === "contribution" ? avgOf("revenue") : avgOf(key);
              return (
                <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  <td style={{ padding: "7px 10px", color: "#374151", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {label}
                    {note && <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 4 }} title={note}>ⓘ</span>}
                  </td>
                  {kVals.map((v, i) => {
                    const prev = kVals[i - 1];
                    const chg = (v != null && prev != null && prev !== 0) ? ((v - prev) / Math.abs(prev)) * 100 : null;
                    return (
                      <td key={i} style={{ textAlign: "right", padding: "7px 10px", color: chg == null ? "inherit" : chg > 5 ? "#16a34a" : chg < -5 ? "#dc2626" : "#374151" }}>
                        <div>{fmtAuto(fmt, v)}</div>
                        {chg != null && Math.abs(chg) >= 2 && (
                          <div style={{ fontSize: 10, color: chg >= 0 ? "#16a34a" : "#dc2626" }}>
                            {chg >= 0 ? "▲" : "▼"}{Math.abs(chg).toFixed(0)}%
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: "right", padding: "7px 10px", fontWeight: 700, color: "#374151", background: "#f9fafb" }}>
                    {fmtAuto(fmt, avg)}
                  </td>
                  <td style={{ padding: "7px 10px" }}>
                    <Sparkline values={kVals} small />
                  </td>
                </tr>
              );
            })}
            {/* WOC / MSI — current point-in-time */}
            {[
              { label: "WOC (Weeks of Cover)", val: trendData.current_woc, suffix: "w" },
              { label: "MSI (Months of Stock)", val: trendData.current_msi, suffix: "mo" },
            ].map(({ label, val, suffix }) => (
              <tr key={label} style={{ borderBottom: "1px solid #f3f4f6", background: "#fafafa" }}>
                <td style={{ padding: "7px 10px", color: "#6b7280", fontStyle: "italic", fontSize: 11 }}>
                  {label}
                  <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 4 }} title="Point-in-time — no historical inventory snapshots available">ⓘ current only</span>
                </td>
                {months.map((_, i) => (
                  <td key={i} style={{ textAlign: "right", padding: "7px 10px", color: "#9ca3af", fontSize: 11 }}>
                    {i === months.length - 1 && val != null
                      ? <strong style={{ color: "#374151" }}>{val}{suffix}</strong>
                      : "—"}
                  </td>
                ))}
                <td style={{ textAlign: "right", padding: "7px 10px", fontWeight: 700, color: "#374151", background: "#f9fafb" }}>
                  {val != null ? `${val}${suffix}` : "—"}
                </td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION B — Category & Sub-Category Product Mix
// ══════════════════════════════════════════════════════════════════════════════

const BAR_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6","#f97316","#ef4444","#84cc16"];

function SectionB({ store, trendData }) {
  const [selMonth,    setSelMonth]    = useState("");
  const [selCategory, setSelCategory] = useState("");
  const [selSubcat,   setSelSubcat]   = useState("");

  const monthOpts = useMemo(() => {
    if (!trendData?.months) return [];
    return [{ value: "", label: "Last 6 months" }, ...trendData.months.map((m) => ({ value: m.month, label: m.label }))];
  }, [trendData]);

  const { data: mixData, isLoading, error } = useApi(
    "store-profile/category-mix",
    { store, ...(selMonth ? { month: selMonth } : {}), ...(selCategory ? { category: selCategory } : {}) },
    { enabled: !!store }
  );

  const categories = mixData?.categories || [];

  // Subcategory list for the selected category
  const subcatOpts = useMemo(() => {
    if (!selCategory) return [];
    const cat = categories.find((c) => c.category === selCategory);
    return cat ? cat.subcategories : [];
  }, [selCategory, categories]);

  // Clear sub-cat when category changes
  useEffect(() => { setSelSubcat(""); }, [selCategory]);

  // Rows to display
  const displayRows = useMemo(() => {
    if (!selCategory) {
      // Show all categories
      return categories.map((c, ci) => ({
        name: c.category, units: c.units, revenue: c.revenue,
        asp: c.asp, units_pct: c.units_pct,
        rev_pct: mixData ? Math.round(c.revenue * 1000 / Math.max(mixData.total_revenue, 1)) / 10 : null,
        color: BAR_COLORS[ci % BAR_COLORS.length], isCategory: true,
        subcategories: c.subcategories,
      }));
    }
    const cat = categories.find((c) => c.category === selCategory);
    if (!cat) return [];
    return cat.subcategories.map((s, si) => ({
      name: s.subcategory, units: s.units, revenue: s.revenue,
      asp: s.asp, units_pct: s.units_pct,
      rev_pct: mixData ? Math.round(s.revenue * 1000 / Math.max(mixData.total_revenue, 1)) / 10 : null,
      color: BAR_COLORS[si % BAR_COLORS.length], isCategory: false,
    }));
  }, [categories, selCategory, mixData]);

  // If a sub-category is selected, filter to just that row
  const filteredRows = selSubcat
    ? displayRows.filter((r) => r.name === selSubcat)
    : displayRows;

  const Select = ({ label, value, onChange, options, placeholder }) => (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 3 }}>{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 10px", fontSize: 13, background: "#fff", minWidth: 160 }}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={typeof o === "string" ? o : o.value} value={typeof o === "string" ? o : o.value}>
          {typeof o === "string" ? o : o.label}
        </option>)}
      </select>
    </div>
  );

  return (
    <Card
      title="B — Items Sold & ASP by Category / Sub-Category"
      subtitle="% contribution of units and revenue"
      action={mixData && (
        <div style={{ fontSize: 12, color: "#6b7280", textAlign: "right" }}>
          <div><strong>{fmtNum(mixData.total_units)}</strong> units</div>
          <div><strong>{fmtKES(mixData.total_revenue)}</strong> revenue</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{mixData.period?.label}</div>
        </div>
      )}
    >
      {/* Filter bar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Select label="PERIOD" value={selMonth} onChange={setSelMonth}
          options={monthOpts} placeholder={null} />
        <Select label="CATEGORY" value={selCategory} onChange={setSelCategory}
          options={categories.map((c) => ({ value: c.category, label: c.category }))}
          placeholder="All categories" />
        {selCategory && (
          <Select label="SUB-CATEGORY" value={selSubcat} onChange={setSelSubcat}
            options={subcatOpts.map((s) => ({ value: s.subcategory, label: s.subcategory }))}
            placeholder="All sub-categories" />
        )}
        {(selCategory || selSubcat) && (
          <button onClick={() => { setSelCategory(""); setSelSubcat(""); }}
            style={{ alignSelf: "flex-end", background: "none", border: "1px solid #d1d5db", borderRadius: 6,
                     padding: "6px 12px", cursor: "pointer", fontSize: 12, color: "#6b7280" }}>
            ← Reset
          </button>
        )}
      </div>

      {isLoading && <Skeleton rows={6} />}
      {error && <ErrorMsg msg={error?.message} />}

      {!isLoading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f9fafb" }}>
                {[
                  ["Category / Sub-Category", false],
                  ["Units Sold", true],
                  ["% of Units", false, 130],
                  ["% of Revenue", false, 130],
                  ["ASP", true],
                  ["Revenue", true],
                ].map(([h, right, minW]) => (
                  <th key={h} style={{
                    textAlign: right ? "right" : "left",
                    padding: "7px 10px", color: "#6b7280", fontWeight: 600,
                    borderBottom: "2px solid #e5e7eb", minWidth: minW,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, i) => (
                <React.Fragment key={row.name}>
                  <tr
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      cursor: (!selCategory && row.isCategory) ? "pointer" : "default",
                      background: selCategory === row.name ? "#f0f0ff" : "transparent",
                    }}
                    onClick={() => !selCategory && row.isCategory && setSelCategory(row.name)}
                    onMouseEnter={(e) => !selCategory && row.isCategory && (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={(e) => !selCategory && row.isCategory && (e.currentTarget.style.background = "")}
                  >
                    <td style={{ padding: "9px 10px", fontWeight: row.isCategory ? 700 : 500, color: "#111827" }}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2,
                                     background: row.color, marginRight: 7, verticalAlign: "middle" }} />
                      {row.name}
                      {!selCategory && row.isCategory && (
                        <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 6 }}>↵ drill down</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right", padding: "9px 10px" }}>{fmtNum(row.units)}</td>
                    <td style={{ padding: "9px 10px" }}>
                      <MiniBar pct={row.units_pct} color={row.color} max={selCategory ? 50 : 40} />
                    </td>
                    <td style={{ padding: "9px 10px" }}>
                      <MiniBar pct={row.rev_pct} color={row.color} max={selCategory ? 50 : 40} />
                    </td>
                    <td style={{ textAlign: "right", padding: "9px 10px" }}>{fmtKES(row.asp)}</td>
                    <td style={{ textAlign: "right", padding: "9px 10px" }}>{fmtKES(row.revenue)}</td>
                  </tr>
                </React.Fragment>
              ))}
              {filteredRows.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: "center", padding: 20, color: "#9ca3af" }}>No data for this selection</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Breadcrumb */}
      {selCategory && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280" }}>
          All categories → <strong style={{ color: "#374151" }}>{selCategory}</strong>
          {selSubcat && <> → <strong style={{ color: "#374151" }}>{selSubcat}</strong></>}
        </div>
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION C — Target Performance Report
// ══════════════════════════════════════════════════════════════════════════════

function HeadlineCard({ label, value, subvalue, status, large }) {
  const s = STATUS[status] || STATUS.low;
  return (
    <div style={{
      background: s.bg, border: `1px solid ${s.border}`,
      borderRadius: 8, padding: "14px 18px", flex: 1, minWidth: 160,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: large ? 22 : 18, fontWeight: 800, color: s.color, lineHeight: 1.2 }}>
        {value}
      </div>
      {subvalue && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>{subvalue}</div>}
    </div>
  );
}

const C_KPI_KEYS = [
  { key: "revenue",                label: "Revenue (Net KES)",  fmt: "kes" },
  { key: "units",                  label: "Items Sold",         fmt: "num" },
  { key: "transactions",           label: "Transactions",       fmt: "num" },
  { key: "asp",                    label: "ASP",                fmt: "kes" },
  { key: "abv",                    label: "ABV",                fmt: "kes" },
  { key: "footfall",               label: "Footfall",           fmt: "num" },
  { key: "conversion",             label: "Conversion Rate",    fmt: "pct", lowerBetter: false },
  { key: "customer_count",         label: "Customer Numbers",   fmt: "num" },
  { key: "new_customer_pct",       label: "% New Customers",    fmt: "pct" },
  { key: "returning_customer_pct", label: "% Returning",        fmt: "pct" },
  { key: "discount_rate",          label: "Discount Rate",      fmt: "pct", lowerBetter: true },
  { key: "return_rate",            label: "Return Rate",        fmt: "pct", lowerBetter: true },
];

function SectionC({ store }) {
  const { data: rpt, isLoading, error } = useApi(
    "store-profile/performance-report",
    { store },
    { enabled: !!store, staleTime: 5 * 60_000 }
  );

  const monthLabel = rpt?.month_label || new Date().toLocaleString("default", { month: "long", year: "numeric" });

  if (isLoading) return (
    <Card title={`C — ${monthLabel} Performance Report`}>
      <Skeleton rows={12} height={22} />
    </Card>
  );
  if (error) return (
    <Card title={`C — ${monthLabel} Performance Report`}>
      <ErrorMsg msg={error?.message} />
    </Card>
  );
  if (!rpt) return null;

  const { days_done, days_in_month, days_remaining, target_revenue, revenue_gap,
          required_daily_revenue, proj_revenue_attainment, mtd_revenue_attainment,
          mtd, projected_eom, expected, derived_targets, target_basis = {},
          expected_source, actions = [], kpi_rows = [], woc, msi, soh } = rpt;

  const rev_status = statusFromPct(proj_revenue_attainment);

  return (
    <Card
      title={`C — ${monthLabel} Performance Report`}
      subtitle={`Day ${days_done} of ${days_in_month} · ${days_remaining} days remaining · Expected baseline: ${expected_source}`}
      accent={STATUS[rev_status]?.border}
    >
      {/* ── Headline scorecards ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <HeadlineCard
          label="Budget Target"
          value={target_revenue ? fmtKES(target_revenue, false) : "No target set"}
          subvalue={target_revenue ? `KES ${(target_revenue / days_in_month).toLocaleString(undefined, {maximumFractionDigits: 0})}/day required` : null}
          status="low"
          large
        />
        <HeadlineCard
          label="MTD Actual"
          value={fmtKES(mtd?.revenue, false)}
          subvalue={mtd_revenue_attainment != null ? `${mtd_revenue_attainment}% of prorated target` : null}
          status={statusFromPct(mtd_revenue_attainment)}
          large
        />
        <HeadlineCard
          label="Projected Month-End"
          value={fmtKES(projected_eom?.revenue, false)}
          subvalue={proj_revenue_attainment != null ? `${proj_revenue_attainment}% of target` : null}
          status={rev_status}
          large
        />
        <HeadlineCard
          label={`Expected (${expected_source})`}
          value={fmtKES(expected?.revenue, false)}
          subvalue={expected?.revenue && target_revenue
            ? `${Math.round(expected.revenue / target_revenue * 100)}% of this month's target`
            : null}
          status="low"
        />
        {revenue_gap != null && revenue_gap > 0 && (
          <HeadlineCard
            label="Gap to Target"
            value={`−${fmtKES(revenue_gap, false)}`}
            subvalue={required_daily_revenue
              ? `Need KES ${required_daily_revenue.toLocaleString()}/day for ${days_remaining} days`
              : null}
            status="high"
          />
        )}
      </div>

      {/* ── Inventory snapshot ──────────────────────────────────────────────── */}
      {woc != null && (
        <div style={{
          display: "flex", gap: 20, marginBottom: 20,
          background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 16px",
          fontSize: 12, color: "#374151", flexWrap: "wrap",
        }}>
          <span>📦 Current SOH: <strong>{fmtNum(soh)}</strong> units</span>
          <span>⏱ WOC: <strong>{woc}w</strong></span>
          <span>📅 MSI: <strong>{msi}mo</strong></span>
        </div>
      )}

      {/* ── KPI comparison table ─────────────────────────────────────────────── */}
      <div style={{ overflowX: "auto", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th style={{ textAlign: "left", padding: "8px 10px", color: "#6b7280", fontWeight: 600, fontSize: 11, borderBottom: "2px solid #e5e7eb", minWidth: 160 }}>KPI</th>
              <th style={{ textAlign: "right", padding: "8px 10px", color: "#6b7280", fontWeight: 600, fontSize: 11, borderBottom: "2px solid #e5e7eb", minWidth: 110 }}>Current MTD</th>
              <th style={{ textAlign: "right", padding: "8px 10px", color: "#6b7280", fontWeight: 600, fontSize: 11, borderBottom: "2px solid #e5e7eb", minWidth: 110 }}>Projected EOM</th>
              <th style={{ textAlign: "right", padding: "8px 10px", color: "#6b7280", fontWeight: 600, fontSize: 11, borderBottom: "2px solid #e5e7eb", minWidth: 120 }}>
                {expected_source?.split(" ")[0] === "Aug" ? expected_source : "Baseline"}
              </th>
              <th style={{ textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #e5e7eb", minWidth: 170, background: "#fffbeb" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e" }}>Required to Hit Target</div>
                {target_revenue && (
                  <div style={{ fontSize: 10, color: "#b45309", fontWeight: 400 }}>
                    KES {(target_revenue / 1e6).toFixed(1)}M budget · {days_in_month} days
                  </div>
                )}
              </th>
              <th style={{ textAlign: "left", padding: "8px 10px", color: "#6b7280", fontWeight: 600, fontSize: 11, borderBottom: "2px solid #e5e7eb", minWidth: 140 }}>Proj vs Required</th>
            </tr>
          </thead>
          <tbody>
            {C_KPI_KEYS.map(({ key, label, fmt, lowerBetter }) => {
              const row    = kpi_rows.find((r) => r.key === key) || {};
              const m_val  = mtd?.[key];
              const p_val  = projected_eom?.[key];
              const e_val  = expected?.[key];
              const t_val  = derived_targets?.[key];
              const basis  = target_basis?.[key] || "";
              const p_att  = row.proj_attainment_pct;
              const status = row.status || statusFromPct(p_att, lowerBetter);
              const s      = STATUS[status] || STATUS.low;

              // Volume KPIs get a /day breakdown
              const VOL_KEYS = new Set(["units","transactions","footfall","customer_count"]);
              const perDay = (v) => v != null && VOL_KEYS.has(key)
                ? <div style={{ fontSize: 10, color: "#9ca3af" }}>{fmtNum(Math.round(v / days_in_month))}/day</div>
                : null;

              // vs expected delta on projected
              const vs_exp = (p_val != null && e_val != null && e_val > 0)
                ? Math.round(p_val / e_val * 100) : null;

              // Gap to required (projected vs required)
              const gap_to_req = (p_val != null && t_val != null && t_val > 0 && !lowerBetter)
                ? p_val - t_val : null;

              return (
                <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
                  {/* KPI name */}
                  <td style={{ padding: "9px 10px", fontWeight: 600, color: "#374151" }}>
                    {label}
                    {lowerBetter && <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 4 }}>↓ lower = better</span>}
                  </td>
                  {/* MTD actual */}
                  <td style={{ textAlign: "right", padding: "9px 10px", color: "#374151" }}>
                    {fmtAuto(fmt, m_val)}
                    {perDay(m_val)}
                  </td>
                  {/* Projected EOM */}
                  <td style={{ textAlign: "right", padding: "9px 10px", fontWeight: 700, color: s.color }}>
                    {fmtAuto(fmt, p_val)}
                    {perDay(p_val)}
                    {vs_exp != null && Math.abs(vs_exp - 100) > 5 && (
                      <div style={{ fontSize: 10, fontWeight: 400, color: vs_exp >= 95 ? "#16a34a" : "#dc2626" }}>
                        {vs_exp >= 100 ? "▲" : "▼"}{Math.abs(vs_exp - 100)}% vs baseline
                      </div>
                    )}
                  </td>
                  {/* Expected baseline */}
                  <td style={{ textAlign: "right", padding: "9px 10px", color: "#6b7280" }}>
                    {fmtAuto(fmt, e_val)}
                    {perDay(e_val)}
                  </td>
                  {/* Required to hit target */}
                  <td style={{ padding: "9px 10px", background: "#fffdf5", borderLeft: "2px solid #fde68a" }}>
                    <div style={{ fontWeight: 700, color: t_val != null ? "#92400e" : "#9ca3af", fontSize: 13 }}>
                      {fmtAuto(fmt, t_val)}
                    </div>
                    {perDay(t_val)}
                    {basis && (
                      <div style={{ fontSize: 10, color: "#b45309", marginTop: 2, fontStyle: "italic" }}>
                        {basis}
                      </div>
                    )}
                    {/* Show gap between projected and required */}
                    {gap_to_req != null && t_val != null && (
                      <div style={{ fontSize: 10, marginTop: 2, color: gap_to_req >= 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
                        {gap_to_req >= 0
                          ? `▲ +${fmtAuto(fmt, Math.abs(gap_to_req))} ahead`
                          : `▼ ${fmtAuto(fmt, Math.abs(gap_to_req))} short`}
                      </div>
                    )}
                  </td>
                  {/* Attainment bar */}
                  <td style={{ padding: "9px 10px" }}>
                    <AttainmentBar pct={p_att} lowerBetter={lowerBetter} />
                  </td>
                </tr>
              );
            })}
            {/* WOC/MSI rows at bottom */}
            {[
              { label: "WOC (Weeks of Cover)", val: woc != null ? `${woc}w` : null },
              { label: "MSI (Months of Stock)", val: msi != null ? `${msi}mo` : null },
            ].map(({ label, val }) => (
              <tr key={label} style={{ borderBottom: "1px solid #f3f4f6", background: "#fafafa" }}>
                <td style={{ padding: "8px 10px", fontWeight: 600, color: "#374151" }}>
                  {label}
                  <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 4 }}>current only</span>
                </td>
                <td style={{ textAlign: "right", padding: "8px 10px", color: "#374151" }}>
                  {val || "—"}
                </td>
                {[1, 2, 3, 4].map((i) => <td key={i} style={{ textAlign: "right", padding: "8px 10px", color: "#9ca3af" }}>—</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Action Plan ──────────────────────────────────────────────────────── */}
      {actions.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 12, borderTop: "2px solid #e5e7eb", paddingTop: 16 }}>
            Action Plan — What to do to reach target
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {actions.map((action, i) => {
              const p = PRIORITY[action.priority] || PRIORITY.info;
              const icon = PRIORITY_ICON[action.priority] || "ℹ";
              return (
                <div key={i} style={{
                  border: `1px solid ${p.border}`,
                  background: p.bg,
                  borderRadius: 8,
                  padding: "12px 16px",
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}>
                  <div style={{ fontSize: 16, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: p.color, marginBottom: 4 }}>
                      {action.title}
                      <span style={{
                        marginLeft: 8, fontSize: 10, fontWeight: 600,
                        background: p.color, color: "#fff",
                        borderRadius: 3, padding: "1px 6px", textTransform: "uppercase",
                      }}>{action.priority}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.6 }}>
                      {action.detail}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!target_revenue && (
        <div style={{ marginTop: 16, padding: 14, background: "#f9fafb", borderRadius: 8, fontSize: 13, color: "#6b7280", border: "1px solid #e5e7eb" }}>
          No budget target found for this store in {monthLabel}. Performance shown against historical baseline only.
        </div>
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function StoreProfiling() {
  const LS_KEY = "vivo_store_profile_last_store";

  const { data: locsData, isLoading: locsLoading } = useApi("store-profile/locations");
  const stores = locsData?.stores || [];

  const [store, setStore] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || null; } catch { return null; }
  });

  useEffect(() => {
    if (!store && stores.length > 0) setStore(stores[0].store);
  }, [store, stores]);

  useEffect(() => {
    if (store) { try { localStorage.setItem(LS_KEY, store); } catch {} }
  }, [store]);

  const { data: trendData, isLoading: trendLoading, error: trendError } = useApi(
    "store-profile/kpi-trend",
    { store },
    { enabled: !!store }
  );

  const storeCountry = useMemo(
    () => stores.find((s) => s.store === store)?.country || "",
    [stores, store]
  );

  const COUNTRY_STYLE = {
    Kenya:  { bg: "#f0fdf4", color: "#15803d" },
    Uganda: { bg: "#fffbeb", color: "#b45309" },
    Rwanda: { bg: "#f0fdfa", color: "#0f766e" },
  };
  const cs = COUNTRY_STYLE[storeCountry] || { bg: "#f3f4f6", color: "#6b7280" };

  return (
    <div style={{ maxWidth: 1260, margin: "0 auto", padding: "20px 16px" }}>
      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111827", margin: 0, letterSpacing: "-0.02em" }}>
          Store Performance Report
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Head of Retail · Single-store deep-dive: 6-month baseline, product mix, and {new Date().toLocaleString("default", { month: "long", year: "numeric" })} target tracking
        </p>
      </div>

      {/* ── Store selector ───────────────────────────────────────────────────── */}
      <div style={{
        background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
        padding: "14px 20px", marginBottom: 24,
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", marginBottom: 4 }}>
            STORE
          </div>
          {locsLoading ? (
            <div style={{ width: 220, height: 36, background: "#f3f4f6", borderRadius: 6 }} />
          ) : (
            <select
              value={store || ""}
              onChange={(e) => setStore(e.target.value)}
              style={{
                border: "2px solid #d1d5db", borderRadius: 8, padding: "7px 32px 7px 12px",
                fontSize: 15, fontWeight: 700, color: "#111827", minWidth: 220,
                background: "#fff", cursor: "pointer",
              }}
            >
              {stores.map((s) => <option key={s.store} value={s.store}>{s.store}</option>)}
            </select>
          )}
        </div>

        {storeCountry && (
          <div style={{ padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 700, background: cs.bg, color: cs.color }}>
            {storeCountry}
          </div>
        )}

        <div style={{ marginLeft: "auto", fontSize: 12, color: "#9ca3af" }}>
          {stores.length} stores available · Select one to view full report
        </div>
      </div>

      {store && (
        <>
          <SectionA trendData={trendData} loading={trendLoading} error={trendError} />
          <SectionB store={store} trendData={trendData} />
          <SectionC store={store} />
        </>
      )}
    </div>
  );
}
