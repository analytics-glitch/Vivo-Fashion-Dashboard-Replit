import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { Ruler, Warning, CheckCircle, Timer, Stack, ArrowsLeftRight } from "@phosphor-icons/react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";

// Size Demand Report — when a new style lands in a store, which sizes sell
// fastest, and does the store's stock mix match its demand mix? A style is
// "new" to a store when its first-ever sale there falls inside the lookback
// window (first sale = launch anchor). Demand = first `window` days of sales;
// stock mix = the store's CURRENT on-hand for those same styles.

const LOOKBACKS = [
  { v: 60, label: "Launched in last 60 days" },
  { v: 90, label: "Launched in last 90 days" },
  { v: 180, label: "Launched in last 180 days" },
  { v: 365, label: "Launched in last 365 days" },
];
const WINDOWS = [
  { v: 14, label: "First 14 days" },
  { v: 30, label: "First 30 days" },
  { v: 60, label: "First 60 days" },
];

const GapBadge = ({ row }) => {
  if (row.stockout)
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-red-50 text-danger border border-red-200">Sold out</span>;
  if (row.gap >= 3)
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">Under-allocated</span>;
  if (row.gap <= -3)
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-sky-50 text-sky-700 border border-sky-200">Over-allocated</span>;
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-emerald-50 text-brand border border-emerald-200">Balanced</span>;
};

const gapText = (g) => {
  const n = Number(g || 0);
  if (n > 0) return <span className="text-amber-700 font-semibold tabular-nums">+{n.toFixed(1)}pp</span>;
  if (n < 0) return <span className="text-sky-700 font-semibold tabular-nums">{n.toFixed(1)}pp</span>;
  return <span className="text-muted tabular-nums">0.0pp</span>;
};

// Compact per-style size chips: "M 10 · L 5", sold-out sizes in red.
const SizeChips = ({ sizes }) => {
  const sold = (sizes || []).filter((s) => s.units > 0);
  if (!sold.length) return <span className="text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {sold.map((s) => (
        <span
          key={s.size}
          className={
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-semibold border " +
            (s.soh === 0
              ? "bg-red-50 text-danger border-red-200"
              : "bg-panel text-ink border-border")
          }
          title={`${s.size}: ${s.units} sold, ${s.soh} in stock now`}
        >
          {s.size} {fmtNum(s.units)}
        </span>
      ))}
    </div>
  );
};

const SizeDemand = () => {
  const [stores, setStores] = useState([]);
  const [store, setStore] = useState("");
  const [days, setDays] = useState(90);
  const [windowDays, setWindowDays] = useState(30);
  const [compare, setCompare] = useState(false);

  const [data, setData] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Store list (physical stores, grouped by country in the select).
  useEffect(() => {
    let dead = false;
    api.get("/store-profile/locations")
      .then(({ data: d }) => {
        if (dead) return;
        const list = d?.stores || [];
        setStores(list);
        setStore((cur) => cur || (list[0]?.store || ""));
      })
      .catch((e) => !dead && setError(e?.response?.data?.detail || e.message));
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    if (!store && !compare) return;
    let dead = false;
    setLoading(true);
    setError(null);
    const target = compare ? "__ALL__" : store;
    api.get("/analytics/size-demand-report", {
      params: { store: target, days, window: windowDays },
      timeout: 120000,
    })
      .then(({ data: d }) => {
        if (dead) return;
        if (d?.mode === "compare") setCmp(d); else setData(d);
      })
      .catch((e) => !dead && setError(e?.response?.data?.detail || e.message))
      .finally(() => !dead && setLoading(false));
    return () => { dead = true; };
  }, [store, days, windowDays, compare]);

  const byCountry = useMemo(() => {
    const g = {};
    for (const s of stores) (g[s.country || "Other"] ||= []).push(s);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [stores]);

  const curve = data?.size_curve || [];
  const summary = data?.summary || {};

  // Chart rows: demand share vs stock share per size, ladder order.
  const chartRows = useMemo(
    () => curve.map((d) => ({
      size: d.size, "Demand share": d.sold_share, "Stock share": d.stock_share,
    })),
    [curve],
  );

  // Plain-language insights, derived entirely from the size curve.
  const insights = useMemo(() => {
    if (!curve.length) return [];
    const out = [];
    const so = curve.filter((d) => d.stockout);
    if (so.length)
      out.push({
        tone: "danger",
        text: `${so.map((d) => d.size).join(", ")} sold in the first ${data?.window || windowDays} days but ${so.length > 1 ? "are" : "is"} now at zero stock across these styles — replenish or transfer in.`,
      });
    for (const u of (summary.under_allocated || []).slice(0, 2)) {
      const row = curve.find((d) => d.size === u.size);
      if (row)
        out.push({
          tone: "warn",
          text: `${u.size} takes ${row.sold_share}% of early demand but holds only ${row.stock_share}% of current stock (${u.gap > 0 ? "+" : ""}${u.gap}pp short) — send more ${u.size} in the next allocation.`,
        });
    }
    for (const o of (summary.over_allocated || []).slice(0, 1)) {
      const row = curve.find((d) => d.size === o.size);
      if (row)
        out.push({
          tone: "info",
          text: `${o.size} holds ${row.stock_share}% of stock against ${row.sold_share}% of demand — a candidate to redistribute to stores where ${o.size} runs out.`,
        });
    }
    const fast = curve
      .filter((d) => d.units >= 10 && d.median_days_to_first_sale != null)
      .sort((a, b) => a.median_days_to_first_sale - b.median_days_to_first_sale)[0];
    if (fast)
      out.push({
        tone: "ok",
        text: `Fastest-moving size: ${fast.size} — typically sells within ${fast.median_days_to_first_sale} day${fast.median_days_to_first_sale === 1 ? "" : "s"} of a style landing.`,
      });
    return out;
  }, [curve, summary, data, windowDays]);

  const sizeColumns = [
    { key: "size", label: "Size", mobilePrimary: true,
      render: (r) => <span className="font-semibold">{r.size}</span> },
    { key: "units", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units) },
    { key: "sold_share", label: "Demand %", numeric: true,
      render: (r) => <span className="tabular-nums">{r.sold_share}%</span>,
      csv: (r) => `${r.sold_share}%` },
    { key: "soh", label: "Stock Now", numeric: true, render: (r) => fmtNum(r.soh) },
    { key: "stock_share", label: "Stock %", numeric: true,
      render: (r) => <span className="tabular-nums">{r.stock_share}%</span>,
      csv: (r) => `${r.stock_share}%` },
    { key: "gap", label: "Gap", numeric: true, render: (r) => gapText(r.gap),
      csv: (r) => `${r.gap}pp` },
    { key: "styles_selling", label: "Styles Selling", numeric: true,
      render: (r) => fmtNum(r.styles_selling) },
    { key: "median_days_to_first_sale", label: "Days to 1st Sale", numeric: true,
      render: (r) => (r.median_days_to_first_sale == null ? <span className="text-muted">—</span>
        : <span className="tabular-nums">{r.median_days_to_first_sale}</span>) },
    { key: "sell_through_pct", label: "Sell-through", numeric: true,
      render: (r) => (r.sell_through_pct == null ? <span className="text-muted">—</span>
        : <span className="tabular-nums">{r.sell_through_pct}%</span>),
      csv: (r) => (r.sell_through_pct == null ? "" : `${r.sell_through_pct}%`) },
    { key: "stockout", label: "Status", sortable: false, render: (r) => <GapBadge row={r} />,
      csv: (r) => (r.stockout ? "Sold out" : r.gap >= 3 ? "Under-allocated" : r.gap <= -3 ? "Over-allocated" : "Balanced") },
  ];

  const styleColumns = [
    { key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.style_name}</span> },
    { key: "launch_date", label: "Landed", render: (r) => r.launch_date || "—" },
    { key: "days_measured", label: "Days Measured", numeric: true,
      render: (r) => (
        <span className="tabular-nums">
          {r.days_measured}
          {r.days_measured < windowDays && (
            <span className="ml-1 text-[10px] text-amber-700 font-semibold">still measuring</span>
          )}
        </span>
      ) },
    { key: "units", label: `Units (first ${windowDays}d)`, numeric: true, render: (r) => fmtNum(r.units) },
    { key: "soh", label: "Stock Now", numeric: true, render: (r) => fmtNum(r.soh) },
    { key: "top_size", label: "Top Size", render: (r) => r.top_size || <span className="text-muted">—</span> },
    { key: "sizes", label: "Size Split (units sold)", sortable: false,
      render: (r) => <SizeChips sizes={r.sizes} />,
      csv: (r) => (r.sizes || []).filter((s) => s.units > 0).map((s) => `${s.size}:${s.units}`).join(" ") },
  ];

  const attention = (summary.stockout_sizes?.length || 0) + (summary.under_allocated?.length || 0);

  return (
    <div className="space-y-4" data-testid="size-demand-page">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium"
          value={compare ? "__ALL__" : store}
          onChange={(e) => {
            if (e.target.value === "__ALL__") setCompare(true);
            else { setCompare(false); setStore(e.target.value); }
          }}
          data-testid="sdr-store-select"
        >
          <option value="__ALL__">All Stores · Compare</option>
          {byCountry.map(([country, list]) => (
            <optgroup key={country} label={country}>
              {list.map((s) => <option key={s.store} value={s.store}>{s.store}</option>)}
            </optgroup>
          ))}
        </select>
        <select
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px]"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          data-testid="sdr-days-select"
        >
          {LOOKBACKS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        <select
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px]"
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          data-testid="sdr-window-select"
        >
          {WINDOWS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
        <span className="text-[12px] text-muted">
          New style = first-ever sale at the store within the lookback; demand is measured over each style's first {windowDays} days.
        </span>
      </div>

      {error && <ErrorBox message={String(error)} />}
      {loading && <Loading label="Crunching size demand…" />}

      {/* ── Compare mode ── */}
      {!loading && !error && compare && cmp && (
        <>
          {!cmp.stores?.length ? (
            <Empty label="No new-style sales found for this window." />
          ) : (
            <div className="bg-card border border-border rounded-xl p-4 overflow-x-auto">
              <SectionTitle
                title="Size demand by store"
                sub={`Share of units each size takes in a style's first ${cmp.window} days · styles launched in the last ${cmp.days} days · darker = bigger share of that store's demand`}
              />
              <table className="min-w-full text-[12px] mt-2">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1.5 pr-3 font-semibold sticky left-0 bg-card">Store</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">New Styles</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Units</th>
                    {cmp.sizes.map((sz) => (
                      <th key={sz} className="py-1.5 px-1.5 font-semibold text-center">{sz}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cmp.stores.map((st) => {
                    const max = Math.max(...Object.values(st.shares || {}), 1);
                    return (
                      <tr key={st.store} className="border-t border-border/60">
                        <td className="py-1.5 pr-3 font-medium whitespace-nowrap sticky left-0 bg-card">
                          <button
                            className="hover:underline text-left"
                            onClick={() => { setCompare(false); setStore(st.store); }}
                            title="Open this store's size demand report"
                          >
                            {st.store}
                          </button>
                          <span className="ml-1.5 text-[10px] text-muted">{st.country}</span>
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(st.new_styles)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(st.units)}</td>
                        {cmp.sizes.map((sz) => {
                          const v = st.shares?.[sz];
                          const alpha = v ? 0.08 + 0.72 * (v / max) : 0;
                          return (
                            <td key={sz} className="py-1.5 px-1.5 text-center tabular-nums"
                                style={v ? { backgroundColor: `rgba(26,92,56,${alpha})`, color: alpha > 0.45 ? "#fff" : undefined } : undefined}
                                title={v ? `${sz}: ${v}% of ${st.store}'s new-style demand` : undefined}>
                              {v ? `${v}%` : <span className="text-muted/50">·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Single-store mode ── */}
      {!loading && !error && !compare && data && (
        summary.new_styles === 0 ? (
          <Empty label={`No styles landed at ${data.store} in the last ${data.days} days. Try a longer lookback.`} />
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KPICard label="New Styles Landed" value={fmtNum(summary.new_styles)} icon={Stack} showDelta={false}
                testId="kpi-sdr-styles"
                sub={`Last ${data.days} days · ${fmtNum(summary.full_window_styles)} fully measured`} />
              <KPICard label={`Units in First ${data.window}d`} value={fmtNum(summary.units_window)} icon={Timer} showDelta={false}
                testId="kpi-sdr-units"
                sub={`${fmtNum(summary.soh_now)} units of these styles still in stock`} />
              <KPICard label="Top Size" value={summary.top_size || "—"} icon={Ruler} showDelta={false}
                testId="kpi-sdr-top"
                sub="Biggest share of early demand" />
              <KPICard label="Sizes Needing Attention" value={fmtNum(attention)} icon={attention > 0 ? Warning : CheckCircle}
                accent={attention > 0} showDelta={false} testId="kpi-sdr-attention"
                sub={attention > 0 ? [...(summary.stockout_sizes || []), ...(summary.under_allocated || []).map((u) => u.size)].filter((v, i, a) => a.indexOf(v) === i).join(", ") : "Demand and stock are in line"} />
            </div>

            {insights.length > 0 && (
              <div className="bg-card border border-border rounded-xl p-4 space-y-2" data-testid="sdr-insights">
                <SectionTitle title="What this means" sub={`${data.store} · based on styles launched in the last ${data.days} days`} />
                {insights.map((ins, i) => (
                  <div key={i} className="flex items-start gap-2 text-[13px]">
                    {ins.tone === "danger" && <Warning size={15} weight="fill" className="text-danger mt-0.5 shrink-0" />}
                    {ins.tone === "warn" && <ArrowsLeftRight size={15} weight="bold" className="text-amber-600 mt-0.5 shrink-0" />}
                    {ins.tone === "info" && <ArrowsLeftRight size={15} weight="bold" className="text-sky-600 mt-0.5 shrink-0" />}
                    {ins.tone === "ok" && <CheckCircle size={15} weight="fill" className="text-brand mt-0.5 shrink-0" />}
                    <span>{ins.text}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-card border border-border rounded-xl p-4">
              <SectionTitle
                title="Demand vs stock, by size"
                sub="Green = share of units sold in each style's first days · Grey = share of what's on hand today. A green bar towering over its grey twin means the store sells that size faster than it's being stocked."
              />
              <div className="h-[300px] mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartRows} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="size" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} unit="%" />
                    <Tooltip formatter={(v) => `${v}%`} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Demand share" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="Stock share" fill="#9ca3af" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-4">
              <SectionTitle
                title="Size scorecard"
                sub={`Each size's early demand vs what's left on the shelf · gap = demand share minus stock share (positive = under-stocked for its demand)`}
              />
              <SortableTable
                columns={sizeColumns}
                rows={curve}
                initialSort={{ key: "units", dir: "desc" }}
                exportName={`size-demand-${data.store}.csv`}
                testId="sdr-size-table"
                mobileCards
                emptyLabel="No size-level sales recorded yet."
              />
            </div>

            <div className="bg-card border border-border rounded-xl p-4">
              <SectionTitle
                title="Style-by-style detail"
                sub={`Every style that landed at ${data.store} in the last ${data.days} days${data.styles_truncated ? " (top 1,000 by units)" : ""} · red chips are sizes that sold and are now out of stock`}
              />
              <SortableTable
                columns={styleColumns}
                rows={data.styles || []}
                initialSort={{ key: "units", dir: "desc" }}
                exportName={`size-demand-styles-${data.store}.csv`}
                testId="sdr-styles-table"
                pageSize={50}
                mobileCards
                emptyLabel="No new styles in this window."
              />
            </div>
          </>
        )
      )}
    </div>
  );
};

export default SizeDemand;
