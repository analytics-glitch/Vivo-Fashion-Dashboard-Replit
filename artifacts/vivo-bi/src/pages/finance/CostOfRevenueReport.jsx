import React, { useMemo } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Stack, Percent } from "@phosphor-icons/react";
import { fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import {
  usePlDetail, DataTableCard, ChartCard, HonestyTags, kesCol, pctCol,
  COST_GROUPS, GROUP_LABELS, COLORS, monthLabel, sumKey, num, fmtKES, fmtKESLong, fmtPct,
} from "./shared";

// Cost of Revenue: COGS / Production / Purchases breakdown, monthly trend and
// the account-level detail. April 2026 carries a cost anomaly — surfaced, not
// hidden.
export default function CostOfRevenueReport({ months, fromMonth, toMonth }) {
  const { detail } = usePlDetail(fromMonth, toMonth);

  const totalCost = sumKey(months, "total_costs_of_revenue");
  const totalRev = sumKey(months, "revenue_odoo");

  const groups = useMemo(
    () =>
      COST_GROUPS.map((g) => ({ _key: g.key, group: g.label, amount: sumKey(months, g.key) }))
        .filter((g) => g.amount !== 0)
        .sort((a, b) => num(b.amount) - num(a.amount)),
    [months]
  );

  const trend = useMemo(
    () => months.map((m) => ({ month: monthLabel(m.month), total: num(m.total_costs_of_revenue), anomaly: m.has_cost_anomaly })),
    [months]
  );

  const accounts = useMemo(
    () =>
      detail
        .filter((d) => d.pl_section === "costs_of_revenue")
        .map((d) => ({ ...d, _key: d.account_code, group_label: GROUP_LABELS[d.pl_group] || d.pl_group }))
        .sort((a, b) => num(b.amount) - num(a.amount)),
    [detail]
  );

  return (
    <div className="space-y-4" data-testid="finance-cost-of-revenue">
      <div className="flex justify-end"><HonestyTags rows={months} /></div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KPICard label="Total Cost of Revenue" value={fmtKES(totalCost)} valueFull={fmtKESLong(totalCost)} icon={Stack} accent showDelta={false} />
        <KPICard label="% of Revenue" value={totalRev ? fmtPct((totalCost / totalRev) * 100) : "—"} icon={Percent} showDelta={false} />
        <KPICard label="Cost Groups" value={String(groups.length)} sub="COGS · Production · Purchases" showDelta={false} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Cost of Revenue Mix" subtitle="Share of total cost of revenue by group." testId="cost-mix">
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={groups} dataKey="amount" nameKey="group" cx="50%" cy="50%" outerRadius={95} innerRadius={55} paddingAngle={2}>
                {groups.map((g, i) => <Cell key={g._key} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => fmtKESLong(v)} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2">
            {groups.map((g, i) => (
              <span key={g._key} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
                {g.group}
              </span>
            ))}
          </div>
        </ChartCard>

        <ChartCard title="Total Cost of Revenue by Month" subtitle="Anomaly months are tinted red." testId="cost-trend">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
              <Tooltip formatter={(v) => fmtKESLong(v)} />
              <Bar dataKey="total" name="Cost of Revenue" radius={[3, 3, 0, 0]} maxBarSize={42}>
                {trend.map((t, i) => <Cell key={i} fill={t.anomaly ? "#dc2626" : "#1a5c38"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <DataTableCard
        title="Cost of Revenue by Group"
        subtitle="Summed over the selected period, KES."
        filename="finance-cost-groups.csv"
        rows={groups}
        testId="cost-groups"
        columns={[
          { key: "group", label: "Group" },
          kesCol("amount", "Amount", { strong: true }),
          pctCol("share", "% of Total", { value: (r) => (totalCost ? (num(r.amount) / totalCost) * 100 : null) }),
        ]}
      />

      <DataTableCard
        title="Cost of Revenue by Account"
        subtitle="Account-level detail (debit − credit) for the selected period, KES."
        filename="finance-cost-accounts.csv"
        rows={accounts}
        testId="cost-accounts"
        columns={[
          { key: "account_code", label: "Code", render: (r) => <span className="text-muted text-[12px]">{r.account_code}</span> },
          { key: "account_name", label: "Account" },
          { key: "group_label", label: "Group" },
          kesCol("amount", "Amount"),
        ]}
      />
    </div>
  );
}
