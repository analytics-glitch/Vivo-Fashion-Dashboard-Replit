import React, { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Coins, ChartLineUp, ArrowsLeftRight } from "@phosphor-icons/react";
import { fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import {
  usePlDetail, DataTableCard, ChartCard, HonestyTags, Money, kesCol, pctCol,
  monthLabel, sumKey, num, fmtKES, fmtKESLong, fmtPct,
} from "./shared";

// Revenue Analysis: Odoo-recognised revenue vs the sales pipeline, monthly, plus
// the revenue account breakdown for the window.
export default function RevenueReport({ months, fromMonth, toMonth }) {
  const { detail } = usePlDetail(fromMonth, toMonth);

  const totals = useMemo(() => {
    const odoo = sumKey(months, "revenue_odoo");
    const pipeline = sumKey(months, "net_revenue_pipeline");
    return { odoo, pipeline, variance: odoo - pipeline };
  }, [months]);

  const trend = useMemo(
    () =>
      months.map((m) => ({
        month: monthLabel(m.month),
        revenue_odoo: num(m.revenue_odoo),
        net_revenue_pipeline: num(m.net_revenue_pipeline),
      })),
    [months]
  );

  const accounts = useMemo(
    () =>
      detail
        .filter((d) => d.pl_section === "revenue")
        .map((d) => ({ ...d, _key: d.account_code }))
        .sort((a, b) => num(b.amount) - num(a.amount)),
    [detail]
  );
  const acctTotal = sumKey(accounts, "amount");

  return (
    <div className="space-y-4" data-testid="finance-revenue">
      <div className="flex justify-end"><HonestyTags rows={months} /></div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KPICard label="Revenue (Odoo)" value={fmtKES(totals.odoo)} valueFull={fmtKESLong(totals.odoo)} icon={Coins} accent showDelta={false} />
        <KPICard label="Net Revenue (Pipeline)" value={fmtKES(totals.pipeline)} valueFull={fmtKESLong(totals.pipeline)} icon={ChartLineUp} showDelta={false} />
        <KPICard
          label="Odoo vs Pipeline"
          value={fmtKES(totals.variance)}
          valueFull={fmtKESLong(totals.variance)}
          sub={totals.pipeline ? fmtPct((totals.variance / totals.pipeline) * 100) + " vs pipeline" : null}
          icon={ArrowsLeftRight}
          showDelta={false}
        />
      </div>

      <ChartCard title="Revenue — Odoo vs Pipeline by Month" subtitle="Odoo-recognised revenue (bars) against the sales pipeline (line), KES." testId="revenue-trend">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={trend} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} width={56} />
            <Tooltip formatter={(v) => fmtKESLong(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue_odoo" name="Revenue (Odoo)" fill="#1a5c38" radius={[3, 3, 0, 0]} maxBarSize={42} />
            <Line type="monotone" dataKey="net_revenue_pipeline" name="Net Revenue (Pipeline)" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <DataTableCard
        title="Revenue by Account"
        subtitle="Odoo revenue accounts over the selected period (credit − debit), KES."
        filename="finance-revenue-accounts.csv"
        rows={accounts}
        testId="revenue-accounts"
        columns={[
          { key: "account_code", label: "Code", render: (r) => <span className="text-muted text-[12px]">{r.account_code}</span> },
          { key: "account_name", label: "Account" },
          kesCol("amount", "Amount"),
          pctCol("share", "% of Revenue", { value: (r) => (acctTotal ? (num(r.amount) / acctTotal) * 100 : null) }),
        ]}
      />
    </div>
  );
}
