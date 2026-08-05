import React, { useEffect, useState } from "react";
import { api, fmtNum, fmtKES } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { ArrowRight, CheckCircle, Warning, Timer, ArrowsLeftRight } from "@phosphor-icons/react";

const DAY_OPTIONS = [
  { label: "30 days", value: 30 },
  { label: "60 days", value: 60 },
  { label: "90 days", value: 90 },
  { label: "180 days", value: 180 },
];

function KpiCard({ icon, label, value, sub, tone }) {
  const tones = {
    green:  "bg-emerald-50 border-emerald-200 text-emerald-800",
    amber:  "bg-amber-50 border-amber-200 text-amber-800",
    blue:   "bg-blue-50 border-blue-200 text-blue-800",
    slate:  "bg-slate-50 border-slate-200 text-slate-700",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone] || tones.slate}`}>
      <div className="flex items-center gap-2 mb-1 text-[11px] font-bold uppercase tracking-wide opacity-70">
        {icon}
        {label}
      </div>
      <div className="text-[22px] font-extrabold tabular-nums">{value ?? "—"}</div>
      {sub && <div className="text-[11px] mt-0.5 opacity-60">{sub}</div>}
    </div>
  );
}

export default function IBTDoneReport() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState("corridors"); // corridors | weeks | stores

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    api.get("/ibt/done-report", { params: { days }, forceFresh: true, timeout: 30000 })
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const s = data?.summary || {};
  const discRate = s.consignments > 0
    ? `${((s.discrepancies / s.consignments) * 100).toFixed(1)}%`
    : "0%";
  const receiveRate = s.dispatched > 0
    ? `${((s.received / s.dispatched) * 100).toFixed(1)}%`
    : "—";

  return (
    <div className="card-white p-5 space-y-5" data-testid="ibt-done-report">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <SectionTitle
          title={
            <span className="inline-flex items-center gap-2">
              <CheckCircle size={16} weight="duotone" className="text-emerald-600" />
              IBT Done Report
            </span>
          }
          subtitle="Aggregate view of every completed (received + discrepancy) consignment. Use to measure throughput, identify busy corridors and track transit times."
        />
        <div className="flex gap-1.5">
          {DAY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setDays(o.value)}
              className={`px-2.5 py-1 text-[11.5px] font-semibold rounded-lg border transition-colors ${
                days === o.value
                  ? "bg-brand text-white border-brand"
                  : "bg-white text-muted border-border hover:border-brand/40"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <Loading label="Loading IBT report…" />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard
              icon={<ArrowsLeftRight size={12} />}
              label="Consignments done"
              value={fmtNum(s.consignments)}
              sub={`across ${s.donor_count} donors → ${s.recipient_count} recipients`}
              tone="blue"
            />
            <KpiCard
              icon={<CheckCircle size={12} />}
              label="Units received"
              value={fmtNum(s.received)}
              sub={`${receiveRate} of ${fmtNum(s.dispatched)} dispatched`}
              tone="green"
            />
            <KpiCard
              icon={<Timer size={12} />}
              label="Avg transit days"
              value={s.avg_days_lapsed != null ? `${s.avg_days_lapsed}d` : "—"}
              sub="dispatch → receive"
              tone={s.avg_days_lapsed > 3 ? "amber" : "green"}
            />
            <KpiCard
              icon={<Warning size={12} />}
              label="Discrepancy rate"
              value={discRate}
              sub={`${fmtNum(s.discrepancies)} flagged consignments`}
              tone={s.discrepancies > 0 ? "amber" : "green"}
            />
          </div>

          {/* Sub-view tabs */}
          <div className="flex gap-1.5 border-b border-border">
            {[
              { id: "corridors", label: "By Corridor" },
              { id: "weeks",     label: "By Week" },
              { id: "stores",    label: "By Store" },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setView(t.id)}
                className={`px-3 py-1.5 text-[12.5px] font-medium border-b-2 -mb-px transition-colors ${
                  view === t.id
                    ? "border-brand text-brand"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* By Corridor */}
          {view === "corridors" && (
            data.by_corridor.length === 0
              ? <Empty label="No completed consignments in this window." />
              : (
                <SortableTable
                  testId="ibt-done-corridors"
                  exportName="ibt-done-corridors.csv"
                  pageSize={50}
                  initialSort={{ key: "dispatched", dir: "desc" }}
                  rows={data.by_corridor}
                  columns={[
                    {
                      key: "from_store", label: "From", align: "left", mobilePrimary: true,
                      render: (r) => (
                        <div className="flex items-center gap-1.5 text-[12px]">
                          <span className="font-semibold">{r.from_store}</span>
                          <ArrowRight size={11} className="text-brand" weight="bold" />
                          <span className="font-bold text-brand">{r.to_store}</span>
                        </div>
                      ),
                      csv: (r) => `${r.from_store} → ${r.to_store}`,
                    },
                    { key: "consignments", label: "Trips", numeric: true, render: (r) => <span className="num">{fmtNum(r.consignments)}</span> },
                    { key: "dispatched", label: "Dispatched", numeric: true, render: (r) => <span className="num font-bold">{fmtNum(r.dispatched)}</span> },
                    { key: "received",   label: "Received",   numeric: true,
                      render: (r) => (
                        <span className={`num font-bold ${r.received < r.dispatched ? "text-amber-700" : "text-emerald-700"}`}>
                          {fmtNum(r.received)}
                        </span>
                      ),
                    },
                    {
                      key: "discrepancies", label: "Disc.", numeric: true,
                      render: (r) => r.discrepancies > 0
                        ? <span className="pill-amber text-[11px]">{fmtNum(r.discrepancies)}</span>
                        : <span className="text-muted text-[11px]">—</span>,
                    },
                    {
                      key: "avg_days", label: "Avg days", numeric: true,
                      render: (r) => {
                        if (r.avg_days == null) return <span className="text-muted">—</span>;
                        const cls = r.avg_days <= 1 ? "text-emerald-700" : r.avg_days <= 3 ? "text-amber-700" : "text-red-700";
                        return <span className={`num font-semibold ${cls}`}>{r.avg_days}d</span>;
                      },
                    },
                    {
                      key: "value_kes", label: "Value (KES)", numeric: true,
                      render: (r) => <span className="num text-[11.5px]">{fmtKES(r.value_kes)}</span>,
                      csv: (r) => r.value_kes,
                    },
                  ]}
                />
              )
          )}

          {/* By Week */}
          {view === "weeks" && (
            data.by_week.length === 0
              ? <Empty label="No weekly data in this window." />
              : (
                <SortableTable
                  testId="ibt-done-weeks"
                  exportName="ibt-done-weekly.csv"
                  pageSize={26}
                  initialSort={{ key: "wk", dir: "desc" }}
                  rows={data.by_week}
                  columns={[
                    {
                      key: "wk", label: "Week of", align: "left", mobilePrimary: true,
                      render: (r) => <span className="font-semibold text-[12px]">{r.wk}</span>,
                    },
                    { key: "consignments", label: "Consignments", numeric: true, render: (r) => <span className="num">{fmtNum(r.consignments)}</span> },
                    { key: "dispatched",   label: "Dispatched",   numeric: true, render: (r) => <span className="num font-bold">{fmtNum(r.dispatched)}</span> },
                    {
                      key: "received", label: "Received", numeric: true,
                      render: (r) => {
                        const rate = r.dispatched > 0 ? Math.round(r.received / r.dispatched * 100) : null;
                        return (
                          <span className="num font-bold">
                            {fmtNum(r.received)}
                            {rate != null && <span className="text-[10px] text-muted ml-1">({rate}%)</span>}
                          </span>
                        );
                      },
                    },
                    {
                      key: "discrepancies", label: "Discrepancies", numeric: true,
                      render: (r) => r.discrepancies > 0
                        ? <span className="pill-amber text-[11px]">{r.discrepancies}</span>
                        : <span className="text-muted text-[11px]">0</span>,
                    },
                  ]}
                />
              )
          )}

          {/* By Store */}
          {view === "stores" && (
            data.by_store.length === 0
              ? <Empty label="No store data in this window." />
              : (
                <SortableTable
                  testId="ibt-done-stores"
                  exportName="ibt-done-by-store.csv"
                  pageSize={50}
                  initialSort={{ key: "units", dir: "desc" }}
                  rows={data.by_store}
                  columns={[
                    {
                      key: "store", label: "Store", align: "left", mobilePrimary: true,
                      render: (r) => <span className="font-semibold text-[12px]">{r.store}</span>,
                    },
                    {
                      key: "role", label: "Role", align: "left",
                      render: (r) => r.role === "donor"
                        ? <span className="pill-neutral text-[11px]">Donor</span>
                        : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800">Recipient</span>,
                    },
                    { key: "consignments", label: "Consignments", numeric: true, render: (r) => <span className="num">{fmtNum(r.consignments)}</span> },
                    { key: "units",        label: "Units",        numeric: true, render: (r) => <span className="num font-bold">{fmtNum(r.units)}</span> },
                  ]}
                />
              )
          )}
        </>
      )}
    </div>
  );
}
