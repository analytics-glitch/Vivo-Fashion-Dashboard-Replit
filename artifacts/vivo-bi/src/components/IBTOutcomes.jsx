import React, { useEffect, useState } from "react";
import { api, fmtNum, fmtPct } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import SortableTable from "@/components/SortableTable";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { ArrowRight, ChartLineUp, Package, Truck } from "@phosphor-icons/react";

/**
 * IBT Outcomes (B1) — completed transfers with 30/60-day sell-through.
 *
 * Data: GET /api/ibt/outcomes (rows) + /api/ibt/outcomes/summary (KPIs).
 * Rows whose 30-day sell-through is under 30% are highlighted red so
 * leadership can spot destinations that received stock but failed to sell it.
 */
const IBTOutcomes = ({ dataVersion }) => {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.get("/ibt/outcomes", { timeout: 120000 }),
      api.get("/ibt/outcomes/summary", { timeout: 120000 }).catch(() => ({ data: null })),
    ])
      .then(([o, s]) => {
        if (cancelled) return;
        setRows(o.data || []);
        setSummary(s.data || null);
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [dataVersion]);

  const stPill = (v) => {
    if (v == null) return <span className="text-muted/60">—</span>;
    const cls = v < 30 ? "pill-red" : v >= 50 ? "pill-green" : "pill-amber";
    return <span className={cls}>{fmtPct(v)}</span>;
  };

  const columns = [
    {
      key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => (
        <div>
          <div className="font-semibold break-words">{r.style_name}</div>
          <div className="text-[10.5px] text-muted">{r.brand} · {r.subcategory}</div>
        </div>
      ),
    },
    {
      key: "route", label: "Transfer", sortable: false,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]">
          {r.from_store} <ArrowRight size={12} weight="bold" className="text-brand" /> <span className="font-semibold text-brand">{r.to_store}</span>
        </span>
      ),
    },
    {
      key: "actual_units_moved", label: "Units", numeric: true,
      sortValue: (r) => r.actual_units_moved,
      render: (r) => fmtNum(r.actual_units_moved),
    },
    {
      key: "sold_30d", label: "Sold 30d", numeric: true,
      sortValue: (r) => r.sold_30d, render: (r) => fmtNum(r.sold_30d),
    },
    {
      key: "sold_60d", label: "Sold 60d", numeric: true,
      sortValue: (r) => r.sold_60d, render: (r) => fmtNum(r.sold_60d),
    },
    {
      key: "sell_through_30d", label: "Sell-through 30d", numeric: true,
      sortValue: (r) => (r.sell_through_30d == null ? -1 : r.sell_through_30d),
      render: (r) => stPill(r.sell_through_30d),
    },
    {
      key: "sell_through_60d", label: "Sell-through 60d", numeric: true,
      mobileHidden: true,
      sortValue: (r) => (r.sell_through_60d == null ? -1 : r.sell_through_60d),
      render: (r) => stPill(r.sell_through_60d),
    },
  ];

  if (loading) return <Loading label="Loading completed transfer outcomes…" />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-5" data-testid="ibt-outcomes">
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KPICard testId="ibt-outcomes-kpi-transfers" accent label="Completed Transfers"
            value={fmtNum(summary.total_transfers)} icon={Truck} showDelta={false} />
          <KPICard testId="ibt-outcomes-kpi-units" label="Units Moved"
            value={fmtNum(summary.total_units_moved)} icon={Package} showDelta={false} />
          <KPICard testId="ibt-outcomes-kpi-st30" label="Avg Sell-Through 30d"
            value={fmtPct(summary.avg_sell_through_30d)} icon={ChartLineUp} showDelta={false} />
          <KPICard testId="ibt-outcomes-kpi-st60" label="Avg Sell-Through 60d"
            value={fmtPct(summary.avg_sell_through_60d)} showDelta={false} />
        </div>
      )}

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title={`Completed transfers · ${rows.length}`}
          subtitle="How well did moved stock actually sell at its destination? Rows below 30% 30-day sell-through are flagged red."
        />
        {rows.length === 0 ? (
          <Empty label="No completed transfers yet. Mark transfers as done to start tracking outcomes." />
        ) : (
          <SortableTable
            columns={columns}
            rows={rows}
            exportName="ibt-outcomes.csv"
            testId="ibt-outcomes-table"
            mobileCards
            initialSort={{ key: "sell_through_30d", dir: "asc" }}
            rowClassName={(r) =>
              r.sell_through_30d != null && r.sell_through_30d < 30
                ? "bg-rose-50/70"
                : ""
            }
          />
        )}
      </div>
    </div>
  );
};

export default IBTOutcomes;
