import React, { useEffect, useState } from "react";
import { api, buildParams, fmtKES, fmtKESLong, fmtPct } from "@/lib/api";
import { SectionTitle } from "@/components/common";
import { exportCSV } from "@/components/SortableTable";

// Account-level P&L detail for the selected window (cached server-side by the
// windowed query, so multiple reports requesting the same window share one DB
// hit). Returns the flat detail array + loading flag.
export function usePlDetail(fromMonth, toMonth) {
  const [detail, setDetail] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get("/finance/pl-detail", { params: buildParams({ dateFrom: fromMonth, dateTo: toMonth }) })
      .then((r) => !cancelled && setDetail(r.data?.detail || []))
      .catch(() => !cancelled && setDetail([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fromMonth, toMonth]);
  return { detail, loading };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared building blocks for the Finance Reports Suite.
//
// All seven reports read the official-Odoo monthly P&L returned by
// GET /api/finance/pl (full month history) and the account-level detail from
// GET /api/finance/pl-detail / GET /api/finance/expense-by-vendor. Everything is
// KES, read-only, and tagged for data honesty (open months = partial; anomaly
// months = under finance review but shown with real figures).
// ─────────────────────────────────────────────────────────────────────────────

export const num = (v) => Number(v || 0);
export const sumKey = (rows, key) => (rows || []).reduce((s, r) => s + num(r[key]), 0);

// `month` is YYYY-MM-DD (first of month). Parse the parts directly so we never
// shift across the EAT (UTC+3) boundary.
export const monthLabel = (m) => {
  if (!m) return "";
  const [y, mo] = String(m).split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
};
export const monthLabelLong = (m) => {
  if (!m) return "";
  const [y, mo] = String(m).split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};

const monthsAgoFirst = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const curMonthFirst = () => monthsAgoFirst(0);
const firstOfYear = (y) => `${y}-01-01`;
const lastMonthOfYear = (y) => `${y}-12-01`;

// Month-grain period presets (this suite drives its OWN period, not the global
// daily filter bar — a P&L needs month granularity).
export const PERIOD_PRESETS = [
  { key: "last3", label: "Last 3 months", range: () => ({ from: monthsAgoFirst(2), to: curMonthFirst() }) },
  { key: "last6", label: "Last 6 months", range: () => ({ from: monthsAgoFirst(5), to: curMonthFirst() }) },
  { key: "last12", label: "Last 12 months", range: () => ({ from: monthsAgoFirst(11), to: curMonthFirst() }) },
  { key: "ytd", label: "This year (YTD)", range: () => ({ from: firstOfYear(new Date().getFullYear()), to: curMonthFirst() }) },
  { key: "lastYear", label: "Last year", range: () => ({ from: firstOfYear(new Date().getFullYear() - 1), to: lastMonthOfYear(new Date().getFullYear() - 1) }) },
];

// A month carries Odoo accounting figures (pre-2026 months only have sales
// pipeline, every Odoo P&L column is zero). Used to default the period and to
// keep empty pre-accounting months out of the analytical reports.
export const isAccounting = (m) =>
  num(m.revenue_odoo) !== 0 ||
  num(m.total_costs_of_revenue) !== 0 ||
  num(m.total_operating_expenses) !== 0 ||
  num(m.other_income) !== 0;

export const accountingMonths = (rows) => (rows || []).filter(isAccounting);
export const closedAccounting = (rows) => (rows || []).filter((m) => isAccounting(m) && m.is_closed);

export const periodFlags = (rows) => ({
  anomaly: (rows || []).some((m) => m.has_cost_anomaly),
  open: (rows || []).some((m) => !m.is_closed),
  anomalyMonths: (rows || []).filter((m) => m.has_cost_anomaly).map((m) => monthLabel(m.month)),
  openMonths: (rows || []).filter((m) => !m.is_closed).map((m) => monthLabel(m.month)),
});

// ── Statement structure (official Odoo P&L) ────────────────────────────────
export const COST_GROUPS = [
  { key: "cogs", label: "Cost of Goods Sold", group: "cogs" },
  { key: "production", label: "Production", group: "production" },
  { key: "purchases", label: "Purchases", group: "purchases" },
];
export const OPEX_GROUPS = [
  { key: "employment", label: "Employment", group: "employment" },
  { key: "admin", label: "Administrative", group: "admin" },
  { key: "establishment", label: "Establishment", group: "establishment" },
  { key: "selling", label: "Selling & Distribution", group: "selling" },
  { key: "marketing", label: "Marketing", group: "marketing" },
  { key: "finance_charges", label: "Finance Charges", group: "finance_charges" },
  { key: "other_opex", label: "Other Operating Expenses", group: "other_opex" },
];

export const STATEMENT = [
  { kind: "section", label: "Revenue" },
  { kind: "line", key: "revenue_odoo", label: "Revenue", drill: { section: "revenue" } },
  { kind: "section", label: "Less: Cost of Revenue" },
  ...COST_GROUPS.map((g) => ({ kind: "line", key: g.key, label: g.label, drill: { group: g.group } })),
  { kind: "subtotal", key: "total_costs_of_revenue", label: "Total Cost of Revenue" },
  { kind: "total", key: "gross_profit", label: "Gross Profit" },
  { kind: "section", label: "Less: Operating Expenses" },
  ...OPEX_GROUPS.map((g) => ({ kind: "line", key: g.key, label: g.label, drill: { group: g.group } })),
  { kind: "subtotal", key: "total_operating_expenses", label: "Total Operating Expenses" },
  { kind: "total", key: "operating_income", label: "Operating Income" },
  { kind: "section", label: "Add: Other Income" },
  { kind: "line", key: "other_income", label: "Other Income", drill: { section: "other_income" } },
  { kind: "total", key: "net_profit", label: "Net Profit", big: true },
];

// Whitelisted pl_group → friendly label (vendor category filter + detail labels).
export const GROUP_LABELS = {
  ...Object.fromEntries(COST_GROUPS.map((g) => [g.group, g.label])),
  ...Object.fromEntries(OPEX_GROUPS.map((g) => [g.group, g.label])),
  other_income: "Other Income",
  revenue: "Revenue",
};

export const COLORS = ["#1a5c38", "#2563eb", "#7c3aed", "#d97706", "#0891b2", "#dc2626", "#65a30d", "#db2777", "#475569", "#ca8a04"];

// ── Presentational primitives ──────────────────────────────────────────────

// KES money with loss styling — negatives render red and in parentheses.
export const Money = ({ value, strong = false, muted = false, className = "" }) => {
  const n = num(value);
  const neg = n < 0;
  const txt = fmtKESLong(Math.abs(n));
  return (
    <span
      className={`tabular-nums whitespace-nowrap ${neg ? "text-red-600" : muted ? "text-muted" : ""} ${strong ? "font-semibold" : ""} ${className}`}
    >
      {neg ? `(${txt})` : txt}
    </span>
  );
};

export const Tag = ({ tone = "muted", children, title }) => {
  const tones = {
    amber: "bg-amber-100 text-amber-800 border-amber-300",
    slate: "bg-slate-100 text-slate-600 border-slate-300",
    brand: "bg-brand/10 text-brand-deep border-brand/30",
    red: "bg-red-100 text-red-700 border-red-300",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${tones[tone] || tones.slate}`}
    >
      {children}
    </span>
  );
};

// Inline data-honesty tags for a set of months (anomaly + not-closed).
export const HonestyTags = ({ rows }) => {
  const f = periodFlags(rows);
  if (!f.anomaly && !f.open) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {f.anomaly && (
        <Tag tone="red" title={`Cost anomaly under finance review: ${f.anomalyMonths.join(", ")}`}>
          ⚠ Anomaly: {f.anomalyMonths.join(", ")}
        </Tag>
      )}
      {f.open && (
        <Tag tone="amber" title={`Month not yet closed — partial data: ${f.openMonths.join(", ")}`}>
          Not closed: {f.openMonths.join(", ")}
        </Tag>
      )}
    </span>
  );
};

// Card wrapper for a chart with a title/subtitle and optional right action.
export const ChartCard = ({ title, subtitle, action, children, testId }) => (
  <div className="card-white p-4" data-testid={testId}>
    <SectionTitle title={title} subtitle={subtitle} action={action} />
    {children}
  </div>
);

const alignCls = (a) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

// Column factories so money/percent cells render + export consistently.
export const kesCol = (key, label, opts = {}) => ({
  key,
  label,
  align: "right",
  render: (r) => <Money value={opts.value ? opts.value(r) : r[key]} strong={opts.strong} />,
  csv: (r) => String(num(opts.value ? opts.value(r) : r[key])),
});
export const pctCol = (key, label, opts = {}) => ({
  key,
  label,
  align: "right",
  render: (r) => {
    const v = opts.value ? opts.value(r) : r[key];
    return v == null ? "—" : fmtPct(v);
  },
});

// Generic table card with built-in CSV export. `columns` are
// {key,label,align?,render?,csv?}. Empty state handled.
export const DataTableCard = ({ title, subtitle, columns, rows, filename, maxHeight = "60vh", rightActions, testId }) => (
  <div className="card-white p-4" data-testid={testId}>
    <SectionTitle
      title={title}
      subtitle={subtitle}
      action={
        <div className="flex items-center gap-2">
          {rightActions}
          <button
            type="button"
            onClick={() => exportCSV(rows, columns, filename)}
            disabled={!rows || rows.length === 0}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>
      }
    />
    {!rows || rows.length === 0 ? (
      <p className="text-[12.5px] text-muted py-6 text-center">No data for the selected period.</p>
    ) : (
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={alignCls(c.align)}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r._key || i}>
                {columns.map((c) => (
                  <td key={c.key} className={alignCls(c.align)}>
                    {c.render ? c.render(r, i) : r[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

// Small share helpers used across reports.
export { fmtKES, fmtKESLong, fmtPct };
