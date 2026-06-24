import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  LineChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Warning, Coins, Receipt, Percent, ChartLineUp, Buildings, Wallet } from "@phosphor-icons/react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtKESLong, fmtPct, fmtAxisKES, buildParams } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { KPICard } from "@/components/KPICard";
import { exportCSV } from "@/components/SortableTable";

// Finance / P&L. Sources the monthly Profit & Loss from the Postgres
// `finance_pl_summary` view (one row per calendar month) via GET /api/finance/pl.
//
// The page deliberately separates the figures into TWO TIERS because the
// underlying accounting is only partially complete:
//   • CONFIRMED  — directly journaled / transactional figures we trust:
//                  Net Revenue, Production Opex, Admin Opex. Summarised over
//                  CLOSED months only (is_closed = true).
//   • PROVISIONAL — derived from incomplete COGS recognition and missing
//                  payroll: Gross Margin %, Gross Profit, Operating Income.
//                  Rendered muted + bordered behind a standing warning banner.
// Open months (is_closed = false) are partial and are EXCLUDED from the tier
// summaries and the trend chart so a half-month never distorts a comparison.

// EXACT provisional warning copy — do not paraphrase.
const PROVISIONAL_WARNING =
  "⚠️ Provisional — COGS recognition in Odoo is incomplete (implied margins are not yet reliable) and payroll is not yet journaled (~KES 40M/month). These figures will change once accounting is complete.";

// P&L line items, in statement order. `tier` drives the visual treatment of
// the matching row; `type` drives cell formatting.
const LINE_ITEMS = [
  { key: "gross_sales", label: "Gross Sales", type: "kes", tier: "confirmed" },
  { key: "returns", label: "Returns", type: "kes", tier: "confirmed" },
  { key: "net_revenue", label: "Net Revenue", type: "kes", tier: "confirmed", strong: true },
  { key: "cogs", label: "COGS", type: "kes", tier: "provisional", flagCogs: true },
  { key: "gross_profit", label: "Gross Profit", type: "kes", tier: "provisional" },
  { key: "gross_margin_pct", label: "Gross Margin %", type: "pct", tier: "provisional" },
  { key: "production_opex", label: "Production Opex", type: "kes", tier: "confirmed" },
  { key: "admin_opex", label: "Admin Opex", type: "kes", tier: "confirmed" },
  { key: "total_opex", label: "Total Opex", type: "kes", tier: "confirmed", strong: true },
  { key: "salaries", label: "Salaries", type: "salaries", tier: "confirmed" },
  { key: "operating_income", label: "Operating Income", type: "kes", tier: "provisional", strong: true },
];

const monthLabel = (m) => {
  // `month` is YYYY-MM-DD (first of month). Parse the parts directly so we
  // never shift across a timezone boundary (East Africa is UTC+3).
  if (!m) return "";
  const [y, mo] = String(m).split("-");
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
};

// Longer label for the period summary ("January 2026").
const monthLabelLong = (m) => {
  if (!m) return "";
  const [y, mo] = String(m).split("-");
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};

// First-of-month ISO string (YYYY-MM-01) N months before the current month.
// Computed in local time so we never shift across the EAT (UTC+3) boundary.
const monthsAgoFirst = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const curMonthFirst = () => monthsAgoFirst(0);
const firstOfYear = (y) => `${y}-01-01`;
const lastMonthOfYear = (y) => `${y}-12-01`;

// The Finance page drives its OWN month-range period (NOT the global daily
// filter bar): a monthly P&L needs month granularity, and the global default
// preset is "today" which would ask for a single still-open day. These presets
// are tailored to a P&L statement. `key` is used to highlight the active chip.
const PERIOD_PRESETS = [
  { key: "last3", label: "Last 3 months", range: () => ({ from: monthsAgoFirst(2), to: curMonthFirst() }) },
  { key: "last6", label: "Last 6 months", range: () => ({ from: monthsAgoFirst(5), to: curMonthFirst() }) },
  { key: "last12", label: "Last 12 months", range: () => ({ from: monthsAgoFirst(11), to: curMonthFirst() }) },
  { key: "ytd", label: "This year (YTD)", range: () => ({ from: firstOfYear(new Date().getFullYear()), to: curMonthFirst() }) },
  { key: "lastYear", label: "Last year", range: () => ({ from: firstOfYear(new Date().getFullYear() - 1), to: lastMonthOfYear(new Date().getFullYear() - 1) }) },
];

const ProvisionalBanner = () => (
  <div
    className="card-white p-3.5 border-2 border-amber-400/70 bg-amber-50/70 flex items-start gap-3"
    role="note"
    data-testid="provisional-banner"
  >
    <Warning size={20} weight="fill" className="text-amber-500 shrink-0 mt-0.5" />
    <p className="text-[12.5px] leading-relaxed text-amber-900">
      {/* Rendered verbatim — the banner copy must match the spec exactly. */}
      {PROVISIONAL_WARNING}
    </p>
  </div>
);

const Finance = () => {
  // The Finance page intentionally drives its OWN month-range period rather
  // than the global daily filter bar (date presets like "today" / "last 90d"
  // don't map onto a monthly P&L). The global Refresh button still refreshes
  // this page via `dataVersion`.
  const { applied, touchLastUpdated } = useFilters();
  const { dataVersion } = applied;

  const [data, setData] = useState({ months: [], opex_detail: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Selected month-range period. Default to the last 12 months — almost always
  // populated and a sensible default view for a P&L. `presetKey` tracks which
  // quick-chip is active ("custom" once the user picks months manually).
  const last12 = PERIOD_PRESETS.find((p) => p.key === "last12").range();
  const [fromMonth, setFromMonth] = useState(last12.from);
  const [toMonth, setToMonth] = useState(last12.to);
  const [presetKey, setPresetKey] = useState("last12");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/finance/pl", { params: buildParams({ dateFrom: fromMonth, dateTo: toMonth }) })
      .then((r) => {
        if (cancelled) return;
        setData({
          months: r.data?.months || [],
          opex_detail: r.data?.opex_detail || [],
          all_months: r.data?.all_months || [],
        });
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line
  }, [fromMonth, toMonth, dataVersion]);

  // Distinct months available in the P&L view (oldest → newest) for the
  // From/To dropdowns. The backend returns the FULL month history; we filter
  // to the selected window client-side below.
  const availableMonths = useMemo(
    () => (data.months || []).map((m) => String(m.month)).filter(Boolean),
    [data.months]
  );

  const applyPreset = (key) => {
    const p = PERIOD_PRESETS.find((x) => x.key === key);
    if (!p) return;
    const { from, to } = p.range();
    setFromMonth(from);
    setToMonth(to);
    setPresetKey(key);
  };
  const applyAll = () => {
    if (!availableMonths.length) return;
    setFromMonth(availableMonths[0]);
    setToMonth(availableMonths[availableMonths.length - 1]);
    setPresetKey("all");
  };
  const onFromChange = (v) => {
    setFromMonth(v);
    // Keep from <= to.
    if (toMonth && v > toMonth) setToMonth(v);
    setPresetKey("custom");
  };
  const onToChange = (v) => {
    setToMonth(v);
    if (fromMonth && v < fromMonth) setFromMonth(v);
    setPresetKey("custom");
  };

  // Rows shown in the summary / charts / matrix: the full history filtered to
  // the selected [fromMonth, toMonth] window (inclusive on the first-of-month).
  const months = useMemo(
    () =>
      (data.months || []).filter(
        (m) => String(m.month) >= fromMonth && String(m.month) <= toMonth
      ),
    [data.months, fromMonth, toMonth]
  );
  const closed = useMemo(() => months.filter((m) => m.is_closed), [months]);

  // CONFIRMED + PROVISIONAL tier roll-ups, computed over CLOSED months only.
  const summary = useMemo(() => {
    const sum = (k) => closed.reduce((s, m) => s + Number(m[k] || 0), 0);
    const netRevenue = sum("net_revenue");
    const grossProfit = sum("gross_profit");
    return {
      n: closed.length,
      netRevenue,
      productionOpex: sum("production_opex"),
      adminOpex: sum("admin_opex"),
      totalOpex: sum("total_opex"),
      grossProfit,
      operatingIncome: sum("operating_income"),
      // Weighted gross margin = total gross profit / total net revenue.
      grossMarginPct: netRevenue > 0 ? (grossProfit * 100) / netRevenue : null,
    };
  }, [closed]);

  // Trend chart series — CONFIRMED figures only, closed months, oldest → newest.
  // Provisional metrics (operating income, margin) are deliberately kept OUT of
  // these charts so a confirmed visual can never be read as a provisional one.
  const trend = useMemo(
    () =>
      closed.map((m) => ({
        month: monthLabel(m.month),
        net_revenue: Number(m.net_revenue || 0),
        production_opex: Number(m.production_opex || 0),
        admin_opex: Number(m.admin_opex || 0),
      })),
    [closed]
  );

  // Build the transposed P&L matrix (line items as rows, months as columns) +
  // a matching column/row model for the CSV export.
  const exportPL = () => {
    const cols = [
      { key: "line", label: "Line Item" },
      ...months.map((m) => ({
        key: m.month,
        label: `${monthLabel(m.month)}${m.is_closed ? "" : " (open)"}`,
        numeric: true,
      })),
    ];
    const rows = LINE_ITEMS.map((li) => {
      const row = { line: li.label };
      months.forEach((m) => {
        if (li.type === "salaries" && !m.has_salaries) {
          row[m.month] = "Not in Odoo";
        } else if (li.type === "pct") {
          row[m.month] = m[li.key] == null ? "" : fmtPct(m[li.key]);
        } else {
          row[m.month] = fmtKESLong(m[li.key]);
        }
      });
      return row;
    });
    exportCSV(rows, cols, "finance-pl.csv");
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-6" data-testid="finance-page">
      <SectionTitle
        title={
          <span className="inline-flex items-center gap-2">
            Finance / P&amp;L
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wide"
              data-testid="finance-wip-badge"
            >
              Work in progress
            </span>
          </span>
        }
        subtitle="Monthly Profit & Loss in KES. Confirmed transactional figures are shown separately from provisional, accounting-dependent estimates."
        testId="finance-header"
      />

      <div
        className="card-white p-3.5 border-2 border-amber-400/70 bg-amber-50/70 flex items-start gap-3"
        data-testid="finance-wip-banner"
      >
        <Warning size={20} weight="fill" className="text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[12.5px] leading-relaxed text-amber-900">
          <span className="font-bold">Work in progress.</span> This Finance / P&amp;L page is
          still under development and visible to administrators only. Figures may be incomplete
          or change as accounting data is finalised — do not treat them as final reporting yet.
        </p>
      </div>

      {/* Dedicated month-range PERIOD selector (this page ignores the global
          daily filter bar — a P&L needs month granularity). Quick presets +
          explicit From/To month dropdowns, with a clear "period covered" line. */}
      <div className="card-white p-3.5 space-y-3" data-testid="finance-period">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted mr-1">Period</span>
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              data-testid={`period-${p.key}`}
              className={`text-[12px] px-2.5 py-1 rounded-full border transition-colors ${
                presetKey === p.key
                  ? "bg-brand text-white border-brand"
                  : "bg-white text-muted border-border hover:border-brand hover:text-brand"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={applyAll}
            disabled={!availableMonths.length}
            data-testid="period-all"
            className={`text-[12px] px-2.5 py-1 rounded-full border transition-colors disabled:opacity-40 ${
              presetKey === "all"
                ? "bg-brand text-white border-brand"
                : "bg-white text-muted border-border hover:border-brand hover:text-brand"
            }`}
          >
            All
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            From
            <select
              value={fromMonth}
              onChange={(e) => onFromChange(e.target.value)}
              data-testid="period-from"
              className="text-[12.5px] px-2 py-1 rounded border border-border bg-white focus:border-brand outline-none"
            >
              {!availableMonths.includes(fromMonth) && <option value={fromMonth}>{monthLabel(fromMonth)}</option>}
              {availableMonths.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            To
            <select
              value={toMonth}
              onChange={(e) => onToChange(e.target.value)}
              data-testid="period-to"
              className="text-[12.5px] px-2 py-1 rounded border border-border bg-white focus:border-brand outline-none"
            >
              {!availableMonths.includes(toMonth) && <option value={toMonth}>{monthLabel(toMonth)}</option>}
              {availableMonths.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </label>
          <span className="text-[12px] text-muted" data-testid="period-summary">
            Showing <span className="font-semibold text-ink">{monthLabelLong(fromMonth)}</span>
            {" – "}
            <span className="font-semibold text-ink">{monthLabelLong(toMonth)}</span>
            {months.length > 0 && (
              <>
                {" · "}{months.length} month{months.length === 1 ? "" : "s"}
                {summary.n > 0 && <> ({summary.n} closed)</>}
              </>
            )}
          </span>
        </div>
      </div>

      <ProvisionalBanner />

      {months.length === 0 ? (
        <Empty label="No Profit & Loss data for the selected date range." />
      ) : (
        <>
          {/* CONFIRMED tier */}
          <section data-testid="confirmed-tier">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-brand/10 text-brand-deep border border-brand/30">
                <span className="w-1.5 h-1.5 rounded-full bg-brand" /> Confirmed
              </span>
              <span className="text-[12px] text-muted">
                {summary.n > 0
                  ? `Transactional figures across ${summary.n} closed month${summary.n === 1 ? "" : "s"}`
                  : "No closed months in range — awaiting month-end close"}
              </span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KPICard
                label="Net Revenue"
                value={fmtKES(summary.netRevenue)}
                valueFull={fmtKESLong(summary.netRevenue)}
                icon={Coins}
                accent
                showDelta={false}
                testId="kpi-net-revenue"
              />
              <KPICard
                label="Production Opex"
                value={fmtKES(summary.productionOpex)}
                valueFull={fmtKESLong(summary.productionOpex)}
                icon={Buildings}
                showDelta={false}
                testId="kpi-production-opex"
              />
              <KPICard
                label="Admin Opex"
                value={fmtKES(summary.adminOpex)}
                valueFull={fmtKESLong(summary.adminOpex)}
                icon={Receipt}
                showDelta={false}
                testId="kpi-admin-opex"
              />
              <KPICard
                label="Total Opex"
                value={fmtKES(summary.totalOpex)}
                valueFull={fmtKESLong(summary.totalOpex)}
                icon={Wallet}
                showDelta={false}
                testId="kpi-total-opex"
              />
            </div>

            {trend.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
                {/* Net Revenue — monthly bar chart (confirmed, closed months only) */}
                <div className="card-white p-4" data-testid="net-revenue-chart">
                  <SectionTitle
                    title="Net Revenue by Month"
                    subtitle="Confirmed transactional revenue, closed months only."
                  />
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
                      <Tooltip formatter={(v) => fmtKESLong(v)} />
                      <Bar dataKey="net_revenue" name="Net Revenue" fill="#1a5c38" radius={[3, 3, 0, 0]} maxBarSize={42} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Operating Expenses — Production vs Admin (confirmed, two series) */}
                <div className="card-white p-4" data-testid="opex-trend-chart">
                  <SectionTitle
                    title="Operating Expenses — Production vs Admin"
                    subtitle="Confirmed opex by group, closed months only."
                  />
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
                      <Tooltip formatter={(v) => fmtKESLong(v)} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line
                        type="monotone"
                        dataKey="production_opex"
                        name="Production Opex"
                        stroke="#2563eb"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="admin_opex"
                        name="Admin Opex"
                        stroke="#7c3aed"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </section>

          {/* PROVISIONAL tier */}
          <section data-testid="provisional-tier">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-300">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Provisional
              </span>
              <span className="text-[12px] text-muted">
                Depends on incomplete COGS &amp; un-journaled payroll — treat as estimates
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border-2 border-dashed border-amber-300/70 bg-amber-50/40 p-3">
              <KPICard
                label="Gross Margin %"
                value={summary.grossMarginPct == null ? "—" : fmtPct(summary.grossMarginPct)}
                icon={Percent}
                showDelta={false}
                testId="kpi-gross-margin"
              />
              <KPICard
                label="Gross Profit"
                value={fmtKES(summary.grossProfit)}
                valueFull={fmtKESLong(summary.grossProfit)}
                icon={ChartLineUp}
                showDelta={false}
                testId="kpi-gross-profit"
              />
              <KPICard
                label="Operating Income"
                value={fmtKES(summary.operatingIncome)}
                valueFull={fmtKESLong(summary.operatingIncome)}
                icon={Coins}
                showDelta={false}
                testId="kpi-operating-income"
              />
            </div>
          </section>

          {/* Monthly P&L matrix — line items as rows, months as columns */}
          <div className="card-white p-4">
            <SectionTitle
              title="Monthly P&L"
              subtitle="All figures in KES. Provisional rows are tinted amber; open months carry partial data."
              action={
                <button
                  type="button"
                  onClick={exportPL}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand"
                  data-testid="finance-export"
                >
                  Export CSV
                </button>
              }
            />
            <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
              <table className="w-full data sticky-first-col">
                <thead className="sticky top-0 z-20 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)]">
                  <tr>
                    <th className="text-left sticky left-0 z-30 bg-white">Line Item</th>
                    {months.map((m) => (
                      <th key={m.month} className="text-right whitespace-nowrap">
                        <div className="flex flex-col items-end gap-0.5">
                          <span>{monthLabel(m.month)}</span>
                          {m.is_closed ? (
                            <span className="text-[9.5px] font-medium text-brand/70 normal-case">Closed</span>
                          ) : (
                            <span className="text-[9.5px] font-medium text-amber-600 normal-case max-w-[88px] text-right leading-tight">
                              month not closed — partial data
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {LINE_ITEMS.map((li) => {
                    const prov = li.tier === "provisional";
                    return (
                      <tr key={li.key} className={prov ? "bg-amber-50/50" : ""}>
                        <td
                          className={`text-left sticky left-0 z-10 ${prov ? "bg-amber-50/50" : "bg-white"} ${
                            li.strong ? "font-semibold" : ""
                          }`}
                        >
                          <span className={prov ? "text-amber-900 italic" : ""}>{li.label}</span>
                          {prov && (
                            <span className="ml-1.5 text-[9px] uppercase tracking-wide text-amber-600 font-bold">
                              prov.
                            </span>
                          )}
                        </td>
                        {months.map((m) => {
                          let content;
                          let cls = "text-right num whitespace-nowrap";
                          if (li.type === "salaries" && !m.has_salaries) {
                            content = <span className="text-muted italic">Not in Odoo</span>;
                          } else if (li.type === "pct") {
                            content = m[li.key] == null ? "—" : fmtPct(m[li.key]);
                          } else {
                            const v = Number(m[li.key] || 0);
                            content = fmtKES(v);
                            if (v < 0) cls += " text-danger";
                          }
                          // Flag COGS cells where COGS is not fully recognised.
                          const cogsFlag = li.flagCogs && !m.has_full_cogs;
                          return (
                            <td key={m.month} className={`${cls} ${li.strong ? "font-semibold" : ""} ${prov ? "bg-amber-50/50" : ""}`}>
                              <span title={cogsFlag ? "COGS not fully recognised for this month" : undefined}>
                                {content}
                                {cogsFlag && <span className="text-amber-600 font-bold ml-0.5">*</span>}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              <span className="text-amber-600 font-bold">*</span> COGS not fully recognised for that month — gross
              profit &amp; margin are overstated (provisional).
            </p>
          </div>

          {/* Operating expense breakdown by account */}
          <div className="card-white p-4">
            <SectionTitle
              title="Operating Expenses by Account"
              subtitle="Production &amp; admin opex over the selected months, by ledger account."
              action={
                data.opex_detail.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      exportCSV(
                        data.opex_detail,
                        [
                          { key: "account", label: "Account" },
                          { key: "pl_group", label: "Group" },
                          { key: "amount", label: "Amount (KES)", numeric: true, render: (r) => fmtKESLong(r.amount) },
                        ],
                        "finance-opex-by-account.csv"
                      )
                    }
                    className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand"
                    data-testid="opex-export"
                  >
                    Export CSV
                  </button>
                ) : null
              }
            />
            {data.opex_detail.length === 0 ? (
              <Empty label="No operating-expense detail for the selected range." />
            ) : (
              <div className="overflow-auto" style={{ maxHeight: "60vh" }}>
                <table className="w-full data">
                  <thead className="sticky top-0 z-20 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)]">
                    <tr>
                      <th className="text-left">Account</th>
                      <th className="text-left">Group</th>
                      <th className="text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.opex_detail.map((r, i) => (
                      <tr key={`${r.account}-${i}`}>
                        <td className="text-left">{r.account || "—"}</td>
                        <td className="text-left">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-semibold ${
                              r.pl_group === "production_opex"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-purple-50 text-purple-700"
                            }`}
                          >
                            {r.pl_group === "production_opex" ? "Production" : "Admin"}
                          </span>
                        </td>
                        <td className="text-right num whitespace-nowrap">{fmtKES(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default Finance;
