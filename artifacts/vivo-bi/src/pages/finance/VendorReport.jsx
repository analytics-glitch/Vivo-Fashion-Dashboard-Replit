import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Buildings, Receipt } from "@phosphor-icons/react";
import { api, buildParams, fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox } from "@/components/common";
import {
  DataTableCard, ChartCard, HonestyTags, kesCol, pctCol,
  COST_GROUPS, OPEX_GROUPS, GROUP_LABELS, num, fmtKES, fmtKESLong, fmtPct,
} from "./shared";

const CATEGORIES = [{ group: "", label: "All categories" }, ...COST_GROUPS, ...OPEX_GROUPS];

// Vendor Spend: top partners by spend for the window, optionally scoped to a
// single P&L group (whitelisted server-side).
export default function VendorReport({ months, fromMonth, toMonth }) {
  const [category, setCategory] = useState("");
  const [data, setData] = useState({ vendors: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/finance/expense-by-vendor", {
        params: buildParams({ dateFrom: fromMonth, dateTo: toMonth, category: category || undefined }),
      })
      .then((r) => !cancelled && setData(r.data || { vendors: [] }))
      .catch((e) => !cancelled && setError(e?.message || "Failed to load vendor spend"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fromMonth, toMonth, category]);

  const vendors = useMemo(
    () =>
      (data.vendors || [])
        .map((v) => ({ ...v, _key: v.vendor }))
        .sort((a, b) => num(b.spend) - num(a.spend)),
    [data]
  );
  const total = useMemo(() => vendors.reduce((s, v) => s + num(v.spend), 0), [vendors]);
  const top = vendors.slice(0, 15).map((v) => ({ name: v.vendor, spend: num(v.spend) }));

  return (
    <div className="space-y-4" data-testid="finance-vendor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-muted">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            data-testid="vendor-category"
            className="text-[12.5px] border border-border rounded px-2 py-1 bg-white"
          >
            {CATEGORIES.map((c) => (
              <option key={c.group || "all"} value={c.group}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <HonestyTags rows={months} />
      </div>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <KPICard label="Total Vendor Spend" value={fmtKES(total)} valueFull={fmtKESLong(total)} icon={Receipt} accent showDelta={false} />
            <KPICard label="Vendors" value={String(vendors.length)} icon={Buildings} showDelta={false} />
            <KPICard label="Top Vendor" value={vendors[0]?.vendor || "—"} sub={vendors[0] ? fmtKESLong(num(vendors[0].spend)) : null} showDelta={false} />
          </div>

          <ChartCard
            title="Top 15 Vendors by Spend"
            subtitle={`${category ? GROUP_LABELS[category] : "All categories"} · selected period, KES.`}
            testId="vendor-chart"
          >
            <ResponsiveContainer width="100%" height={Math.max(260, top.length * 26)}>
              <BarChart data={top} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" horizontal={false} />
                <XAxis type="number" tickFormatter={fmtAxisKES} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10.5 }} width={170} />
                <Tooltip formatter={(v) => fmtKESLong(v)} />
                <Bar dataKey="spend" name="Spend" fill="#1a5c38" radius={[0, 3, 3, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DataTableCard
            title="Vendor Spend"
            subtitle="Partners ranked by spend (debit − credit on expense accounts), KES."
            filename="finance-vendor-spend.csv"
            rows={vendors}
            testId="vendor-table"
            columns={[
              { key: "vendor", label: "Vendor" },
              kesCol("spend", "Spend", { strong: true }),
              pctCol("share", "% of Total", { value: (r) => (total ? (num(r.spend) / total) * 100 : null) }),
            ]}
          />
        </>
      )}
    </div>
  );
}
