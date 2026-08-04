import React, { useEffect, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { CaretDown, CaretUp, Package } from "@phosphor-icons/react";

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
};

const RANGES = [7, 14, 30, 60, 90];

function weekdayOf(dayIso) {
  try {
    return new Date(dayIso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" });
  } catch {
    return "";
  }
}
function fmtDay(dayIso) {
  try {
    return new Date(dayIso + "T00:00:00").toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dayIso;
  }
}

/**
 * Daily report of stock moved from Finished Goods Production (FGPRD) into
 * Warehouse Finished Goods (WHFIN), by transfer completion date (EAT).
 * Shared by the Stock Movement page and the Inventory Management tab.
 */
const FinishingToWarehouse = () => {
  const [rangeDays, setRangeDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedDay, setExpandedDay] = useState(null);
  const [drills, setDrills] = useState({});
  const [drillLoading, setDrillLoading] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setExpandedDay(null);
    api
      .get("/analytics/finishing-to-warehouse", {
        params: { date_from: daysAgo(rangeDays - 1), date_to: isoDate(new Date()) },
        forceFresh: true,
      })
      .then((r) => {
        if (alive) setData(r.data);
      })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.detail || e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [rangeDays]);

  const toggleDay = (day) => {
    const next = expandedDay === day ? null : day;
    setExpandedDay(next);
    if (next && !drills[day]) {
      setDrillLoading(day);
      api
        .get("/analytics/finishing-to-warehouse", { params: { day }, forceFresh: true })
        .then((r) => setDrills((p) => ({ ...p, [day]: r.data })))
        .catch(() => setDrills((p) => ({ ...p, [day]: { rows: [], error: true } })))
        .finally(() => setDrillLoading((cur) => (cur === day ? null : cur)));
    }
  };

  const days = data?.days || [];
  const totalUnits = data?.total_units || 0;
  const avgPerDay = days.length ? totalUnits / days.length : 0;
  const totalTransfers = days.reduce((a, d) => a + (d.transfers || 0), 0);
  const partialHistory =
    data?.history_from && data?.from && data.history_from > data.from;

  return (
    <div className="card-white p-5" data-testid="f2w-report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle
          title="Finishing → Warehouse (Daily)"
          subtitle="Units moved from Finished Goods Production into Warehouse Finished Goods, by transfer completion date. Click a day to see the styles moved."
        />
        <select
          value={rangeDays}
          onChange={(e) => setRangeDays(Number(e.target.value))}
          className="border border-slate-300 rounded-md px-2.5 py-1.5 text-sm bg-white shrink-0"
          data-testid="f2w-range"
        >
          {RANGES.map((n) => (
            <option key={n} value={n}>
              Last {n} days
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <Loading label="Loading finishing → warehouse transfers…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : !days.length ? (
        <Empty label="No finishing → warehouse transfers completed in this period." />
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2" data-testid="f2w-kpis">
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
              <Package size={16} className="text-emerald-700 shrink-0" />
              <span className="text-[12px] font-semibold text-emerald-700">
                {fmtNum(totalUnits)} units received
              </span>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[12px] font-medium text-slate-600">
              {days.length} active day{days.length !== 1 ? "s" : ""}
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[12px] font-medium text-slate-600">
              {fmtNum(Math.round(avgPerDay))} units/day avg
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[12px] font-medium text-slate-600">
              {fmtNum(totalTransfers)} transfer{totalTransfers !== 1 ? "s" : ""}
            </div>
          </div>
          {partialHistory && (
            <p className="mt-2 text-[11px] text-slate-400">
              Transfer history for this lane is complete from {fmtDay(data.history_from)} onwards.
            </p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">Transfer Date</th>
                  <th className="py-2 pr-3">Day</th>
                  <th className="py-2 pr-3 text-right">Units</th>
                  <th className="py-2 pr-3 text-right">Styles</th>
                  <th className="py-2 pr-3 text-right">SKUs</th>
                  <th className="py-2 pr-3 text-right">Transfers</th>
                  <th className="py-2 pr-0 w-8" />
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const isOpen = expandedDay === d.day;
                  const drill = drills[d.day];
                  return (
                    <React.Fragment key={d.day}>
                      <tr
                        className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                        onClick={() => toggleDay(d.day)}
                        data-testid={`row-f2w-${d.day}`}
                      >
                        <td className="py-1.5 pr-3 font-medium text-slate-700 whitespace-nowrap">
                          {fmtDay(d.day)}
                        </td>
                        <td className="py-1.5 pr-3 text-slate-500">{weekdayOf(d.day)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">
                          {fmtNum(d.units)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(d.styles)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(d.skus)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(d.transfers)}</td>
                        <td className="py-1.5 pr-0 text-slate-400">
                          {isOpen ? <CaretUp size={13} /> : <CaretDown size={13} />}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-slate-100 bg-slate-50/60">
                          <td colSpan={7} className="py-2 pl-6 pr-3">
                            {drillLoading === d.day ? (
                              <Loading label="Loading styles…" />
                            ) : drill?.error ? (
                              <ErrorBox message="Could not load the day's styles." />
                            ) : !drill?.rows?.length ? (
                              <Empty label="No style detail found for this day." />
                            ) : (
                              <table className="min-w-full text-[13px]" data-testid={`f2w-drill-${d.day}`}>
                                <thead>
                                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                                    <th className="py-1.5 pr-3">Style</th>
                                    <th className="py-1.5 pr-3">Category</th>
                                    <th className="py-1.5 pr-3 text-right">SKUs</th>
                                    <th className="py-1.5 pr-0 text-right">Units</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {drill.rows.map((r, i) => (
                                    <tr key={i} className="border-b border-slate-100 last:border-0">
                                      <td className="py-1 pr-3 text-slate-700">{r.style_name}</td>
                                      <td className="py-1 pr-3 text-slate-500">{r.category || "—"}</td>
                                      <td className="py-1 pr-3 text-right tabular-nums">{fmtNum(r.skus)}</td>
                                      <td className="py-1 pr-0 text-right tabular-nums font-medium">
                                        {fmtNum(r.units)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-300 font-semibold text-slate-800">
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3" />
                  <td className="py-2 pr-3 text-right tabular-nums" data-testid="f2w-total-units">
                    {fmtNum(totalUnits)}
                  </td>
                  <td className="py-2 pr-3" />
                  <td className="py-2 pr-3" />
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(totalTransfers)}</td>
                  <td className="py-2 pr-0" />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default FinishingToWarehouse;
