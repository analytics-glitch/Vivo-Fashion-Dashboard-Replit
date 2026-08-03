import React, { useState, useEffect, useMemo } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtDelta } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import {
  ArrowUp, ArrowDown, Minus,
  CaretDown, CaretRight,
  WarningCircle, CheckCircle, Eye,
} from "@phosphor-icons/react";

// ─── Status styling ────────────────────────────────────────────────────────
const STATUS_CFG = {
  Healthy:  { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-700",  dot: "bg-emerald-500" },
  Watch:    { bg: "bg-amber-50",   border: "border-amber-300",   text: "text-amber-700",    dot: "bg-amber-500"   },
  "At Risk":{ bg: "bg-red-50",     border: "border-red-300",     text: "text-red-700",      dot: "bg-red-500"     },
};

const SEV_CFG = {
  high:   { chip: "bg-red-100 text-red-800 border border-red-200",   icon: WarningCircle, iconCls: "text-red-500"   },
  medium: { chip: "bg-amber-100 text-amber-800 border border-amber-200", icon: WarningCircle, iconCls: "text-amber-500" },
  none:   { chip: "bg-emerald-100 text-emerald-800 border border-emerald-200", icon: CheckCircle, iconCls: "text-emerald-500" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────
const fmtPct = (v, decimals = 1) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(decimals)}%`;

const fmtAbsPct = (v, decimals = 1) =>
  v == null ? "—" : `${Number(v).toFixed(decimals)}%`;

const DeltaPill = ({ val }) => {
  if (val == null) return <span className="text-muted-foreground text-xs">—</span>;
  const pos = val >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${pos ? "text-emerald-600" : "text-red-600"}`}>
      {pos ? <ArrowUp size={10} weight="bold" /> : <ArrowDown size={10} weight="bold" />}
      {Math.abs(val).toFixed(1)}%
    </span>
  );
};

const ScoreBar = ({ score }) => {
  const col = score >= 70 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${col}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums w-6 text-right">{score}</span>
    </div>
  );
};

const StatusPill = ({ status }) => {
  const cfg = STATUS_CFG[status] || STATUS_CFG.Watch;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold border ${cfg.bg} ${cfg.border} ${cfg.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {status}
    </span>
  );
};

const KpiCell = ({ label, current, prior, changePct, fmt = fmtKES, pctDecimals = 1 }) => (
  <div>
    <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</div>
    <div className="font-semibold text-sm">{current == null ? "—" : fmt(current)}</div>
    {prior != null && (
      <div className="flex items-center gap-1 mt-0.5">
        <span className="text-[10px] text-muted-foreground">vs {fmt(prior)}</span>
        <DeltaPill val={changePct} />
      </div>
    )}
  </div>
);

const ProgressBar = ({ pct, label, sublabel }) => {
  const clamped = Math.min(100, Math.max(0, pct || 0));
  const col = pct >= 100 ? "bg-emerald-500" : pct >= 80 ? "bg-amber-500" : "bg-red-500";
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{sublabel}</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${col}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
};

// ─── Stock-mix tier bar ────────────────────────────────────────────────────
const TIER_COLORS = {
  NOOS: "bg-emerald-500", Core: "bg-teal-400",
  "Recent Performer": "bg-blue-400", "New Styles": "bg-violet-400", Retired: "bg-rose-400",
};

const MixBar = ({ mix }) => {
  if (!mix) return null;
  const tiers = ["NOOS", "Core", "Recent Performer", "New Styles", "Retired"];
  const total = tiers.reduce((s, k) => s + (mix[k] || 0), 0) || 1;
  return (
    <div>
      <div className="h-2.5 flex rounded-full overflow-hidden">
        {tiers.map((t) => {
          const w = ((mix[t] || 0) * 100) / total;
          return w > 0 ? <div key={t} className={`${TIER_COLORS[t]} h-full`} style={{ width: `${w}%` }} title={`${t}: ${Math.round(w)}%`} /> : null;
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {tiers.map((t) => {
          const w = ((mix[t] || 0) * 100) / total;
          return w > 0 ? (
            <span key={t} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={`h-1.5 w-1.5 rounded-full ${TIER_COLORS[t]}`} />
              {t} {Math.round(w)}%
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
};

// ─── Expanded store detail ─────────────────────────────────────────────────
const StoreDetail = ({ store, medians }) => {
  const { kpis, target, footfall, customers, stock_mix, sell_through, pain_points, strengths } = store;

  return (
    <div className="px-4 pb-4 pt-2 border-t bg-muted/30 space-y-5">
      {/* KPI grid */}
      <div>
        <div className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Sales KPIs — Current vs Prior Period</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCell label="Revenue (Net)" current={kpis.revenue.current} prior={kpis.revenue.prior} changePct={kpis.revenue.change_pct} />
          <KpiCell label="Units" current={kpis.units.current} prior={kpis.units.prior} changePct={kpis.units.change_pct} fmt={fmtNum} />
          <KpiCell label="Transactions" current={kpis.transactions.current} prior={kpis.transactions.prior} changePct={kpis.transactions.change_pct} fmt={fmtNum} />
          <KpiCell label="ASP" current={kpis.asp.current} prior={kpis.asp.prior} changePct={kpis.asp.change_pct} />
          <KpiCell label="Basket" current={kpis.basket.current} prior={kpis.basket.prior} changePct={kpis.basket.change_pct} />
          <KpiCell label="UPT" current={kpis.upt.current} prior={kpis.upt.prior} changePct={kpis.upt.change_pct} fmt={(v) => v == null ? "—" : Number(v).toFixed(2)} />
          <KpiCell label="Discount Rate" current={kpis.discount_rate.current} changePct={null} fmt={(v) => v == null ? "—" : `${v.toFixed(1)}%`} prior={null} />
          <KpiCell label="Return Rate" current={kpis.return_rate.current} changePct={null} fmt={(v) => v == null ? "—" : `${v.toFixed(1)}%`} prior={null} />
          <KpiCell label="Customers" current={kpis.distinct_customers.current} prior={kpis.distinct_customers.prior} changePct={kpis.distinct_customers.change_pct} fmt={fmtNum} />
        </div>
      </div>

      {/* Target + Footfall + Customers row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Target */}
        <div className="rounded-lg border bg-background p-3 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Target — {new Date().toLocaleString("default", { month: "long" })}</div>
          {target.target_kes ? (
            <>
              <ProgressBar
                pct={target.pct_of_target}
                label={`MTD: ${fmtKES(target.mtd_actual)}`}
                sublabel={`of ${fmtKES(target.mtd_target)} prorated`}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Projected: <span className="font-medium text-foreground">{fmtKES(target.projected)}</span></span>
                <span>Target: {fmtKES(target.target_kes)}</span>
              </div>
              {target.variance != null && (
                <div className={`text-xs font-medium ${target.variance >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  Variance: {target.variance >= 0 ? "+" : ""}{fmtKES(target.variance)} vs prorated target
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-muted-foreground">No target set for this month</div>
          )}
        </div>

        {/* Footfall */}
        <div className="rounded-lg border bg-background p-3 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Footfall &amp; Conversion</div>
          {footfall.current > 0 ? (
            <>
              <div className="flex justify-between">
                <span className="text-sm font-semibold">{fmtNum(footfall.current)}</span>
                <DeltaPill val={footfall.change_pct} />
              </div>
              <div className="text-xs text-muted-foreground">vs {fmtNum(footfall.prior)} prior period</div>
              <div className="border-t pt-2">
                <div className="text-xs text-muted-foreground">Conversion</div>
                <div className="text-sm font-semibold">
                  {footfall.conversion != null ? `${footfall.conversion}%` : "—"}
                  {medians?.conversion && footfall.conversion != null && (
                    <span className="text-xs text-muted-foreground ml-1">(median {medians.conversion}%)</span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">No footfall sensor data for this store</div>
          )}
        </div>

        {/* Customers */}
        <div className="rounded-lg border bg-background p-3 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Customer Health</div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">New</span>
            <span className="font-medium">{fmtNum(customers.new)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Returning</span>
            <span className="font-medium">{fmtNum(customers.returning)}</span>
          </div>
          <div className="flex justify-between text-sm border-t pt-2">
            <span className="text-muted-foreground">Repeat rate</span>
            <span className={`font-medium ${customers.repeat_rate >= 25 ? "text-emerald-600" : customers.repeat_rate < 15 ? "text-red-600" : "text-amber-600"}`}>
              {customers.repeat_rate != null ? `${customers.repeat_rate.toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Stock mix */}
      <div className="rounded-lg border bg-background p-3">
        <div className="flex justify-between items-center mb-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Stock Mix by Tier</div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            {stock_mix?.noos_pct != null && <span>NOOS+Core <strong>{stock_mix.noos_pct}%</strong></span>}
            {sell_through != null && <span>Sell-through <strong>{sell_through.toFixed(1)}%</strong></span>}
            {stock_mix?.dead_pct != null && <span>Retired <strong className={stock_mix.dead_pct > 15 ? "text-red-600" : ""}>{stock_mix.dead_pct}%</strong></span>}
          </div>
        </div>
        <MixBar mix={stock_mix} />
      </div>

      {/* Pain points + strengths */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Issues</div>
          <div className="space-y-1.5">
            {pain_points?.map((p, i) => {
              const cfg = SEV_CFG[p.severity] || SEV_CFG.medium;
              const Icon = cfg.icon;
              return (
                <div key={i} className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs ${cfg.chip}`}>
                  <Icon size={13} className={`mt-0.5 shrink-0 ${cfg.iconCls}`} weight="fill" />
                  <span>{p.message}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Strengths</div>
          {strengths?.length > 0 ? (
            <div className="space-y-1.5">
              {strengths.map((s, i) => (
                <div key={i} className="flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs bg-emerald-100 text-emerald-800 border border-emerald-200">
                  <CheckCircle size={13} className="mt-0.5 shrink-0 text-emerald-600" weight="fill" />
                  <span>{s}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No notable standouts this period</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Store row ─────────────────────────────────────────────────────────────
const StoreRow = ({ store, medians, expanded, onToggle }) => {
  const topPain = store.pain_points?.[0];
  const painCfg = SEV_CFG[topPain?.severity] || SEV_CFG.none;
  const PainIcon = painCfg.icon;

  return (
    <>
      <tr
        className="hover:bg-muted/40 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="p-3 w-6">
          {expanded
            ? <CaretDown size={13} className="text-muted-foreground" />
            : <CaretRight size={13} className="text-muted-foreground" />}
        </td>
        <td className="p-3 font-medium text-sm max-w-[180px]">
          <div className="truncate">{store.store}</div>
          {store.months_active && (
            <div className="text-[10px] text-muted-foreground mt-0.5">{store.months_active}mo active</div>
          )}
        </td>
        <td className="p-3"><StatusPill status={store.status} /></td>
        <td className="p-3"><ScoreBar score={store.score} /></td>
        <td className="p-3 text-sm tabular-nums">
          <div className="font-medium">{fmtKES(store.kpis.revenue.current)}</div>
          <DeltaPill val={store.kpis.revenue.change_pct} />
        </td>
        <td className="p-3 text-sm tabular-nums">
          {store.target.pct_of_target != null ? (
            <span className={store.target.pct_of_target >= 100 ? "text-emerald-600 font-medium" : store.target.pct_of_target < 80 ? "text-red-600 font-medium" : "text-amber-600 font-medium"}>
              {store.target.pct_of_target.toFixed(1)}%
            </span>
          ) : "—"}
        </td>
        <td className="p-3 text-sm tabular-nums">
          {store.footfall.conversion != null ? `${store.footfall.conversion}%` : "—"}
        </td>
        <td className="p-3 max-w-[220px]">
          {topPain && (
            <div className="flex items-center gap-1.5 text-xs">
              <PainIcon size={12} weight="fill" className={`shrink-0 ${painCfg.iconCls}`} />
              <span className="truncate text-muted-foreground">{topPain.message}</span>
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <StoreDetail store={store} medians={medians} />
          </td>
        </tr>
      )}
    </>
  );
};

// ─── Main page ─────────────────────────────────────────────────────────────
const SORT_OPTS = [
  { value: "score",       label: "Health Score" },
  { value: "revenue",     label: "Revenue" },
  { value: "target_pct",  label: "% of Target" },
  { value: "conversion",  label: "Conversion" },
];

export default function StoreProfiling() {
  const { countries } = useFilters();
  const [period, setPeriod]     = useState(28);
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState({});
  const [sortBy, setSortBy]     = useState("score");
  const [filterStatus, setFilterStatus] = useState("all");

  const country = (countries || []).length === 1 ? countries[0] : null;

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ period });
    if (country) params.set("country", country);
    api.get(`/analytics/store-profiling?${params}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message || "Failed to load"); setLoading(false); });
  }, [period, country]);

  const stores = useMemo(() => {
    if (!data?.stores) return [];
    let list = [...data.stores];
    if (filterStatus !== "all") list = list.filter((s) => s.status === filterStatus);
    if (sortBy === "score")      list.sort((a, b) => b.score - a.score);
    if (sortBy === "revenue")    list.sort((a, b) => b.kpis.revenue.current - a.kpis.revenue.current);
    if (sortBy === "target_pct") list.sort((a, b) => (b.target.pct_of_target ?? -1) - (a.target.pct_of_target ?? -1));
    if (sortBy === "conversion") list.sort((a, b) => (b.footfall.conversion ?? -1) - (a.footfall.conversion ?? -1));
    return list;
  }, [data, filterStatus, sortBy]);

  const counts = useMemo(() => {
    if (!data?.stores) return {};
    return data.stores.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  }, [data]);

  const toggle = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));

  const periodLabel = (p) => p === 28 ? "28-day" : "90-day";
  const rangeLabel = () => {
    if (!data) return "";
    const [cs, ce] = data.current_range;
    return `${new Date(cs + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(ce + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle>Store Performance Profiling</SectionTitle>
          <p className="text-sm text-muted-foreground mt-0.5">
            Health scorecard for every store — revenue trend, target attainment, footfall conversion, customer depth, stock mix, and ranked pain-point diagnosis.
            {data && <span className="ml-1 font-medium">({rangeLabel()})</span>}
          </p>
        </div>
        {/* Period toggle */}
        <div className="flex rounded-lg border overflow-hidden text-sm">
          {[28, 90].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 font-medium transition-colors ${period === p ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            >
              {periodLabel(p)}
            </button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-3 gap-3">
          {["Healthy", "Watch", "At Risk"].map((s) => {
            const cfg = STATUS_CFG[s];
            return (
              <button
                key={s}
                onClick={() => setFilterStatus(filterStatus === s ? "all" : s)}
                className={`rounded-xl border-2 p-4 text-left transition-all ${filterStatus === s ? `${cfg.border} ${cfg.bg}` : "border-border bg-card hover:bg-muted/40"}`}
              >
                <div className={`text-2xl font-bold tabular-nums ${filterStatus === s ? cfg.text : "text-foreground"}`}>
                  {counts[s] || 0}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={`h-2 w-2 rounded-full ${cfg.dot}`} />
                  <span className={`text-sm font-medium ${filterStatus === s ? cfg.text : "text-muted-foreground"}`}>{s}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Country + sort controls */}
      {data && (
        <div className="flex flex-wrap items-center gap-3">
          {country && (
            <div className="text-sm text-muted-foreground">
              Showing: <span className="font-medium text-foreground">{country}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="border rounded-md px-2 py-1 text-sm bg-background"
            >
              {SORT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {filterStatus !== "all" && (
            <button onClick={() => setFilterStatus("all")} className="text-xs underline text-muted-foreground">
              Clear filter
            </button>
          )}
        </div>
      )}

      {/* Loading / error states */}
      {loading && <Loading label="Analysing stores…" />}
      {error && <ErrorBox message={error} />}

      {/* Table */}
      {!loading && !error && data && (
        stores.length === 0
          ? <Empty label={filterStatus !== "all" ? `No ${filterStatus} stores` : "No store data found"} />
          : (
            <div className="rounded-xl border overflow-auto shadow-sm">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b bg-muted/50 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    <th className="p-3 w-6" />
                    <th className="p-3">Store</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 min-w-[120px]">Health Score</th>
                    <th className="p-3">Revenue</th>
                    <th className="p-3">% of Target</th>
                    <th className="p-3">Conversion</th>
                    <th className="p-3">Top Issue</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stores.map((store) => (
                    <StoreRow
                      key={store.store}
                      store={store}
                      medians={data.country_medians}
                      expanded={!!expanded[store.store]}
                      onToggle={() => toggle(store.store)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {/* Median context footer */}
      {data?.country_medians && (
        <div className="text-xs text-muted-foreground border-t pt-3 flex flex-wrap gap-x-5 gap-y-1">
          <span>Country medians (peer comparison basis):</span>
          {data.country_medians.conversion != null && <span>Conversion <strong>{data.country_medians.conversion}%</strong></span>}
          {data.country_medians.discount_rate != null && <span>Discount rate <strong>{data.country_medians.discount_rate}%</strong></span>}
          {data.country_medians.basket != null && <span>Basket <strong>{fmtKES(data.country_medians.basket)}</strong></span>}
        </div>
      )}
    </div>
  );
}
