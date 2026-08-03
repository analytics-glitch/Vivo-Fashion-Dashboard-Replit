import React, { useState, useMemo } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import {
  ArrowUp, ArrowDown,
  WarningCircle, CheckCircle,
  ShoppingBag, Wallet, Users, Tag,
  X, CaretDown, CaretUp,
} from "@phosphor-icons/react";

// ─── Status styling ──────────────────────────────────────────────────────────
const STATUS_CFG = {
  Healthy:   { ring: "ring-emerald-300", bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500", lbg: "bg-emerald-500/10" },
  Watch:     { ring: "ring-amber-300",   bg: "bg-amber-50",   text: "text-amber-700",   dot: "bg-amber-500",   lbg: "bg-amber-500/10"   },
  "At Risk": { ring: "ring-red-300",     bg: "bg-red-50",     text: "text-red-700",     dot: "bg-red-500",     lbg: "bg-red-500/10"     },
};

const TIER_COLORS = {
  NOOS: "bg-emerald-500", Core: "bg-teal-400",
  "Recent Performer": "bg-blue-400", "New Styles": "bg-violet-400", Retired: "bg-rose-400",
};
const TIERS = ["NOOS", "Core", "Recent Performer", "New Styles", "Retired"];

const DETAIL_TABS = ["Aug Target", "Performance", "Operations", "Stock", "Diagnosis"];

// ─── Formatters ──────────────────────────────────────────────────────────────
const fmtS = (v) => {
  if (v == null) return "—";
  const n = Number(v);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
};
const fmtKS  = (v) => v == null ? "—" : `KES ${fmtS(v)}`;
const fmtPct = (v, d = 1) => v == null ? "—" : `${Number(v).toFixed(d)}%`;
const fmtFull = (v) => v == null ? "—" : fmtKES(v);
const fmtN    = (v) => v == null ? "—" : fmtNum(v);

// ─── Micro components ────────────────────────────────────────────────────────
const Delta = ({ val, suffix = "%", size = "sm" }) => {
  if (val == null) return <span className="text-muted-foreground text-[11px]">—</span>;
  const pos = val >= 0;
  const cls = size === "xs"
    ? `inline-flex items-center gap-0.5 text-[10px] font-semibold ${pos ? "text-emerald-600" : "text-red-600"}`
    : `inline-flex items-center gap-0.5 text-xs font-semibold ${pos ? "text-emerald-600" : "text-red-600"}`;
  return (
    <span className={cls}>
      {pos ? <ArrowUp size={size === "xs" ? 8 : 9} weight="bold" /> : <ArrowDown size={size === "xs" ? 8 : 9} weight="bold" />}
      {Math.abs(val).toFixed(1)}{suffix}
    </span>
  );
};

const ScoreBar = ({ score }) => {
  const col = score >= 70 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  const textCol = score >= 70 ? "text-emerald-700" : score >= 50 ? "text-amber-700" : "text-red-700";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${col}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-[11px] font-bold tabular-nums w-5 text-right ${textCol}`}>{score}</span>
    </div>
  );
};

const TargetBar = ({ p }) => {
  if (p == null) return <span className="text-[10px] text-muted-foreground">No target</span>;
  const col = p >= 100 ? "bg-emerald-500" : p >= 80 ? "bg-amber-500" : "bg-red-500";
  const textCol = p >= 100 ? "text-emerald-600" : p < 80 ? "text-red-600" : "text-amber-600";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${col}`} style={{ width: `${Math.min(100, p)}%` }} />
      </div>
      <span className={`text-[10px] font-bold tabular-nums ${textCol}`}>{p.toFixed(1)}%</span>
    </div>
  );
};

const StatusDot = ({ status }) => {
  const cfg = STATUS_CFG[status] || STATUS_CFG.Watch;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 ${cfg.bg} ${cfg.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {status}
    </span>
  );
};

// ─── KPI cell ────────────────────────────────────────────────────────────────
const KCell = ({ label, cur, prior, pct, fmt = fmtFull, invert = false }) => {
  const deltaPos = pct == null ? null : (invert ? pct <= 0 : pct >= 0);
  return (
    <div className="rounded-lg bg-muted/50 border border-border p-2.5 space-y-0.5">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-sm font-bold leading-none">{cur == null ? "—" : fmt(cur)}</div>
      {prior != null && (
        <div className="flex items-center gap-1 pt-0.5">
          <span className="text-[10px] text-muted-foreground">vs {fmt(prior)}</span>
          {pct != null && (
            <span className={`text-[10px] font-semibold inline-flex items-center gap-0.5 ${deltaPos ? "text-emerald-600" : "text-red-600"}`}>
              {deltaPos ? <ArrowUp size={7} weight="bold" /> : <ArrowDown size={7} weight="bold" />}
              {Math.abs(pct).toFixed(1)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Stock mix bar ───────────────────────────────────────────────────────────
const MixBar = ({ mix }) => {
  if (!mix) return null;
  const total = TIERS.reduce((s, k) => s + (mix[k] || 0), 0) || 1;
  return (
    <div>
      <div className="h-3 flex rounded-full overflow-hidden">
        {TIERS.map((t) => {
          const w = ((mix[t] || 0) * 100) / total;
          return w > 0.5 ? <div key={t} className={`${TIER_COLORS[t]}`} style={{ width: `${w}%` }} title={`${t}: ${Math.round(w)}%`} /> : null;
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
        {TIERS.map((t) => {
          const w = Math.round(((mix[t] || 0) * 100) / total);
          return w > 0 ? (
            <span key={t} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={`h-1.5 w-1.5 rounded-full ${TIER_COLORS[t]}`} />
              {t} {w}%
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
};

// ─── Lever card (August target) ──────────────────────────────────────────────
const feasibilityOf = (pctChange) =>
  pctChange < 10 ? "easy" : pctChange < 25 ? "moderate" : "hard";

const FEAS_CFG = {
  easy:     { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", badge: "Achievable" },
  moderate: { bg: "bg-amber-50 border-amber-200",     text: "text-amber-700",   badge: "Stretch"    },
  hard:     { bg: "bg-red-50 border-red-200",         text: "text-red-700",     badge: "Difficult"  },
};

const LeverCard = ({ Icon, title, current, required, delta, feasibility, note }) => {
  const cfg = FEAS_CFG[feasibility] || FEAS_CFG.moderate;
  return (
    <div className={`rounded-xl border p-3 space-y-2 ${cfg.bg}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-white/60">
            <Icon size={14} weight="duotone" className={cfg.text} />
          </div>
          <span className="text-xs font-semibold">{title}</span>
        </div>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-white/60 ${cfg.text}`}>
          {cfg.badge}
        </span>
      </div>
      <div className="space-y-0.5 text-[11px]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Current</span>
          <span className="font-medium">{current}</span>
        </div>
        <div className="flex justify-between border-t border-white/50 pt-0.5">
          <span className="text-muted-foreground">Required</span>
          <span className={`font-bold ${cfg.text}`}>{required}</span>
        </div>
      </div>
      {delta && <div className={`text-[11px] font-semibold ${cfg.text}`}>{delta}</div>}
      {note  && <div className="text-[10px] text-muted-foreground">{note}</div>}
    </div>
  );
};

// ─── August target path section ──────────────────────────────────────────────
const AugustPath = ({ path }) => {
  if (!path || path.gap == null) {
    return (
      <div className="rounded-xl bg-muted/30 border p-4 text-sm text-muted-foreground">
        No August target set for this store.
      </div>
    );
  }
  const { gap, days_remaining, required_daily_revenue, current_daily_revenue, levers } = path;

  if (gap === 0) {
    return (
      <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 space-y-1">
        <div className="flex items-center gap-2 text-emerald-700 font-semibold">
          <CheckCircle size={16} weight="fill" />
          On track for August target
        </div>
        <div className="text-sm text-emerald-600">
          Running at {fmtKS(current_daily_revenue)}/day.{" "}
          {days_remaining > 0 ? `${days_remaining} days remaining.` : "Month complete."}
        </div>
      </div>
    );
  }

  const cards = [];

  if (levers.transactions) {
    const l = levers.transactions;
    const pct = l.current_daily > 0 ? (l.extra_per_day / l.current_daily) * 100 : 30;
    cards.push(
      <LeverCard
        key="txn"
        Icon={ShoppingBag}
        title="More Transactions"
        current={`${l.current_daily}/day`}
        required={`${l.required_daily}/day`}
        delta={`+${l.extra_per_day > 0 ? l.extra_per_day.toFixed(1) : "0"} extra orders/day`}
        feasibility={feasibilityOf(Math.abs(pct))}
        note={`At current basket of ${fmtKS(l.mtd_basket)}`}
      />
    );
  }

  if (levers.basket) {
    const l = levers.basket;
    const pct = l.current > 0 ? (l.uplift / l.current) * 100 : 30;
    cards.push(
      <LeverCard
        key="basket"
        Icon={Wallet}
        title="Higher Basket"
        current={fmtKS(l.current)}
        required={fmtKS(l.required)}
        delta={`+${fmtKS(l.uplift)} per transaction`}
        feasibility={feasibilityOf(Math.abs(pct))}
        note={`At current rate of ${l.daily_txns} orders/day`}
      />
    );
  }

  if (levers.conversion) {
    const l = levers.conversion;
    const pct = l.current > 0 ? ((l.required - l.current) / l.current) * 100 : 30;
    cards.push(
      <LeverCard
        key="conv"
        Icon={Users}
        title="Higher Conversion"
        current={`${l.current}%`}
        required={`${l.required}%`}
        delta={`+${l.uplift}pp conversion lift`}
        feasibility={feasibilityOf(Math.abs(pct))}
        note={`${fmtN(l.daily_footfall)} visitors/day avg`}
      />
    );
  }

  if (levers.discounting) {
    const l = levers.discounting;
    cards.push(
      <LeverCard
        key="disc"
        Icon={Tag}
        title="Tighter Discounting"
        current={`${l.current_rate}% disc rate`}
        required={`${l.median_rate}% (median)`}
        delta={`${fmtKS(l.recoverable)} recoverable/month`}
        feasibility="moderate"
        note="Above-median discounting — partial lever"
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-red-500 mb-0.5">Gap to Target</div>
          <div className="text-xl font-black text-red-700 tabular-nums leading-none">{fmtKS(gap)}</div>
        </div>
        <div className="rounded-xl bg-muted/50 border px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-0.5">Days Remaining</div>
          <div className="text-xl font-black tabular-nums leading-none">{days_remaining}</div>
        </div>
        <div className="rounded-xl bg-muted/50 border px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-0.5">Required Daily</div>
          <div className="text-xl font-black tabular-nums leading-none">{fmtKS(required_daily_revenue)}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">vs {fmtKS(current_daily_revenue)} now</div>
        </div>
      </div>

      {/* Levers */}
      {cards.length > 0 ? (
        <div>
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Ways to bridge the gap — pick any combination
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {cards}
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground rounded-xl bg-muted/30 border p-3">
          Not enough transaction data to compute levers yet.
        </div>
      )}
    </div>
  );
};

// ─── Detail panel ────────────────────────────────────────────────────────────
const StoreDetail = ({ store, medians, period }) => {
  const [tab, setTab] = useState(0);
  const { kpis, footfall, customers, stock_mix, sell_through, pain_points, strengths, target, august_target_path } = store;

  return (
    <div className="flex flex-col h-full">
      {/* Store header */}
      <div className="px-4 pt-4 pb-0">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div>
            <h2 className="text-base font-bold leading-tight">{store.store}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">{store.country}</span>
              {store.months_active && (
                <span className="text-xs text-muted-foreground">· {store.months_active}mo active</span>
              )}
            </div>
          </div>
          <StatusDot status={store.status} />
        </div>
        <ScoreBar score={store.score} />
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 px-3 mt-3 border-b overflow-x-auto">
        {DETAIL_TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-t-md whitespace-nowrap border-b-2 transition-colors
              ${tab === i
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t === "Aug Target" && august_target_path?.gap > 0
              ? <span className="flex items-center gap-1">{t} <span className="h-1.5 w-1.5 rounded-full bg-red-500 inline-block" /></span>
              : t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">

        {/* ── Tab 0: August Target ─────────────────────────────────────── */}
        {tab === 0 && <AugustPath path={august_target_path} />}

        {/* ── Tab 1: Performance (KPI grid) ────────────────────────────── */}
        {tab === 1 && (
          <div className="space-y-4">
            <div className="text-[11px] text-muted-foreground">
              All metrics vs the prior {period}-day window (equal length, same days of week weighting)
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <KCell label="Revenue (Net)"  cur={kpis.revenue.current}      prior={kpis.revenue.prior}      pct={kpis.revenue.change_pct}      fmt={fmtFull} />
              <KCell label="Units Sold"     cur={kpis.units.current}         prior={kpis.units.prior}         pct={kpis.units.change_pct}         fmt={fmtN} />
              <KCell label="Transactions"   cur={kpis.transactions.current}  prior={kpis.transactions.prior}  pct={kpis.transactions.change_pct}  fmt={fmtN} />
              <KCell label="ASP"            cur={kpis.asp.current}           prior={kpis.asp.prior}           pct={kpis.asp.change_pct}           fmt={fmtFull} />
              <KCell label="Basket Size"    cur={kpis.basket.current}        prior={kpis.basket.prior}        pct={kpis.basket.change_pct}        fmt={fmtFull} />
              <KCell label="UPT"            cur={kpis.upt.current}           prior={kpis.upt.prior}           pct={kpis.upt.change_pct}           fmt={(v) => v == null ? "—" : Number(v).toFixed(2)} />
              <KCell label="Discount Rate"  cur={kpis.discount_rate.current} prior={null}                     pct={null}                          fmt={fmtPct} invert />
              <KCell label="Return Rate"    cur={kpis.return_rate.current}   prior={null}                     pct={null}                          fmt={fmtPct} invert />
              <KCell label="Customers"      cur={kpis.distinct_customers.current} prior={kpis.distinct_customers.prior} pct={kpis.distinct_customers.change_pct} fmt={fmtN} />
            </div>

            {target?.target_kes && (
              <div className="rounded-xl border bg-muted/30 p-3 space-y-2">
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  August Target Progress
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ["MTD Actual",       fmtFull(target.mtd_actual)],
                    ["Prorated Target",  fmtFull(target.mtd_target)],
                    ["Full-Month Target",fmtFull(target.target_kes)],
                    ["Projected Full",   fmtFull(target.projected)],
                  ].map(([lbl, val]) => (
                    <div key={lbl}>
                      <div className="text-[10px] text-muted-foreground">{lbl}</div>
                      <div className="text-sm font-bold">{val}</div>
                    </div>
                  ))}
                </div>
                <TargetBar p={target.pct_of_target} />
              </div>
            )}
          </div>
        )}

        {/* ── Tab 2: Operations ─────────────────────────────────────────── */}
        {tab === 2 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Footfall */}
            <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Footfall & Conversion</div>
              {footfall.current > 0 ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-black tabular-nums">{fmtN(footfall.current)}</span>
                    <Delta val={footfall.change_pct} />
                  </div>
                  <div className="text-xs text-muted-foreground">vs {fmtN(footfall.prior)} prior period</div>
                  <div className="border-t pt-2 space-y-1.5">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Conversion Rate</span>
                      <span className="font-bold">{footfall.conversion != null ? `${footfall.conversion}%` : "—"}</span>
                    </div>
                    {medians?.conversion != null && footfall.conversion != null && (
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Country median</span>
                        <span>{medians.conversion}%</span>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">No footfall sensor data for this store.</div>
              )}
            </div>

            {/* Customers */}
            <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Customer Health</div>
              <div className="space-y-2">
                {[
                  ["New Customers",      fmtN(customers.new)],
                  ["Returning Customers",fmtN(customers.returning)],
                  ["Total Identified",   fmtN(customers.total)],
                ].map(([label, val]) => (
                  <div key={label} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-semibold">{val}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm border-t pt-2">
                  <span className="text-muted-foreground">Repeat Rate</span>
                  <span className={`font-bold ${
                    customers.repeat_rate == null ? "" :
                    customers.repeat_rate >= 25 ? "text-emerald-600" :
                    customers.repeat_rate < 15   ? "text-red-600" : "text-amber-600"
                  }`}>
                    {customers.repeat_rate != null ? `${customers.repeat_rate.toFixed(1)}%` : "—"}
                  </span>
                </div>
                {medians?.basket && (
                  <div className="flex justify-between text-xs text-muted-foreground border-t pt-1.5">
                    <span>Country median basket</span>
                    <span>{fmtFull(medians.basket)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Tab 3: Stock ──────────────────────────────────────────────── */}
        {tab === 3 && (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Stock Mix by Tier</div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {stock_mix && (() => {
                    const total = TIERS.reduce((s, t) => s + (stock_mix[t] || 0), 0) || 1;
                    const noosPct = Math.round(((stock_mix.NOOS || 0) + (stock_mix.Core || 0)) * 100 / total);
                    const deadPct = Math.round((stock_mix.Retired || 0) * 100 / total);
                    return (
                      <>
                        <span>NOOS+Core <strong className={noosPct < 20 ? "text-red-600" : "text-emerald-600"}>{noosPct}%</strong></span>
                        <span>Retired <strong className={deadPct > 15 ? "text-red-600" : ""}>{deadPct}%</strong></span>
                      </>
                    );
                  })()}
                  {sell_through != null && <span>Sell-through <strong>{sell_through.toFixed(1)}%</strong></span>}
                </div>
              </div>
              <MixBar mix={stock_mix} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {TIERS.map((tier) => {
                const v = stock_mix?.[tier] || 0;
                const total = TIERS.reduce((s, t) => s + (stock_mix?.[t] || 0), 0) || 1;
                const p = Math.round(v * 100 / total);
                return (
                  <div key={tier} className="rounded-lg border bg-muted/30 p-2.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`h-2 w-2 rounded-full ${TIER_COLORS[tier]}`} />
                      <span className="text-[10px] font-semibold text-muted-foreground">{tier}</span>
                    </div>
                    <div className="text-lg font-black">{p}%</div>
                    <div className="text-[10px] text-muted-foreground">{fmtN(v)} units</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Tab 4: Diagnosis ──────────────────────────────────────────── */}
        {tab === 4 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Issues</div>
              <div className="space-y-1.5">
                {(pain_points || []).map((p, i) => (
                  <div key={i} className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs border
                    ${p.severity === "high"   ? "bg-red-50 text-red-800 border-red-200" :
                      p.severity === "medium" ? "bg-amber-50 text-amber-800 border-amber-200" :
                                                "bg-emerald-50 text-emerald-800 border-emerald-200"}`}>
                    {p.severity === "none"
                      ? <CheckCircle size={12} weight="fill" className="mt-0.5 shrink-0 text-emerald-500" />
                      : <WarningCircle size={12} weight="fill" className={`mt-0.5 shrink-0 ${p.severity === "high" ? "text-red-500" : "text-amber-500"}`} />}
                    <span>{p.message}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Strengths</div>
              <div className="space-y-1.5">
                {(strengths || []).length > 0 ? (strengths || []).map((s, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs bg-emerald-50 text-emerald-800 border border-emerald-200">
                    <CheckCircle size={12} weight="fill" className="mt-0.5 shrink-0 text-emerald-600" />
                    <span>{s}</span>
                  </div>
                )) : (
                  <div className="text-xs text-muted-foreground">No notable standouts this period.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Store row (left sidebar list item) ─────────────────────────────────────
const StoreRow = ({ store, selected, onClick }) => {
  const cfg = STATUS_CFG[store.status] || STATUS_CFG.Watch;
  const rev = store.kpis.revenue;
  const tgt = store.target?.pct_of_target;
  const gap = store.august_target_path?.gap;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all
        ${selected
          ? `ring-2 ${cfg.ring} ${cfg.bg} border-transparent`
          : "border-border hover:bg-muted/60 bg-transparent"}`}
    >
      {/* Row 1: name + status */}
      <div className="flex items-start justify-between gap-1.5 mb-1">
        <span className={`text-xs font-semibold leading-tight ${selected ? cfg.text : ""}`}>
          {store.store.replace(/^Vivo\s+/i, "")}
        </span>
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 mt-1 ${cfg.dot}`} />
      </div>
      {/* Row 2: revenue + delta */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[11px] font-bold tabular-nums">{fmtKS(rev.current)}</span>
        <Delta val={rev.change_pct} size="xs" />
      </div>
      {/* Row 3: score bar */}
      <ScoreBar score={store.score} />
      {/* Row 4: target or gap */}
      {tgt != null ? (
        <TargetBar p={tgt} />
      ) : gap != null && gap > 0 ? (
        <div className="text-[10px] text-red-500 font-semibold mt-0.5">Gap {fmtKS(gap)}</div>
      ) : null}
    </button>
  );
};

// ─── Main page ────────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: "score",   label: "Health score" },
  { value: "revenue", label: "Revenue" },
  { value: "target",  label: "Target %" },
  { value: "gap",     label: "Aug gap" },
  { value: "name",    label: "Name" },
];

export default function StoreProfiling() {
  const { dateFrom, dateTo, country, channel } = useFilters();
  const [period, setPeriod]       = useState(28);
  const [sortBy, setSortBy]       = useState("score");
  const [filterStatus, setStatus] = useState("All");
  const [selectedStore, setSelected] = useState(null);

  const { data, loading, error } = api(
    `/analytics/store-profiling?period=${period}${country ? `&country=${encodeURIComponent(country)}` : ""}`,
    [period, country]
  );

  const stores = data?.stores || [];
  const medians = data?.country_medians || {};

  // Status counts
  const counts = useMemo(() => {
    const c = { Healthy: 0, Watch: 0, "At Risk": 0 };
    stores.forEach((s) => { if (c[s.status] != null) c[s.status]++; });
    return c;
  }, [stores]);

  // Sorted + filtered
  const visible = useMemo(() => {
    let list = filterStatus === "All" ? [...stores] : stores.filter((s) => s.status === filterStatus);
    list.sort((a, b) => {
      if (sortBy === "score")   return (b.score || 0) - (a.score || 0);
      if (sortBy === "revenue") return (b.kpis.revenue.current || 0) - (a.kpis.revenue.current || 0);
      if (sortBy === "target")  return (b.target?.pct_of_target || 0) - (a.target?.pct_of_target || 0);
      if (sortBy === "gap")     return (b.august_target_path?.gap || 0) - (a.august_target_path?.gap || 0);
      if (sortBy === "name")    return a.store.localeCompare(b.store);
      return 0;
    });
    return list;
  }, [stores, filterStatus, sortBy]);

  // Keep selected store data fresh
  const selectedData = useMemo(() => {
    if (!selectedStore) return null;
    return stores.find((s) => s.store === selectedStore) || null;
  }, [stores, selectedStore]);

  // Auto-select first store when data loads
  React.useEffect(() => {
    if (visible.length > 0 && !selectedStore) {
      setSelected(visible[0].store);
    }
  }, [visible.length]);

  if (loading) return <Loading />;
  if (error)   return <ErrorBox error={error} />;
  if (!stores.length) return <Empty message="No store data for this period" />;

  const priorLabel = data?.prior_range ? `${data.prior_range[0]} – ${data.prior_range[1]}` : "";
  const curLabel   = data?.current_range ? `${data.current_range[0]} – ${data.current_range[1]}` : "";

  return (
    <div className="px-4 py-4 space-y-4 max-w-full">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionTitle>Store Performance</SectionTitle>
          {curLabel && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {curLabel} vs {priorLabel}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period toggle */}
          <div className="flex rounded-lg border overflow-hidden text-xs font-semibold">
            {[28, 90].map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 transition-colors ${period === p ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
              >
                {p}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-2">
        {["Healthy", "Watch", "At Risk"].map((s) => {
          const cfg = STATUS_CFG[s];
          return (
            <button
              key={s}
              onClick={() => setStatus(filterStatus === s ? "All" : s)}
              className={`rounded-xl border p-2.5 text-left transition-all
                ${filterStatus === s ? `ring-2 ${cfg.ring} ${cfg.bg}` : "bg-card hover:bg-muted/40"}`}
            >
              <div className={`text-2xl font-black tabular-nums ${filterStatus === s ? cfg.text : ""}`}>{counts[s]}</div>
              <div className="flex items-center gap-1 text-xs font-semibold mt-0.5">
                <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                <span className={filterStatus === s ? cfg.text : "text-muted-foreground"}>{s}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Sort bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Sort:</span>
        <div className="flex gap-1 flex-wrap">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setSortBy(o.value)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                ${sortBy === o.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {filterStatus !== "All" && (
          <button
            onClick={() => setStatus("All")}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-muted text-muted-foreground hover:text-foreground"
          >
            Showing: {filterStatus} <X size={10} />
          </button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{visible.length} stores</span>
      </div>

      {/* Master-detail layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3" style={{ minHeight: "70vh" }}>
        {/* Left: store list */}
        <div className="lg:overflow-y-auto lg:max-h-[75vh] space-y-1 pr-1">
          {visible.map((s) => (
            <StoreRow
              key={s.store}
              store={s}
              selected={selectedStore === s.store}
              onClick={() => setSelected(s.store)}
            />
          ))}
        </div>

        {/* Right: detail panel */}
        <div className="rounded-xl border bg-card overflow-hidden lg:max-h-[75vh]">
          {selectedData ? (
            <StoreDetail store={selectedData} medians={medians} period={period} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-8">
              Select a store to see details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
