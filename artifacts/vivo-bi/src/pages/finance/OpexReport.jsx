import React, { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Wallet, Percent } from "@phosphor-icons/react";
import { fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import {
  usePlDetail, DataTableCard, ChartCard, HonestyTags, kesCol, pctCol,
  OPEX_GROUPS, GROUP_LABELS, monthLabel, sumKey, num, fmtKES, fmtKESLong, fmtPct,
} from "./shared";

// Operating Expenses: the seven opex groups, monthly trend and account detail.
export default function OpexReport({ months, fromMonth, toMonth }) {
  const { detail } = usePlDetail(fromMonth, toMonth);

  const totalOpex = sumKey(months, "total_operating_expenses");
  const totalRev = sumKey(months, "revenue_odoo");

  const groups = useMemo(
    () =>
      OPEX_GROUPS.map((g) => ({ _key: g.key, group: g.label, amount: sumKey(months, g.key) }))
        .filter((g) => g.amount !== 0)
        .sort((a, b) => num(b.amount) - num(a.amount)),
    [months]
  );

  const trend = useMemo(
    () => months.map((m) => ({ month: monthLabel(m.month), total: num(m.total_operating_expenses) })),
    [months]
  );

  const accounts = useMemo(
    () =>
      detail
        .filter((d) => d.pl_section === "operating_expenses")
        .map((d) => ({ ...d, _key: d.account_code, group_label: GROUP_LABELS[d.pl_group] || d.pl_group }))
        .sort((a, b) => num(b.amount) - num(a.amount)),
    [detail]
  );

  return (
    <div className="space-y-4" data-testid="finance-opex">
      <div className="flex justify-end"><HonestyTags rows={months} /></div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KPICard label="Total Operating Expenses" value={fmtKES(totalOpex)} valueFull={fmtKESLong(totalOpex)} icon={Wallet} accent showDelta={false} />
        <KPICard label="% of Revenue" value={totalRev ? fmtPct((totalOpex / totalRev) * 100) : "—"} icon={Percent} showDelta={false} />
        <KPICard label="Expense Groups" value={String(groups.length)} sub="Of 7 opex categories" showDelta={false} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Operating Expenses by Group" subtitle="Summed over the selected period, KES." testId="opex-by-group">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={groups} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" horizontal={false} />
              <XAxis type="number" tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="group" tick={{ fontSize: 11 }} width={140} />
              <Tooltip formatter={(v) => fmtKESLong(v)} />
              <Bar dataKey="amount" name="Opex" fill="#7c3aed" radius={[0, 3, 3, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Total Operating Expenses by Month" subtitle="KES, selected period." testId="opex-trend">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
              <Tooltip formatter={(v) => fmtKESLong(v)} />
              <Bar dataKey="total" name="Operating Expenses" fill="#1a5c38" radius={[3, 3, 0, 0]} maxBarSize={42} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <DataTableCard
        title="Operating Expenses by Group"
        subtitle="Summed over the selected period, KES."
        filename="finance-opex-groups.csv"
        rows={groups}
        testId="opex-groups"
        columns={[
          { key: "group", label: "Group" },
          kesCol("amount", "Amount", { strong: true }),
          pctCol("share", "% of Total", { value: (r) => (totalOpex ? (num(r.amount) / totalOpex) * 100 : null) }),
        ]}
      />

      <DataTableCard
        title="Operating Expenses by Account"
        subtitle="Account-level detail (debit − credit) for the selected period, KES."
        filename="finance-opex-accounts.csv"
        rows={accounts}
        testId="opex-accounts"
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
