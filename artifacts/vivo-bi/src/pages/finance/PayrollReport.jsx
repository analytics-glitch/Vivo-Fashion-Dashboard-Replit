import React, { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { UsersThree, Percent, Calendar } from "@phosphor-icons/react";
import { fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import {
  usePlDetail, DataTableCard, ChartCard, HonestyTags, Tag, kesCol, pctCol,
  monthLabel, sumKey, num, fmtKES, fmtKESLong, fmtPct,
} from "./shared";

// Payroll / Employment costs: the Employment opex group, monthly trend and the
// underlying employment accounts. Employment is the journaled payroll proxy.
export default function PayrollReport({ months, fromMonth, toMonth }) {
  const { detail } = usePlDetail(fromMonth, toMonth);

  const total = sumKey(months, "employment");
  const totalOpex = sumKey(months, "total_operating_expenses");
  const activeMonths = months.filter((m) => num(m.employment) !== 0).length || months.length || 1;

  const trend = useMemo(
    () => months.map((m) => ({ month: monthLabel(m.month), employment: num(m.employment) })),
    [months]
  );

  const accounts = useMemo(
    () =>
      detail
        .filter((d) => d.pl_group === "employment")
        .map((d) => ({ ...d, _key: d.account_code }))
        .sort((a, b) => num(b.amount) - num(a.amount)),
    [detail]
  );

  return (
    <div className="space-y-4" data-testid="finance-payroll">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tag tone="slate" title="Employment accounts journaled in Odoo are used as the payroll proxy.">
          Employment accounts (journaled)
        </Tag>
        <HonestyTags rows={months} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KPICard label="Total Employment Cost" value={fmtKES(total)} valueFull={fmtKESLong(total)} icon={UsersThree} accent showDelta={false} />
        <KPICard label="Avg / Month" value={fmtKES(total / activeMonths)} valueFull={fmtKESLong(total / activeMonths)} icon={Calendar} showDelta={false} />
        <KPICard label="% of Operating Expenses" value={totalOpex ? fmtPct((total / totalOpex) * 100) : "—"} icon={Percent} showDelta={false} />
      </div>

      <ChartCard title="Employment Cost by Month" subtitle="Journaled employment accounts, KES." testId="payroll-trend">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
            <Tooltip formatter={(v) => fmtKESLong(v)} />
            <Bar dataKey="employment" name="Employment" fill="#1a5c38" radius={[3, 3, 0, 0]} maxBarSize={42} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <DataTableCard
        title="Employment by Account"
        subtitle="Account-level detail (debit − credit) for the selected period, KES."
        filename="finance-payroll-accounts.csv"
        rows={accounts}
        testId="payroll-accounts"
        columns={[
          { key: "account_code", label: "Code", render: (r) => <span className="text-muted text-[12px]">{r.account_code}</span> },
          { key: "account_name", label: "Account" },
          kesCol("amount", "Amount"),
          pctCol("share", "% of Employment", { value: (r) => (total ? (num(r.amount) / total) * 100 : null) }),
        ]}
      />
    </div>
  );
}
