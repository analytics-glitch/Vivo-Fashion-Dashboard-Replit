import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, countryColor } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import {
  Target, ShoppingBag, Users, Footprints, ArrowRight, Lightning,
  CalendarBlank, X, Storefront, TrendUp, TrendDown, Info,
} from "@phosphor-icons/react";

/**
 * TargetDrilldownModal — click a market tile on the Targets page to open a
 * focused popup that answers, for that market (or Overall):
 *
 *   • what's been achieved vs the target, and how far ahead / behind pace
 *   • WHAT IT TAKES to close the gap — the reverse funnel (orders → store
 *     visitors → customers still needed, plus per-day run-rate)
 *   • how each POS LOCATION in that market is tracking against its implied
 *     share of the target (achieved, implied target, ahead/behind, remaining,
 *     orders still to ring up, YoY)
 *
 * Data: /analytics/target-requirements (the market funnel — already reconciles
 * with the tiles) + /analytics/target-store-breakdown (the per-store rows).
 * Rendered via a body portal so a sticky table header can never paint over it.
 */

function fmtKESCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `KES ${(v / 1_000).toFixed(0)}K`;
  return `KES ${v.toFixed(0)}`;
}
const fmtInt = (n) => (n == null ? "—" : Math.round(Number(n)).toLocaleString("en-US"));

function StatCard({ label, value, tone = "plain", sub }) {
  const tones = {
    plain: "border-[#fde0c2] bg-white text-[#0f3d24]",
    brand: "border-[#1a5c38] bg-gradient-to-br from-[#1a5c38] to-[#0f3d24] text-white",
    good: "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]",
    bad: "border-[#fecaca] bg-[#fef2f2] text-[#991b1b]",
  };
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wide ${tone === "brand" ? "text-white/70" : "opacity-70"}`}>{label}</div>
      <div className="text-[19px] font-extrabold leading-tight tabular-nums mt-0.5">{value}</div>
      {sub && <div className={`text-[10.5px] mt-0.5 ${tone === "brand" ? "text-white/70" : "opacity-70"}`}>{sub}</div>}
    </div>
  );
}

function MiniStage({ icon: Icon, label, value, sub, tone = "brand", na = false }) {
  const tones = {
    brand: "border-[#fdba74] bg-white text-[#0f3d24]",
    orders: "border-[#c7d2fe] bg-[#eef2ff] text-[#312e81]",
    footfall: "border-[#bae6fd] bg-[#f0f9ff] text-[#075985]",
    customers: "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]",
  };
  const iconTones = { brand: "#c2410c", orders: "#4f46e5", footfall: "#0284c7", customers: "#16a34a" };
  return (
    <div className={`flex-1 min-w-[128px] rounded-xl border p-3 ${na ? "border-dashed border-[#e5e7eb] bg-[#f9fafb] text-[#9ca3af]" : tones[tone]}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={15} weight="duotone" color={na ? "#9ca3af" : iconTones[tone]} />
        <span className="text-[10.5px] font-bold uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-[22px] font-extrabold leading-none tabular-nums">{na ? "N/A" : value}</div>
      {sub && <div className="text-[10.5px] mt-1 opacity-80">{sub}</div>}
    </div>
  );
}

function Connector({ label }) {
  return (
    <div className="flex flex-col items-center justify-center px-0.5 shrink-0 self-center">
      <ArrowRight size={18} weight="bold" className="text-[#9ca3af]" />
      {label && <span className="text-[9px] font-semibold text-[#6b7280] whitespace-nowrap mt-0.5">{label}</span>}
    </div>
  );
}

// Ahead/behind-pace pill for a delta in percentage points.
function PacePill({ delta }) {
  if (delta == null) return <span className="text-[#9ca3af]">—</span>;
  const ahead = delta >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
        ahead ? "bg-[#dcfce7] text-[#166534]" : "bg-[#fee2e2] text-[#991b1b]"
      }`}
    >
      {ahead ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
      {ahead ? "+" : ""}{delta}%
    </span>
  );
}

export default function TargetDrilldownModal({ info, onClose }) {
  const { year, bucket, label } = info || {};
  const [funnel, setFunnel] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setError(null);
    setFunnel(null);
    setBreakdown(null);
    Promise.all([
      api.get("/analytics/target-requirements", { params: { year } }),
      api.get("/analytics/target-store-breakdown", { params: { year, bucket: bucket || "Overall" } }),
    ])
      .then(([fr, br]) => {
        if (cancelled) return;
        setFunnel(fr.data);
        setBreakdown(br.data);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e?.message || "Failed to load drill-down");
      });
    return () => { cancelled = true; };
  }, [info, year, bucket]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = useMemo(() => {
    if (!funnel) return null;
    if (!bucket || bucket === "Overall") return funnel.overall;
    return (funnel.buckets || []).find((b) => b.bucket === bucket) || funnel.overall;
  }, [funnel, bucket]);

  const dot = !bucket || bucket === "Overall" ? "#1a5c38" : countryColor(label);
  const daysLeft = funnel?.days_left ?? breakdown?.days_left;

  // Pace delta at market level (achieved vs expected-at-pace).
  const marketDelta = useMemo(() => {
    if (!breakdown || !breakdown.total) return null;
    const paceExp = breakdown.market_target * (breakdown.elapsed / breakdown.total);
    if (!paceExp) return null;
    return Math.round((breakdown.market_achieved / paceExp - 1) * 1000) / 10;
  }, [breakdown]);

  const body = (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center overflow-y-auto bg-black/50 backdrop-blur-sm p-3 sm:p-6"
      onClick={onClose}
      data-testid="target-drilldown-overlay"
    >
      <div
        className="relative w-full max-w-5xl my-4 rounded-2xl bg-[#fffdf9] shadow-2xl border border-[#fed7aa]"
        onClick={(e) => e.stopPropagation()}
        data-testid="target-drilldown-modal"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 rounded-t-2xl border-b border-[#fde0c2] bg-gradient-to-br from-[#1a5c38] to-[#0f3d24] text-white">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: dot }} />
            <div className="min-w-0">
              <div className="text-[15px] font-extrabold truncate">{label} · {year} target</div>
              <div className="text-[11px] text-white/70">Drill-down · achievement, pace & what it takes to close the gap</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-white/15 hover:bg-white/25 transition-colors"
            aria-label="Close"
            data-testid="target-drilldown-close"
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        <div className="p-5">
          {error && <ErrorBox message={error} />}
          {!error && (!active || !breakdown) && <Loading label="Loading drill-down…" />}

          {!error && active && breakdown && (
            <>
              {/* Top KPI row */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-5">
                <StatCard label="Target" value={fmtKESCompact(active.target)} tone="brand" />
                <StatCard label="Achieved" value={fmtKESCompact(active.achieved)} sub={`${active.pct_achieved}% of target`} />
                <StatCard label="Still to go" value={fmtKESCompact(active.remaining)} />
                <StatCard label="Projected landing" value={fmtKESCompact(breakdown.market_target ? Math.round(breakdown.market_achieved / (breakdown.elapsed || 1) * (breakdown.total || 1)) : 0)} />
                <StatCard
                  label="vs Pace"
                  value={marketDelta == null ? "—" : `${marketDelta >= 0 ? "+" : ""}${marketDelta}%`}
                  tone={marketDelta == null ? "plain" : marketDelta >= 0 ? "good" : "bad"}
                  sub={marketDelta == null ? "" : marketDelta >= 0 ? "ahead of pace" : "behind pace"}
                />
                <StatCard label="Days left" value={fmtInt(daysLeft)} sub={`in ${year}`} />
              </div>

              {/* What it takes — reverse funnel */}
              <div className="flex items-center gap-1.5 mb-2">
                <Target size={15} weight="duotone" className="text-[#1a5c38]" />
                <h4 className="text-[13px] font-extrabold text-[#0f3d24]">What it takes to hit the target</h4>
                <span className="text-[9.5px] font-bold uppercase tracking-wide bg-[#fed7aa] text-[#7c2d12] px-1.5 py-0.5 rounded-full">Reverse funnel</span>
              </div>
              <div className="flex flex-wrap items-stretch gap-1.5 mb-3">
                <MiniStage icon={Target} label="Revenue target" value={fmtKESCompact(active.target)} sub={active.abv != null ? `Avg basket ${fmtKESCompact(active.abv)}` : "Avg basket n/a"} tone="brand" />
                <Connector label={active.abv != null ? `÷ basket` : "÷ basket"} />
                <MiniStage icon={ShoppingBag} label="Orders needed" value={fmtInt(active.orders_needed)} sub="Transactions to ring up" tone="orders" />
                <Connector label={active.conversion != null ? `÷ conv ${active.conversion}%` : (active.has_footfall ? "÷ conv" : "no traffic")} />
                <MiniStage icon={Footprints} label="Store visitors" value={fmtInt(active.footfall_needed)} sub={active.has_footfall ? "Footfall needed" : "Online has no footfall"} tone="footfall" na={!active.has_footfall} />
                <Connector label={active.orders_per_customer != null ? `÷ ${active.orders_per_customer}/cust` : "÷ ord/cust"} />
                <MiniStage icon={Users} label="Customers needed" value={fmtInt(active.customers_needed)} sub="Buying customers" tone="customers" />
              </div>

              {/* Still to go run-rate */}
              <div className="rounded-xl border border-[#fed7aa] bg-[#fffbeb] p-3.5 mb-5">
                <div className="flex items-center gap-1.5 mb-2.5">
                  <Lightning size={14} weight="fill" className="text-[#c2410c]" />
                  <span className="text-[11.5px] font-bold uppercase tracking-wide text-[#7c2d12]">Still to go — daily run-rate</span>
                  <span className="text-[10.5px] text-[#92400e] inline-flex items-center gap-1"><CalendarBlank size={11} weight="bold" /> {fmtInt(daysLeft)} days left</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <RunRate label="Revenue" total={fmtKESCompact(active.remaining)} perDay={daysLeft > 0 ? `${fmtKESCompact(active.remaining / daysLeft)}/day` : "—"} />
                  <RunRate label="Orders" total={fmtInt(active.orders_remaining)} perDay={active.orders_per_day != null ? `${fmtInt(active.orders_per_day)}/day` : "—"} />
                  <RunRate label="Store visitors" total={active.has_footfall ? fmtInt(active.footfall_remaining) : "N/A"} perDay={active.footfall_per_day != null ? `${fmtInt(active.footfall_per_day)}/day` : (active.has_footfall ? "—" : "no footfall")} />
                  <RunRate label="Customers" total={fmtInt(active.customers_remaining)} perDay={active.customers_per_day != null ? `${fmtInt(active.customers_per_day)}/day` : "—"} />
                </div>
              </div>

              {/* Per-store breakdown */}
              <div className="flex items-center gap-1.5 mb-2">
                <Storefront size={15} weight="duotone" className="text-[#1a5c38]" />
                <h4 className="text-[13px] font-extrabold text-[#0f3d24]">By selling point ({breakdown.store_count})</h4>
              </div>
              <div className="overflow-x-auto rounded-xl border border-[#fde0c2]">
                <table className="w-full text-[12px] border-collapse">
                  <thead>
                    <tr className="bg-[#fdf0e0] text-[#7c2d12] text-left">
                      <th className="px-3 py-2 font-bold">Selling point</th>
                      <th className="px-3 py-2 font-bold text-right">Achieved</th>
                      <th className="px-3 py-2 font-bold text-right">Implied target</th>
                      <th className="px-3 py-2 font-bold text-center">vs Pace</th>
                      <th className="px-3 py-2 font-bold text-right">Still to go</th>
                      <th className="px-3 py-2 font-bold text-right">Orders to go</th>
                      <th className="px-3 py-2 font-bold text-right">YoY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.stores.map((s, i) => (
                      <tr key={s.store} className={i % 2 ? "bg-white" : "bg-[#fffdf9]"}>
                        <td className="px-3 py-2 font-semibold text-[#0f3d24]">
                          {s.store}
                          {s.is_new && <span className="ml-1.5 text-[9.5px] font-bold uppercase bg-[#e0e7ff] text-[#3730a3] px-1 py-0.5 rounded">new</span>}
                          {(!bucket || bucket === "Overall") && s.market && <span className="ml-1.5 text-[10px] text-[#9ca3af]">{s.market}</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold text-[#0f3d24]">{fmtKESCompact(s.achieved)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[#6b7280]">{s.implied_target == null ? "—" : fmtKESCompact(s.implied_target)}</td>
                        <td className="px-3 py-2 text-center"><PacePill delta={s.delta_pct} /></td>
                        <td className="px-3 py-2 text-right tabular-nums text-[#6b7280]">{s.remaining == null ? "—" : fmtKESCompact(s.remaining)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[#312e81]">{fmtInt(s.orders_to_go)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${s.yoy_pct == null ? "text-[#9ca3af]" : s.yoy_pct >= 0 ? "text-[#166534]" : "text-[#991b1b]"}`}>
                          {s.yoy_pct == null ? "—" : `${s.yoy_pct >= 0 ? "+" : ""}${s.yoy_pct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-3 text-[11px] text-[#9ca3af] flex items-start gap-1.5">
                <Info size={13} weight="bold" className="mt-0.5 shrink-0" />
                <span>{breakdown.basis} "vs Pace" compares each store's achieved to its implied target scaled to the elapsed part of the year. "Orders to go" uses each store's own average basket.</span>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

function RunRate({ label, total, perDay }) {
  return (
    <div className="rounded-lg bg-white border border-[#fde3c0] p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#92400e]">{label}</div>
      <div className="text-[16px] font-extrabold text-[#0f3d24] leading-tight tabular-nums">{total}</div>
      <div className="text-[11px] font-bold text-[#c2410c] tabular-nums">{perDay}</div>
    </div>
  );
}
