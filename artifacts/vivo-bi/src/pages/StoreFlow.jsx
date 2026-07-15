import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { ArrowsClockwise, DownloadSimple, Storefront, Basket, Truck, Package, CalendarCheck } from "@phosphor-icons/react";

const COUNTRIES = ["", "Kenya", "Uganda", "Rwanda", "Online"];

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // index 0=Mon(1)…6=Sun(7)

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const isoDaysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d);
};
function getLastWeekRange() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0=Mon
  const thisMonday = new Date(d); thisMonday.setDate(d.getDate() - dow);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday); lastSunday.setDate(lastMonday.getDate() + 6);
  return { from: isoDate(lastMonday), to: isoDate(lastSunday) };
}
function getThisWeekRange() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;
  const thisMonday = new Date(d); thisMonday.setDate(d.getDate() - dow);
  return { from: isoDate(thisMonday), to: isoDate(d) };
}

/**
 * Transfer pacing: compare units_transferred to prev_week_sold ±10%.
 * Returns { status: "on_track"|"over"|"under"|"none", pct }
 */
function transferPacing(transferred, prevWeekSold) {
  if (!prevWeekSold) return { status: "none", pct: null };
  const pct = prevWeekSold > 0 ? (transferred / prevWeekSold) * 100 : null;
  if (pct === null) return { status: "none", pct: null };
  if (transferred > prevWeekSold * 1.10) return { status: "over", pct };
  if (transferred < prevWeekSold * 0.90) return { status: "under", pct };
  return { status: "on_track", pct };
}

function PacingBadge({ transferred, prevWeekSold }) {
  const { status, pct } = transferPacing(transferred, prevWeekSold);
  if (status === "none") return <span className="text-slate-300">—</span>;
  const pctStr = pct != null ? `${pct.toFixed(0)}%` : "";
  if (status === "over")
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700 ring-1 ring-inset ring-red-200 whitespace-nowrap">Over · {pctStr}</span>;
  if (status === "under")
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200 whitespace-nowrap">Under · {pctStr}</span>;
  return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200 whitespace-nowrap">On track · {pctStr}</span>;
}

const StoreFlow = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateFrom, setDateFrom] = useState(() => getLastWeekRange().from);
  const [dateTo, setDateTo] = useState(() => getLastWeekRange().to);
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
  const prevWeekLabel = data?.prev_week_label;
  const historyFrom = data?.transfer_history_from;
  const historyGap = historyFrom && dateFrom < historyFrom;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.pos_location || "").toLowerCase().includes(q));
  }, [rows, search]);

  // WOC rows sorted by SOH desc
  const wocRows = useMemo(() => [...filtered].sort((a, b) => b.current_stock - a.current_stock), [filtered]);
  const WOC_TARGET = 8, WOC_LO = 7, WOC_HI = 9;
  const wocBand = (w) => w == null ? "none" : w < WOC_LO ? "under" : w > WOC_HI ? "over" : "ok";
  const wocColor = (w) => {
    const b = wocBand(w);
    if (b === "under") return "text-red-600 font-semibold";
    if (b === "over")  return "text-amber-600 font-semibold";
    if (b === "ok")    return "text-emerald-700 font-semibold";
    return "text-slate-400";
  };
  const wocCta = (w) => {
    const b = wocBand(w);
    if (b === "under") return { label: "Replenish", cls: "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700 ring-1 ring-inset ring-red-200" };
    if (b === "over")  return { label: "Reduce stock", cls: "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200" };
    if (b === "ok")    return { label: "On target", cls: "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200" };
    return null;
  };
  const wocSummary = useMemo(() => {
    const counts = { under: 0, ok: 0, over: 0, none: 0 };
    for (const r of wocRows) counts[wocBand(r.woc)]++;
    return counts;
    // eslint-disable-next-line
  }, [wocRows]);
  const totalWoc = useMemo(() => {
    const soh = wocRows.reduce((a, r) => a + r.current_stock, 0);
    const weekly = wocRows.reduce((a, r) => a + (r.units_4w || 0), 0) / 4;
    return weekly > 0 ? Math.round((soh / weekly) * 10) / 10 : null;
  }, [wocRows]);

  // Quick date presets
  const PRESETS = [
    { label: "This week", apply: () => { const r = getThisWeekRange(); setDateFrom(r.from); setDateTo(r.to); } },
    { label: "Last week", apply: () => { const r = getLastWeekRange(); setDateFrom(r.from); setDateTo(r.to); } },
    { label: "30d", apply: () => { setDateFrom(isoDaysAgo(30)); setDateTo(isoDaysAgo(0)); } },
    { label: "90d", apply: () => { setDateFrom(isoDaysAgo(90)); setDateTo(isoDaysAgo(0)); } },
  ];

  const exportCsv = () => {
    const header = [
      "POS Location", "Country",
      "Prev Week Sales", "Avg Weekly (4W)",
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
      "Total Transferred", "vs Prev Week %",
      "Current Stock",
    ];
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [header.join(",")];
    for (const r of filtered) {
      const dt = r.daily_transfers || {};
      const pct = r.prev_week_sold > 0 ? ((r.units_transferred / r.prev_week_sold) * 100).toFixed(1) + "%" : "—";
      lines.push([
        r.pos_location, r.country,
        r.prev_week_sold, Math.round((r.units_4w || 0) / 4),
        dt[1] || 0, dt[2] || 0, dt[3] || 0, dt[4] || 0, dt[5] || 0, dt[6] || 0, dt[7] || 0,
        r.units_transferred, pct,
        r.current_stock,
      ].map(esc).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `store-flow-${dateFrom}-to-${dateTo}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // Totals for the daily footer
  const dailyTotals = useMemo(() => {
    const t = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    for (const r of filtered) {
      const dt = r.daily_transfers || {};
      for (let d = 1; d <= 7; d++) t[d] += dt[d] || 0;
    }
    return t;
  }, [filtered]);

  return (
    <div className="space-y-5" data-testid="store-flow">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <SectionTitle
          title="Store Flow"
          subtitle="Per store: previous week sales vs daily transfers. Target: total transferred within ±10% of the previous week's sales."
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

      {/* ── Filters ── */}
      <div className="card-white p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600">
          From{" "}
          <input type="date" className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} data-testid="input-date-from" />
        </label>
        <label className="text-sm text-slate-600">
          To{" "}
          <input type="date" className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} data-testid="input-date-to" />
        </label>
        <div className="flex items-center gap-1">
          {PRESETS.map(({ label, apply }) => (
            <button key={label} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50" onClick={apply}>
              {label}
            </button>
          ))}
        </div>
        <label className="text-sm text-slate-600">
          Country{" "}
          <select className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={country} onChange={(e) => setCountry(e.target.value)} data-testid="select-country">
            {COUNTRIES.map((c) => <option key={c || "all"} value={c}>{c || "All countries"}</option>)}
          </select>
        </label>
        <input
          className="flex-1 min-w-[180px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="Search store…" value={search} onChange={(e) => setSearch(e.target.value)}
          data-testid="input-search"
        />
      </div>

      {historyGap && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800" data-testid="banner-history-gap">
          Transfer tracking started on <strong>{historyFrom}</strong> — transfers before that date are not captured.
        </div>
      )}

      {loading ? (
        <Loading label="Computing store flow…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          {/* ── Summary cards ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <CalendarCheck size={14} /> Prev Week Sales
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-prev-week-sold">
                {fmtNum(totals.prev_week_sold || 0)}
              </div>
              {prevWeekLabel && <div className="mt-0.5 text-[11px] text-slate-400">{prevWeekLabel}</div>}
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <Basket size={14} /> Avg Weekly Sales (4W)
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-avg-weekly">
                {fmtNum(Math.round(filtered.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}
              </div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <Truck size={14} /> Units Transferred
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-units-transferred">
                {fmtNum(totals.units_transferred || 0)}
              </div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <Package size={14} /> Current Stock
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-current-stock">
                {fmtNum(totals.current_stock || 0)}
              </div>
            </div>
          </div>

          {/* ── By POS Location table ── */}
          <div className="card-white p-5">
            <SectionTitle
              title="By POS Location"
              subtitle={`${fmtNum(filtered.length)} stores · transfers ${dateFrom} → ${dateTo}${prevWeekLabel ? ` · prev week sales ${prevWeekLabel}` : ""}`}
            />
            {!filtered.length ? (
              <Empty label="No stores match the selected filters." />
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-3 sticky left-0 bg-white z-10">
                        <span className="inline-flex items-center gap-1"><Storefront size={13} /> POS Location</span>
                      </th>
                      <th className="py-2 pr-3">Country</th>
                      {/* Benchmark columns */}
                      <th className="py-2 pr-3 text-right text-indigo-600 whitespace-nowrap"
                          title={prevWeekLabel ? `Sales ${prevWeekLabel}` : "Previous Mon–Sun sales"}>
                        Prev Week Sales ⓘ
                      </th>
                      <th className="py-2 pr-3 text-right text-indigo-600 whitespace-nowrap" title="Average weekly units sold over the last 4 weeks">
                        Avg 4W ⓘ
                      </th>
                      {/* Daily transfer columns Mon–Sun */}
                      {DOW_LABELS.map((d) => (
                        <th key={d} className="py-2 pr-2 text-right text-slate-400 font-medium text-[11px]">{d}</th>
                      ))}
                      {/* Totals + pacing */}
                      <th className="py-2 pr-3 text-right font-semibold">Total Transferred</th>
                      <th className="py-2 pr-3 text-right whitespace-nowrap" title="Total transferred vs previous week sales. On track = ±10%. Over = >10% above. Under = >10% below.">
                        vs Prev Week ⓘ
                      </th>
                      <th className="py-2 pr-3 text-right">Current Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => {
                      const dt = r.daily_transfers || {};
                      return (
                        <tr key={r.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-store-${r.pos_location}`}>
                          <td className="py-1.5 pr-3 font-medium text-slate-700 whitespace-nowrap sticky left-0 bg-white">{r.pos_location}</td>
                          <td className="py-1.5 pr-3 text-slate-500">{r.country || "—"}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-700 font-medium">{fmtNum(r.prev_week_sold)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-500">{r.units_4w ? fmtNum(Math.round(r.units_4w / 4)) : "—"}</td>
                          {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
                            <td key={dow} className={"py-1.5 pr-2 text-right tabular-nums text-[12px] " + (dt[dow] ? "text-slate-700" : "text-slate-300")}>
                              {dt[dow] ? fmtNum(dt[dow]) : "—"}
                            </td>
                          ))}
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{fmtNum(r.units_transferred)}</td>
                          <td className="py-1.5 pr-3 text-right">
                            <PacingBadge transferred={r.units_transferred} prevWeekSold={r.prev_week_sold} />
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.current_stock)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="py-2 pr-3 sticky left-0 bg-white">Total</td>
                      <td className="py-2 pr-3" />
                      <td className="py-2 pr-3 text-right tabular-nums text-indigo-700">
                        {fmtNum(filtered.reduce((a, r) => a + (r.prev_week_sold || 0), 0))}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-indigo-500">
                        {fmtNum(Math.round(filtered.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}
                      </td>
                      {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
                        <td key={dow} className={"py-2 pr-2 text-right tabular-nums text-[12px] " + (dailyTotals[dow] ? "text-slate-700" : "text-slate-300")}>
                          {dailyTotals[dow] ? fmtNum(dailyTotals[dow]) : "—"}
                        </td>
                      ))}
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {fmtNum(filtered.reduce((a, r) => a + r.units_transferred, 0))}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <PacingBadge
                          transferred={filtered.reduce((a, r) => a + r.units_transferred, 0)}
                          prevWeekSold={filtered.reduce((a, r) => a + (r.prev_week_sold || 0), 0)}
                        />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {fmtNum(filtered.reduce((a, r) => a + r.current_stock, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* ── Stock Cover (WOC) table ── */}
          <div className="card-white p-5">
            <SectionTitle
              title="Stock Cover (WOC)"
              subtitle={`Per store: stock on hand vs weeks of cover, using average weekly sales over the last 4 weeks. Target = ${WOC_TARGET}w ±1 (${WOC_LO}–${WOC_HI}w). Below ${WOC_LO}w = under-stocked → replenish. Above ${WOC_HI}w = over-stocked → redistribute or return.`}
            />
            {!filtered.length ? (
              <Empty label="No stores match the selected filters." />
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-2" data-testid="woc-summary-strip">
                  {wocSummary.under > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                      <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                      <span className="text-[12px] font-semibold text-red-700">{wocSummary.under} store{wocSummary.under !== 1 ? "s" : ""} under {WOC_LO}w</span>
                      <span className="text-[11px] text-red-500 ml-1">— replenish</span>
                    </div>
                  )}
                  {wocSummary.ok > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <span className="text-[12px] font-semibold text-emerald-700">{wocSummary.ok} store{wocSummary.ok !== 1 ? "s" : ""} on target</span>
                      <span className="text-[11px] text-emerald-500 ml-1">({WOC_LO}–{WOC_HI}w)</span>
                    </div>
                  )}
                  {wocSummary.over > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                      <span className="text-[12px] font-semibold text-amber-700">{wocSummary.over} store{wocSummary.over !== 1 ? "s" : ""} over {WOC_HI}w</span>
                      <span className="text-[11px] text-amber-500 ml-1">— reduce stock</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                        <th className="py-2 pr-4"><span className="inline-flex items-center gap-1"><Storefront size={13} /> POS Location</span></th>
                        <th className="py-2 pr-4">Country</th>
                        <th className="py-2 pr-4 text-right">SOH</th>
                        <th className="py-2 pr-4 text-right">Units Sold (4W)</th>
                        <th className="py-2 pr-4 text-right">Weekly Rate</th>
                        <th className="py-2 pr-4 text-right" title={`Target ${WOC_TARGET}w ±1. Red <${WOC_LO}w, Green ${WOC_LO}–${WOC_HI}w, Amber >${WOC_HI}w.`}>WOC ⓘ</th>
                        <th className="py-2 pr-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wocRows.map((r) => {
                        const cta = wocCta(r.woc);
                        return (
                          <tr key={r.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-woc-${r.pos_location}`}>
                            <td className="py-1.5 pr-4 font-medium text-slate-700 whitespace-nowrap">{r.pos_location}</td>
                            <td className="py-1.5 pr-4 text-slate-500">{r.country || "—"}</td>
                            <td className="py-1.5 pr-4 text-right">{fmtNum(r.current_stock)}</td>
                            <td className="py-1.5 pr-4 text-right">{fmtNum(r.units_4w || 0)}</td>
                            <td className="py-1.5 pr-4 text-right">{r.units_4w ? fmtNum(Math.round(r.units_4w / 4)) : "—"}</td>
                            <td className={"py-1.5 pr-4 text-right " + wocColor(r.woc)}>
                              {r.woc == null ? "—" : r.woc.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                            </td>
                            <td className="py-1.5 pr-4 text-right">
                              {cta ? <span className={cta.cls}>{cta.label}</span> : <span className="text-slate-300">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-300 font-semibold text-slate-800">
                        <td className="py-2 pr-4">Total</td>
                        <td className="py-2 pr-4" />
                        <td className="py-2 pr-4 text-right">{fmtNum(wocRows.reduce((a, r) => a + r.current_stock, 0))}</td>
                        <td className="py-2 pr-4 text-right">{fmtNum(wocRows.reduce((a, r) => a + (r.units_4w || 0), 0))}</td>
                        <td className="py-2 pr-4 text-right">{fmtNum(Math.round(wocRows.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}</td>
                        <td className={"py-2 pr-4 text-right " + wocColor(totalWoc)}>
                          {totalWoc == null ? "—" : totalWoc.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {(() => { const cta = wocCta(totalWoc); return cta ? <span className={cta.cls}>{cta.label}</span> : null; })()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default StoreFlow;
