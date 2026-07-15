import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { ArrowsClockwise, DownloadSimple, Storefront, Basket, Truck, Package } from "@phosphor-icons/react";

const COUNTRIES = ["", "Kenya", "Uganda", "Rwanda", "Online"];

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // Local-time format (EAT) to avoid the off-by-one around midnight.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Store Flow — per POS location over a custom period: Units Sold, Units
 * Transferred In (completed incoming stock transfers), units still in
 * transit, and Current Stock. Backed by /api/analytics/store-flow
 * (all_sales + stock_transfers + all_inventory).
 */
const StoreFlow = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateFrom, setDateFrom] = useState(isoDaysAgo(30));
  const [dateTo, setDateTo] = useState(isoDaysAgo(0));
  const [country, setCountry] = useState("");
  const [search, setSearch] = useState("");

  const load = (forceFresh = false) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { date_from: dateFrom, date_to: dateTo };
    if (country) params.country = country;
    api
      .get("/analytics/store-flow", { params, timeout: 240000, forceFresh })
      .then(({ data }) => { if (!cancelled) setData(data); })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e.message || "Failed to load store flow");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  };

  useEffect(() => {
    const cancel = load();
    return cancel;
    // eslint-disable-next-line
  }, [dateFrom, dateTo, country]);

  const rows = data?.rows || [];
  const totals = data?.totals || {};
  const historyFrom = data?.transfer_history_from;
  const historyGap = historyFrom && dateFrom < historyFrom;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.pos_location || "").toLowerCase().includes(q));
  }, [rows, search]);

  // WOC table: SOH descending; WOC uses the last 4 weeks' sales regardless
  // of the selected period (weekly rate = units_4w / 4).
  const wocRows = useMemo(
    () => [...filtered].sort((a, b) => b.current_stock - a.current_stock),
    [filtered],
  );
  const wocColor = (w) =>
    w == null ? "text-slate-400" : w < 4 ? "text-red-600" : w > 16 ? "text-amber-600" : "text-slate-800";
  const totalWoc = useMemo(() => {
    const soh = wocRows.reduce((a, r) => a + r.current_stock, 0);
    const weekly = wocRows.reduce((a, r) => a + (r.units_4w || 0), 0) / 4;
    return weekly > 0 ? Math.round((soh / weekly) * 10) / 10 : null;
  }, [wocRows]);

  const setPreset = (days) => {
    setDateFrom(isoDaysAgo(days));
    setDateTo(isoDaysAgo(0));
  };

  const exportCsv = () => {
    const header = ["POS Location", "Country", "Units Sold", "Units Transferred", "In Transit", "Current Stock"];
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(",")];
    for (const r of filtered) {
      lines.push([r.pos_location, r.country, r.units_sold, r.units_transferred, r.units_incoming, r.current_stock].map(esc).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `store-flow-${dateFrom}-to-${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5" data-testid="store-flow">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <SectionTitle
          title="Store Flow"
          subtitle="Per store over the selected period: units sold vs units transferred in, plus stock in transit and current stock on hand"
        />
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => load(true)}
            data-testid="button-refresh"
          >
            <ArrowsClockwise size={15} /> Refresh
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={exportCsv}
            disabled={!filtered.length}
            data-testid="button-export-csv"
          >
            <DownloadSimple size={15} /> Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card-white p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600">
          From{" "}
          <input
            type="date"
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="input-date-from"
          />
        </label>
        <label className="text-sm text-slate-600">
          To{" "}
          <input
            type="date"
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="input-date-to"
          />
        </label>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              onClick={() => setPreset(d)}
              data-testid={`button-preset-${d}`}
            >
              {d}d
            </button>
          ))}
        </div>
        <label className="text-sm text-slate-600">
          Country{" "}
          <select
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            data-testid="select-country"
          >
            {COUNTRIES.map((c) => (
              <option key={c || "all"} value={c}>{c || "All countries"}</option>
            ))}
          </select>
        </label>
        <input
          className="flex-1 min-w-[180px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="Search store…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-search"
        />
      </div>

      {historyGap && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800" data-testid="banner-history-gap">
          Transfer tracking started on <strong>{historyFrom}</strong> — the Units Transferred column only counts
          transfers completed on or after that date, so earlier parts of this period show no transfer units.
        </div>
      )}

      {loading ? (
        <Loading label="Computing store flow…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Basket size={14} /> Units Sold</div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-units-sold">{fmtNum(totals.units_sold || 0)}</div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Truck size={14} /> Units Transferred</div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-units-transferred">{fmtNum(totals.units_transferred || 0)}</div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Truck size={14} /> In Transit</div>
              <div className="mt-1 text-2xl font-semibold text-sky-600" data-testid="text-units-incoming">{fmtNum(totals.units_incoming || 0)}</div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Package size={14} /> Current Stock</div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-current-stock">{fmtNum(totals.current_stock || 0)}</div>
            </div>
          </div>

          {/* Table */}
          <div className="card-white p-5">
            <SectionTitle
              title="By POS Location"
              subtitle={`${fmtNum(filtered.length)} stores · ${dateFrom} → ${dateTo}`}
            />
            {!filtered.length ? (
              <Empty label="No stores match the selected filters." />
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4"><span className="inline-flex items-center gap-1"><Storefront size={13} /> POS Location</span></th>
                      <th className="py-2 pr-4">Country</th>
                      <th className="py-2 pr-4 text-right">Units Sold</th>
                      <th className="py-2 pr-4 text-right">Units Transferred</th>
                      <th className="py-2 pr-4 text-right">In Transit</th>
                      <th className="py-2 pr-4 text-right">Current Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-store-${r.pos_location}`}>
                        <td className="py-1.5 pr-4 font-medium text-slate-700 whitespace-nowrap">{r.pos_location}</td>
                        <td className="py-1.5 pr-4 text-slate-500">{r.country || "—"}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(r.units_sold)}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(r.units_transferred)}</td>
                        <td className={"py-1.5 pr-4 text-right " + (r.units_incoming > 0 ? "text-sky-600 font-medium" : "text-slate-400")}>{fmtNum(r.units_incoming)}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(r.current_stock)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 pr-4" />
                      <td className="py-2 pr-4 text-right">{fmtNum(filtered.reduce((a, r) => a + r.units_sold, 0))}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(filtered.reduce((a, r) => a + r.units_transferred, 0))}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(filtered.reduce((a, r) => a + r.units_incoming, 0))}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(filtered.reduce((a, r) => a + r.current_stock, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
          {/* SOH & WOC table */}
          <div className="card-white p-5">
            <SectionTitle
              title="Stock Cover (WOC)"
              subtitle="Per store: stock on hand vs weeks of cover, using average weekly sales over the last 4 weeks"
            />
            {!filtered.length ? (
              <Empty label="No stores match the selected filters." />
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4"><span className="inline-flex items-center gap-1"><Storefront size={13} /> POS Location</span></th>
                      <th className="py-2 pr-4">Country</th>
                      <th className="py-2 pr-4 text-right">SOH</th>
                      <th className="py-2 pr-4 text-right">Units Sold (4W)</th>
                      <th className="py-2 pr-4 text-right">Weekly Rate</th>
                      <th className="py-2 pr-4 text-right">WOC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wocRows.map((r) => (
                      <tr key={r.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-woc-${r.pos_location}`}>
                        <td className="py-1.5 pr-4 font-medium text-slate-700 whitespace-nowrap">{r.pos_location}</td>
                        <td className="py-1.5 pr-4 text-slate-500">{r.country || "—"}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(r.current_stock)}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(r.units_4w || 0)}</td>
                        <td className="py-1.5 pr-4 text-right">{r.units_4w ? fmtNum(Math.round(r.units_4w / 4)) : "—"}</td>
                        <td className={"py-1.5 pr-4 text-right font-medium " + wocColor(r.woc)}>
                          {r.woc == null ? "—" : r.woc.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 pr-4" />
                      <td className="py-2 pr-4 text-right">{fmtNum(wocRows.reduce((a, r) => a + r.current_stock, 0))}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(wocRows.reduce((a, r) => a + (r.units_4w || 0), 0))}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(Math.round(wocRows.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}</td>
                      <td className="py-2 pr-4 text-right">{totalWoc == null ? "—" : totalWoc.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default StoreFlow;
