import React, { useState, useEffect, useMemo } from "react";
import { useApi } from "@/lib/useApi";

// ── Formatters ────────────────────────────────────────────────────────────────

const KES = (v, compact = true) => {
  if (v == null) return "—";
  if (!compact) return `KES ${Number(v).toLocaleString()}`;
  const a = Math.abs(v);
  if (a >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000)     return `KES ${(v / 1_000).toFixed(0)}k`;
  return `KES ${Number(v).toFixed(0)}`;
};
const NUM  = (v) => (v == null ? "—" : Number(v).toLocaleString());
const PCT  = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
const DELTA = (v) => {
  if (v == null) return null;
  const color = v >= 0 ? "#16a34a" : "#dc2626";
  const arrow = v >= 0 ? "▲" : "▼";
  return <span style={{ color, fontSize: 11, fontWeight: 600 }}>{arrow} {Math.abs(v).toFixed(1)}%</span>;
};

// ── Color helpers ─────────────────────────────────────────────────────────────

const STATUS_COLOR = { good: "#16a34a", medium: "#d97706", high: "#dc2626", low: "#6b7280" };
const STATUS_BG    = { good: "#f0fdf4", medium: "#fffbeb", high: "#fef2f2", low: "#f9fafb" };

function targetStatus(pct) {
  if (pct == null) return "low";
  if (pct >= 95)  return "good";
  if (pct >= 80)  return "medium";
  return "high";
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

function Pill({ sev, children }) {
  return (
    <span style={{
      background: STATUS_BG[sev]  || "#f9fafb",
      color:      STATUS_COLOR[sev] || "#6b7280",
      border:     `1px solid ${STATUS_COLOR[sev] || "#d1d5db"}`,
      borderRadius: 4, padding: "2px 8px",
      fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function Card({ title, children, action }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 20 }}>
      <div style={{ padding: "14px 18px 10px", borderBottom: "1px solid #f3f4f6",
                    display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{title}</span>
        {action}
      </div>
      <div style={{ padding: "14px 18px" }}>{children}</div>
    </div>
  );
}

function Skeleton({ rows = 4 }) {
  return (
    <div style={{ padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          height: 18, background: "#f3f4f6", borderRadius: 4,
          marginBottom: 10, width: `${70 + (i % 3) * 10}%%`,
          animation: "pulse 1.5s ease-in-out infinite",
        }} />
      ))}
    </div>
  );
}

function ErrorMsg({ msg }) {
  return <div style={{ padding: 16, color: "#dc2626", fontSize: 13 }}>⚠ {msg}</div>;
}

// ── Section A — Monthly KPI Trend ─────────────────────────────────────────────

const KPI_DEFS = [
  { key: "units",                  label: "Items Sold",         fmt: NUM,   note: null },
  { key: "revenue",                label: "Revenue (Net)",      fmt: KES,   note: null },
  { key: "contribution",           label: "Contribution",       fmt: KES,   note: "Net revenue proxy (no per-store COGS)" },
  { key: "transactions",           label: "Transactions",       fmt: NUM,   note: null },
  { key: "abv",                    label: "ABV",                fmt: KES,   note: "Average Basket Value" },
  { key: "asp",                    label: "ASP",                fmt: KES,   note: "Average Selling Price" },
  { key: "footfall",               label: "Footfall",           fmt: NUM,   note: null },
  { key: "conversion",             label: "Conversion %",       fmt: PCT,   note: null },
  { key: "new_customer_pct",       label: "% New Customers",    fmt: PCT,   note: null },
  { key: "returning_customer_pct", label: "% Returning",        fmt: PCT,   note: null },
  { key: "customer_count",         label: "Customer Numbers",   fmt: NUM,   note: null },
  { key: "discount_rate",          label: "Discount Rate %",    fmt: PCT,   note: null },
  { key: "return_rate",            label: "Return Rate %",      fmt: PCT,   note: null },
];

function MiniSparkline({ values }) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const w = 60, h = 22;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = v == null ? h / 2 : h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const last  = nums[nums.length - 1];
  const first = nums[0];
  const color = last >= first ? "#16a34a" : "#dc2626";
  return (
    <svg width={w} height={h} style={{ overflow: "visible", verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

function SectionA({ store, trendData, loading, error }) {
  if (loading) return <Card title="Section A — Monthly KPI Trend"><Skeleton rows={10} /></Card>;
  if (error)   return <Card title="Section A — Monthly KPI Trend"><ErrorMsg msg={error.message} /></Card>;
  if (!trendData) return null;

  const months = trendData.months || [];
  const colW   = `${100 / (months.length + 2)}%%`;

  return (
    <Card
      title="Section A — Monthly KPI Trend (Last 6 Full Months)"
      action={
        trendData.current_woc != null
          ? <span style={{ fontSize: 12, color: "#6b7280" }}>
              Current WOC: <strong>{trendData.current_woc}w</strong>
              {trendData.current_msi != null && <> · MSI: <strong>{trendData.current_msi}mo</strong></>}
              {" · "}SOH: <strong>{NUM(trendData.current_soh)}</strong> units
            </span>
          : null
      }
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ textAlign: "left", padding: "6px 8px", color: "#6b7280", width: 160, fontWeight: 600 }}>
                KPI
              </th>
              {months.map((m) => (
                <th key={m.month} style={{ textAlign: "right", padding: "6px 8px", color: "#374151", fontWeight: 600, minWidth: 90 }}>
                  {m.label}
                </th>
              ))}
              <th style={{ textAlign: "center", padding: "6px 8px", color: "#6b7280", fontWeight: 600, minWidth: 70 }}>
                Trend
              </th>
            </tr>
          </thead>
          <tbody>
            {KPI_DEFS.map(({ key, label, fmt, note }) => {
              const vals = months.map((m) => m[key]);
              return (
                <tr key={key} style={{ borderBottom: "1px solid #f3f4f6" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <td style={{ padding: "7px 8px", color: "#374151", fontWeight: 500 }}>
                    {label}
                    {note && <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 4 }} title={note}>ⓘ</span>}
                  </td>
                  {vals.map((v, i) => {
                    const prev = i > 0 ? vals[i - 1] : null;
                    const chg  = (v != null && prev != null && prev !== 0)
                      ? ((v - prev) / Math.abs(prev)) * 100
                      : null;
                    const color = chg == null ? "inherit"
                      : chg >= 5 ? "#16a34a" : chg <= -5 ? "#dc2626" : "inherit";
                    return (
                      <td key={i} style={{ textAlign: "right", padding: "7px 8px", color }}>
                        {fmt(v)}
                        {chg != null && Math.abs(chg) >= 2 && (
                          <div style={{ fontSize: 10, color: chg >= 0 ? "#16a34a" : "#dc2626" }}>
                            {chg >= 0 ? "▲" : "▼"}{Math.abs(chg).toFixed(0)}%%
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: "center", padding: "7px 8px" }}>
                    <MiniSparkline values={vals} />
                  </td>
                </tr>
              );
            })}
            {/* WOC / MSI — current only row */}
            <tr style={{ borderBottom: "1px solid #f3f4f6", background: "#fafafa" }}>
              <td style={{ padding: "7px 8px", color: "#374151", fontWeight: 500 }}>
                WOC / MSI
                <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 4 }} title="Weeks of Cover / Months of Supply — current stock only, no historical snapshots">ⓘ</span>
              </td>
              {months.map((m, i) => (
                <td key={i} style={{ textAlign: "right", padding: "7px 8px", color: "#9ca3af", fontSize: 11 }}>
                  {i === months.length - 1
                    ? (trendData.current_woc != null
                        ? <strong style={{ color: "#374151" }}>{trendData.current_woc}w / {trendData.current_msi ?? "—"}mo</strong>
                        : "—")
                    : "—"}
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Section B — Category / Sub-Category Mix ───────────────────────────────────

const ALL_MONTHS_OPT = { value: "", label: "Last 6 months" };

function MiniBar({ pct, color = "#6366f1" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, background: "#f3f4f6", borderRadius: 3, height: 8, maxWidth: 80 }}>
        <div style={{ width: `${Math.min(pct ?? 0, 100)}%%`, background: color, height: "100%%", borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color: "#374151", minWidth: 38, textAlign: "right" }}>{PCT(pct)}</span>
    </div>
  );
}

function SectionB({ store, trendData }) {
  const [selMonth, setSelMonth]     = useState("");
  const [selCategory, setSelCategory] = useState("");

  const monthOpts = useMemo(() => {
    if (!trendData?.months) return [];
    return [ALL_MONTHS_OPT, ...trendData.months.map((m) => ({ value: m.month, label: m.label }))];
  }, [trendData]);

  const { data: mixData, isLoading, error } = useApi(
    "/api/store-profile/category-mix",
    { store, ...(selMonth ? { month: selMonth } : {}), ...(selCategory ? { category: selCategory } : {}) },
    { enabled: !!store }
  );

  const categories = mixData?.categories || [];
  const catNames   = useMemo(() => categories.map((c) => c.category), [categories]);

  // When category selection clears, reset sub-category view
  const selectedCatData = selCategory
    ? categories.find((c) => c.category === selCategory)
    : null;

  const BAR_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6","#f97316"];

  return (
    <Card title="Section B — Items Sold &amp; ASP by Category / Sub-Category">
      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 2 }}>Period</label>
          <select
            value={selMonth}
            onChange={(e) => setSelMonth(e.target.value)}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 10px", fontSize: 13 }}
          >
            {monthOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 2 }}>Category</label>
          <select
            value={selCategory}
            onChange={(e) => { setSelCategory(e.target.value); }}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "5px 10px", fontSize: 13 }}
          >
            <option value="">All categories</option>
            {catNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {mixData && (
          <div style={{ marginLeft: "auto", alignSelf: "flex-end", fontSize: 12, color: "#6b7280" }}>
            {NUM(mixData.total_units)} units · {KES(mixData.total_revenue)}
            <span style={{ marginLeft: 8, opacity: 0.6 }}>{mixData.period?.label}</span>
          </div>
        )}
      </div>

      {isLoading && <Skeleton rows={6} />}
      {error && <ErrorMsg msg={error.message} />}

      {!isLoading && !error && (
        <>
          {/* Category-level table */}
          <table style={{ width: "100%%", borderCollapse: "collapse", fontSize: 12, marginBottom: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb", background: "#f9fafb" }}>
                <th style={{ textAlign: "left",  padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>Category</th>
                <th style={{ textAlign: "right", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>Units</th>
                <th style={{ textAlign: "left",  padding: "6px 8px", color: "#6b7280", fontWeight: 600, minWidth: 140 }}>% of Store</th>
                <th style={{ textAlign: "right", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>ASP</th>
                <th style={{ textAlign: "right", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {(selCategory ? [selectedCatData].filter(Boolean) : categories).map((cat, ci) => (
                <React.Fragment key={cat.category}>
                  <tr
                    style={{
                      borderBottom: "1px solid #f3f4f6",
                      cursor: !selCategory ? "pointer" : "default",
                      background: selCategory === cat.category ? "#f0f0ff" : "transparent",
                    }}
                    onClick={() => !selCategory && setSelCategory(cat.category === selCategory ? "" : cat.category)}
                    onMouseEnter={(e) => !selCategory && (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={(e) => !selCategory && (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "8px 8px", color: "#111827", fontWeight: 600 }}>
                      <span style={{
                        display: "inline-block", width: 10, height: 10, borderRadius: 2,
                        background: BAR_COLORS[ci % BAR_COLORS.length], marginRight: 6,
                      }} />
                      {cat.category}
                      {!selCategory && <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 4 }}>↵ drill down</span>}
                    </td>
                    <td style={{ textAlign: "right", padding: "8px 8px" }}>{NUM(cat.units)}</td>
                    <td style={{ padding: "8px 8px" }}>
                      <MiniBar pct={cat.units_pct} color={BAR_COLORS[ci % BAR_COLORS.length]} />
                    </td>
                    <td style={{ textAlign: "right", padding: "8px 8px" }}>{KES(cat.asp)}</td>
                    <td style={{ textAlign: "right", padding: "8px 8px" }}>{KES(cat.revenue)}</td>
                  </tr>

                  {/* Sub-category rows when a category is selected */}
                  {selCategory === cat.category && cat.subcategories.map((sub) => (
                    <tr key={sub.subcategory} style={{ borderBottom: "1px solid #f9fafb", background: "#fafafe" }}>
                      <td style={{ padding: "6px 8px 6px 28px", color: "#374151" }}>
                        {sub.subcategory}
                      </td>
                      <td style={{ textAlign: "right", padding: "6px 8px", color: "#374151" }}>{NUM(sub.units)}</td>
                      <td style={{ padding: "6px 8px" }}>
                        <MiniBar pct={sub.units_pct} color="#a5b4fc" />
                      </td>
                      <td style={{ textAlign: "right", padding: "6px 8px" }}>{KES(sub.asp)}</td>
                      <td style={{ textAlign: "right", padding: "6px 8px" }}>{KES(sub.revenue)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
              {categories.length === 0 && (
                <tr><td colSpan={5} style={{ padding: 16, textAlign: "center", color: "#9ca3af" }}>No data for this period</td></tr>
              )}
            </tbody>
          </table>

          {selCategory && (
            <button
              onClick={() => setSelCategory("")}
              style={{ fontSize: 12, color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              ← Back to all categories
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// ── Section C — Monthly Target vs Performance ─────────────────────────────────

function GapBar({ pct }) {
  if (pct == null) return <span style={{ color: "#9ca3af" }}>—</span>;
  const s = targetStatus(pct);
  const color = STATUS_COLOR[s];
  const bg    = STATUS_BG[s];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, background: "#e5e7eb", borderRadius: 3, height: 10, maxWidth: 100, position: "relative" }}>
        <div style={{
          width: `${Math.min(pct, 120)}%%`, maxWidth: "100%%",
          background: color, height: "100%%", borderRadius: 3,
          transition: "width 0.3s ease",
        }} />
      </div>
      <span style={{ fontWeight: 700, color, minWidth: 50 }}>{pct.toFixed(1)}%%</span>
    </div>
  );
}

function SectionC({ store }) {
  const { data: tgt, isLoading, error } = useApi(
    "/api/store-profile/targets",
    { store },
    { enabled: !!store, staleTime: 5 * 60_000 }
  );

  if (isLoading) return <Card title={`Section C — ${new Date().toLocaleString("default", { month: "long", year: "numeric" })} Target vs Performance`}><Skeleton rows={8} /></Card>;
  if (error)     return <Card title="Section C — Target vs Performance"><ErrorMsg msg={error.message} /></Card>;
  if (!tgt)      return null;

  const a   = tgt.actuals || {};
  const p   = tgt.projected || {};
  const sev = targetStatus(tgt.pct_of_mtd_target);

  const rows = [
    {
      kpi: "Revenue (Net KES)", fmt: KES,
      actual: a.revenue, target: tgt.target_revenue, projected: p.revenue,
      mtd_target: tgt.mtd_target_revenue, pct: tgt.pct_of_mtd_target,
    },
    {
      kpi: "Transactions", fmt: NUM,
      actual: a.transactions, target: null, projected: p.transactions,
      mtd_target: null, pct: null,
    },
    {
      kpi: "Units Sold", fmt: NUM,
      actual: a.units, target: null, projected: p.units,
      mtd_target: null, pct: null,
    },
    {
      kpi: "ASP", fmt: KES,
      actual: a.asp, target: null, projected: null,
      mtd_target: null, pct: null,
    },
    {
      kpi: "ABV", fmt: KES,
      actual: a.abv, target: null, projected: null,
      mtd_target: null, pct: null,
    },
    {
      kpi: "Discount Rate", fmt: PCT,
      actual: a.discount_rate, target: null, projected: null,
      mtd_target: null, pct: null,
    },
    {
      kpi: "Return Rate", fmt: PCT,
      actual: a.return_rate, target: null, projected: null,
      mtd_target: null, pct: null,
    },
    {
      kpi: "% New Customers", fmt: PCT,
      actual: a.new_customer_pct, target: null, projected: null,
      mtd_target: null, pct: null,
    },
    {
      kpi: "% Returning", fmt: PCT,
      actual: a.returning_customer_pct, target: null, projected: null,
      mtd_target: null, pct: null,
    },
    {
      kpi: "Customer Count", fmt: NUM,
      actual: a.customer_count, target: null, projected: null,
      mtd_target: null, pct: null,
    },
  ];

  return (
    <Card
      title={`Section C — ${tgt.month_label} Target vs Performance`}
      action={
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          Day {tgt.days_done} of {tgt.days_in_month} · {tgt.days_remaining} days remaining
        </span>
      }
    >
      {/* Progress summary banner */}
      {tgt.target_revenue && (
        <div style={{
          background: STATUS_BG[sev], border: `1px solid ${STATUS_COLOR[sev]}`,
          borderRadius: 8, padding: "12px 16px", marginBottom: 16,
          display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center",
        }}>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Monthly Target</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>{KES(tgt.target_revenue, false)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>MTD Actual</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: STATUS_COLOR[sev] }}>{KES(a.revenue, false)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Projected Month-End</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#374151" }}>{KES(p.revenue, false)}</div>
          </div>
          {tgt.revenue_gap != null && tgt.revenue_gap > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>Gap to Target</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#dc2626" }}>−{KES(tgt.revenue_gap, false)}</div>
            </div>
          )}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>
              MTD Attainment ({tgt.pct_of_mtd_target?.toFixed(1)}%% of prorated target)
            </div>
            <GapBar pct={tgt.pct_of_mtd_target} />
          </div>
        </div>
      )}

      {/* KPI detail table */}
      <table style={{ width: "100%%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e5e7eb", background: "#f9fafb" }}>
            <th style={{ textAlign: "left", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>KPI</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>Current (MTD)</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>Projected (EOM)</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>Monthly Target</th>
            <th style={{ textAlign: "left",  padding: "6px 8px", color: "#6b7280", fontWeight: 600, minWidth: 160 }}>MTD Attainment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ kpi, fmt, actual, target, projected, mtd_target, pct }) => (
            <tr key={kpi} style={{ borderBottom: "1px solid #f3f4f6" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <td style={{ padding: "7px 8px", color: "#374151", fontWeight: 500 }}>{kpi}</td>
              <td style={{ textAlign: "right", padding: "7px 8px" }}>{fmt(actual)}</td>
              <td style={{ textAlign: "right", padding: "7px 8px", color: "#6b7280" }}>
                {projected != null ? fmt(projected) : <span style={{ color: "#9ca3af" }}>—</span>}
              </td>
              <td style={{ textAlign: "right", padding: "7px 8px" }}>
                {target != null ? fmt(target) : <span style={{ color: "#9ca3af" }}>—</span>}
              </td>
              <td style={{ padding: "7px 8px" }}>
                {pct != null ? <GapBar pct={pct} /> : <span style={{ color: "#9ca3af" }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Projection method note */}
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>
        ℹ Projection method: average daily run-rate (MTD actual ÷ days elapsed) × days in month.
        {tgt.required_daily_revenue && (
          <> Required to hit target: <strong style={{ color: "#374151" }}>KES {Number(tgt.required_daily_revenue).toLocaleString()}/day</strong> for {tgt.days_remaining} remaining days.</>
        )}
      </div>

      {/* Suggestions */}
      {tgt.suggestions?.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 8 }}>
            Suggested Actions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tgt.suggestions.map((s, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                background: STATUS_BG[s.severity] || "#f9fafb",
                border: `1px solid ${STATUS_COLOR[s.severity] || "#d1d5db"}`,
                borderRadius: 6, padding: "10px 12px",
              }}>
                <Pill sev={s.severity}>
                  {s.severity === "good" ? "✓ On track" : s.severity === "high" ? "⚠ Action needed" : s.severity === "medium" ? "● Watch" : "○ Info"}
                </Pill>
                <div style={{ fontSize: 12, color: "#374151", flex: 1 }}>{s.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!tgt.target_revenue && (
        <div style={{ padding: 12, background: "#f9fafb", borderRadius: 6, fontSize: 12, color: "#6b7280" }}>
          No revenue target stored for this store in {tgt.month_label}. Targets are loaded from the annual budget file.
        </div>
      )}
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StoreProfiling() {
  const LS_KEY = "vivo_store_profile_last_store";

  const { data: locsData, isLoading: locsLoading } = useApi("/api/store-profile/locations");
  const stores = locsData?.stores || [];

  const [store, setStore] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || null; } catch { return null; }
  });

  // Default to first store once list loads
  useEffect(() => {
    if (!store && stores.length > 0) setStore(stores[0].store);
  }, [store, stores]);

  // Persist selection
  useEffect(() => {
    if (store) { try { localStorage.setItem(LS_KEY, store); } catch {} }
  }, [store]);

  const { data: trendData, isLoading: trendLoading, error: trendError } = useApi(
    "/api/store-profile/kpi-trend",
    { store },
    { enabled: !!store }
  );

  const storeCountry = useMemo(
    () => stores.find((s) => s.store === store)?.country || "",
    [stores, store]
  );

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 16px" }}>
      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#111827", margin: 0 }}>
          Store Profile
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          In-depth performance view for a single store — monthly trend, category mix, and target tracking.
        </p>
      </div>

      {/* Store selector */}
      <div style={{
        background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8,
        padding: "14px 18px", marginBottom: 20,
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
      }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>
            STORE
          </label>
          {locsLoading ? (
            <div style={{ width: 200, height: 32, background: "#f3f4f6", borderRadius: 6 }} />
          ) : (
            <select
              value={store || ""}
              onChange={(e) => setStore(e.target.value)}
              style={{
                border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 32px 6px 10px",
                fontSize: 14, fontWeight: 600, color: "#111827", minWidth: 200,
                background: "#fff",
              }}
            >
              {stores.map((s) => (
                <option key={s.store} value={s.store}>{s.store}</option>
              ))}
            </select>
          )}
        </div>

        {storeCountry && (
          <div style={{ padding: "4px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600,
                        background: storeCountry === "Kenya" ? "#f0fdf4"
                                  : storeCountry === "Uganda" ? "#fffbeb" : "#f0fdfa",
                        color:      storeCountry === "Kenya" ? "#15803d"
                                  : storeCountry === "Uganda" ? "#b45309" : "#0f766e" }}>
            {storeCountry}
          </div>
        )}
      </div>

      {store && (
        <>
          <SectionA store={store} trendData={trendData} loading={trendLoading} error={trendError} />
          <SectionB store={store} trendData={trendData} />
          <SectionC store={store} />
        </>
      )}
    </div>
  );
}
