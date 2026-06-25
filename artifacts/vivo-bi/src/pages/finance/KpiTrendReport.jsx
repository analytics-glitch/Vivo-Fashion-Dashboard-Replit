import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, LineChart, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Coins, ChartLineUp, Percent, Scales, TrendUp } from "@phosphor-icons/react";
import { fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Empty } from "@/components/common";
import {
  DataTableCard, ChartCard, Tag, kesCol, pctCol,
  closedAccounting, monthLabel, num, fmtKES, fmtKESLong, fmtPct,
} from "./shared";

const margin = (m) => (num(m.revenue_odoo) ? (num(m.gross_profit) / num(m.revenue_odoo)) * 100 : 0);
const delta = (cur, prev) => (prev ? ((cur - prev) / Math.abs(prev)) * 100 : null);

// P&L Trend & KPIs: headline KPIs (latest closed month vs prior) plus revenue,
// profit and margin trends. Restricted to CLOSED accounting months so the trend
// is not distorted by partial open months.
export default function KpiTrendReport({ months }) {
  const closed = useMemo(() => closedAccounting(months), [months]);

  const rows = useMemo(
    () =>
      closed.map((m) => ({
        _key: m.month,
        month: monthLabel(m.month),
        revenue_odoo: num(m.revenue_odoo),
        gross_profit: num(m.gross_profit),
        gross_margin: margin(m),
        operating_income: num(m.gross_profit) - num(m.total_operating_expenses),
        net_profit: num(m.net_profit),
      })),
    [closed]
  );

  if (rows.length === 0) {
    return <Empty label="No closed accounting months in the selected period to chart KPIs." />;
  }

  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;

  return (
    <div className="space-y-4" data-testid="finance-kpi-trend">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted">
          Headline KPIs for <span className="font-semibold text-foreground">{last.month}</span>
          {prev ? ` vs ${prev.month}` : ""} · closed accounting months only.
        </p>
        <Tag tone="brand">{rows.length} closed month{rows.length === 1 ? "" : "s"}</Tag>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard label="Revenue" value={fmtKES(last.revenue_odoo)} valueFull={fmtKESLong(last.revenue_odoo)} icon={Coins} accent delta={prev ? delta(last.revenue_odoo, prev.revenue_odoo) : null} showDelta={!!prev} />
        <KPICard label="Gross Profit" value={fmtKES(last.gross_profit)} valueFull={fmtKESLong(last.gross_profit)} icon={ChartLineUp} delta={prev ? delta(last.gross_profit, prev.gross_profit) : null} showDelta={!!prev} />
        <KPICard label="Gross Margin" value={fmtPct(last.gross_margin)} icon={Percent} delta={prev ? last.gross_margin - prev.gross_margin : null} deltaSuffix="pp" showDelta={!!prev} />
        <KPICard label="Operating Income" value={fmtKES(last.operating_income)} valueFull={fmtKESLong(last.operating_income)} icon={Scales} delta={prev ? delta(last.operating_income, prev.operating_income) : null} showDelta={!!prev} />
        <KPICard label="Net Profit" value={fmtKES(last.net_profit)} valueFull={fmtKESLong(last.net_profit)} icon={TrendUp} delta={prev ? delta(last.net_profit, prev.net_profit) : null} showDelta={!!prev} />
      </div>

      <ChartCard title="Revenue, Gross Profit &amp; Net Profit" subtitle="Closed accounting months, KES." testId="kpi-trend-money">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
            <Tooltip formatter={(v) => fmtKESLong(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue_odoo" name="Revenue" fill="#1a5c38" radius={[3, 3, 0, 0]} maxBarSize={36} />
            <Line type="monotone" dataKey="gross_profit" name="Gross Profit" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="net_profit" name="Net Profit" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Gross Margin %" subtitle="Gross profit as a share of revenue, closed months." testId="kpi-trend-margin">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={(v) => `${v.toFixed(0)}%`} tick={{ fontSize: 11 }} width={44} />
            <Tooltip formatter={(v) => fmtPct(v)} />
            <Line type="monotone" dataKey="gross_margin" name="Gross Margin" stroke="#7c3aed" strokeWidth={2.5} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <DataTableCard
        title="Monthly KPI Detail"
        subtitle="Closed accounting months, KES."
        filename="finance-kpi-trend.csv"
        rows={rows}
        testId="kpi-trend-table"
        columns={[
          { key: "month", label: "Month" },
          kesCol("revenue_odoo", "Revenue"),
          kesCol("gross_profit", "Gross Profit"),
          pctCol("gross_margin", "Gross Margin"),
          kesCol("operating_income", "Operating Income"),
          kesCol("net_profit", "Net Profit"),
        ]}
      />
    </div>
  );
}
