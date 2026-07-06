import React, { useEffect, useMemo, useState } from "react";
import { api, countryColor } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import {
  Target, ShoppingBag, Users, Footprints, ArrowRight, Lightning, CalendarBlank,
} from "@phosphor-icons/react";

/**
 * Target Requirements — the "what it takes" reverse funnel.
 *
 * Reads /analytics/target-requirements (which itself reconciles with the
 * annual-targets tiles) and shows, for a chosen market, the operational
 * inputs a revenue target implies, working BACKWARDS:
 *
 *   revenue target ÷ average basket        → orders needed
 *   orders needed  ÷ conversion rate       → store visitors needed (retail)
 *   orders needed  ÷ orders-per-customer   → customers needed
 *
 * Plus a "still to go" band: the remaining revenue and the per-day run-rate
 * (orders / visitors / customers per day) over the days left in the year, so
 * the same card is also an actionable pace tool.
 */

// Compact KES — mirrors TargetsTracker.fmtKESCompact so the funnel headline
// matches the tiles above it.
function fmtKESCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `KES ${(v / 1_000).toFixed(0)}K`;
  return `KES ${v.toFixed(0)}`;
}

const fmtInt = (n) =>
  n == null ? "—" : Math.round(Number(n)).toLocaleString("en-US");

// One funnel stage card. `divisor` is the rate that links it to the previous
// stage (shown on the connector arrow), e.g. "÷ ABV KES 4,500".
function StageCard({ icon: Icon, label, value, sub, tone = "brand", na = false, testId }) {
  const tones = {
    brand: "border-[#fdba74] bg-white text-[#0f3d24]",
    orders: "border-[#c7d2fe] bg-[#eef2ff] text-[#312e81]",
    footfall: "border-[#bae6fd] bg-[#f0f9ff] text-[#075985]",
    customers: "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]",
  };
  const iconTones = {
    brand: "#c2410c", orders: "#4f46e5", footfall: "#0284c7", customers: "#16a34a",
  };
  return (
    <div
      className={`flex-1 min-w-[150px] rounded-xl border p-4 ${na ? "border-dashed border-[#e5e7eb] bg-[#f9fafb] text-[#9ca3af]" : tones[tone]}`}
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Icon size={16} weight="duotone" color={na ? "#9ca3af" : iconTones[tone]} />
        <span className="text-[11px] font-bold uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-[26px] font-extrabold leading-none tabular-nums" data-testid={testId ? `${testId}-value` : undefined}>
        {na ? "N/A" : value}
      </div>
      {sub && <div className="text-[11px] mt-1.5 opacity-80">{sub}</div>}
    </div>
  );
}

// Connector between two stages: a right arrow with the divisor label under it.
function Connector({ label }) {
  return (
    <div className="flex flex-col items-center justify-center px-1 shrink-0 self-center">
      <ArrowRight size={20} weight="bold" className="text-[#9ca3af]" />
      {label && (
        <span className="text-[9.5px] font-semibold text-[#6b7280] whitespace-nowrap mt-0.5">
          {label}
        </span>
      )}
    </div>
  );
}

export default function TargetFunnelCard({ year = 2026 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState("Overall"); // bucket name or "Overall"

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get("/analytics/target-requirements", { params: { year } })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((e) => {
        if (!cancelled)
          setError(e?.response?.data?.detail || e?.message || "Failed to load target requirements");
      });
    return () => { cancelled = true; };
  }, [year]);

  const options = useMemo(() => {
    if (!data) return [];
    return [data.overall, ...(data.buckets || [])];
  }, [data]);

  const active = useMemo(() => {
    if (!data) return null;
    if (selected === "Overall") return data.overall;
    return (data.buckets || []).find((b) => b.bucket === selected) || data.overall;
  }, [data, selected]);

  if (error) return <ErrorBox message={error} />;
  if (!active) {
    return (
      <div className="card-white p-5">
        <Loading label="Loading target requirements…" />
      </div>
    );
  }

  const isOverall = active.bucket === "Overall";
  const dot = isOverall ? "#1a5c38" : countryColor(active.label);
  const daysLeft = data.days_left;

  return (
    <div className="card-white p-5" data-testid="target-funnel-card">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <Target size={18} weight="duotone" className="text-[#1a5c38]" />
          <h3 className="text-[15px] font-extrabold text-[#0f3d24]">What it takes to hit target</h3>
          <span className="text-[10px] font-bold uppercase tracking-wide bg-[#fed7aa] text-[#7c2d12] px-1.5 py-0.5 rounded-full">
            Reverse funnel
          </span>
        </div>
        {/* Market selector */}
        <div className="flex flex-wrap gap-1.5" data-testid="target-funnel-market-pills">
          {options.map((o) => {
            const isSel = (selected === "Overall" && o.bucket === "Overall") || selected === o.bucket;
            return (
              <button
                key={o.bucket}
                type="button"
                onClick={() => setSelected(o.bucket)}
                data-testid={`target-funnel-pill-${o.label.toLowerCase()}`}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold border transition-colors ${
                  isSel
                    ? "border-[#1a5c38] bg-[#1a5c38] text-white"
                    : "border-border bg-white text-[#374151] hover:border-brand/60"
                }`}
              >
                {o.bucket !== "Overall" && (
                  <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: countryColor(o.label) }} />
                )}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[12px] text-[#6b7280] mb-4">
        {data.rate_basis} · {active.pct_achieved}% of the {year} target already banked.
      </p>

      {/* Headline: the target we're reverse-engineering */}
      <div
        className="rounded-xl border border-[#1a5c38] bg-gradient-to-br from-[#1a5c38] to-[#0f3d24] text-white p-4 mb-4 flex flex-wrap items-center justify-between gap-3"
        data-testid="target-funnel-headline"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/70">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: dot }} />
            {active.label} · {year} revenue target
          </div>
          <div className="text-[30px] font-extrabold leading-none tabular-nums mt-1" data-testid="target-funnel-target">
            {fmtKESCompact(active.target)}
          </div>
        </div>
        <div className="text-right text-[11px] text-white/75">
          <div>Banked: <span className="font-bold text-white tabular-nums">{fmtKESCompact(active.achieved)}</span></div>
          <div className="mt-0.5">Still to go: <span className="font-bold text-white tabular-nums">{fmtKESCompact(active.remaining)}</span></div>
        </div>
      </div>

      {/* The reverse funnel: target → orders → visitors / customers */}
      <div className="flex flex-wrap items-stretch gap-2" data-testid="target-funnel-stages">
        <StageCard
          icon={Target}
          label="Revenue target"
          value={fmtKESCompact(active.target)}
          sub={active.abv != null ? `Avg basket ${fmtKESCompact(active.abv)}` : "Avg basket n/a"}
          tone="brand"
          testId="target-funnel-stage-revenue"
        />
        <Connector label={active.abv != null ? `÷ basket ${fmtKESCompact(active.abv)}` : "÷ basket"} />
        <StageCard
          icon={ShoppingBag}
          label="Orders needed"
          value={fmtInt(active.orders_needed)}
          sub="Transactions to ring up"
          tone="orders"
          testId="target-funnel-stage-orders"
        />
        <Connector label={active.conversion != null ? `÷ conv ${active.conversion}%` : (active.has_footfall ? "÷ conversion" : "no store traffic")} />
        <StageCard
          icon={Footprints}
          label="Store visitors needed"
          value={fmtInt(active.footfall_needed)}
          sub={active.has_footfall ? "Footfall through the doors" : "Online has no store footfall"}
          tone="footfall"
          na={!active.has_footfall}
          testId="target-funnel-stage-footfall"
        />
        <Connector label={active.orders_per_customer != null ? `÷ ${active.orders_per_customer} ord/cust` : "÷ orders per cust"} />
        <StageCard
          icon={Users}
          label="Customers needed"
          value={fmtInt(active.customers_needed)}
          sub="Buying customers"
          tone="customers"
          testId="target-funnel-stage-customers"
        />
      </div>

      {/* Still-to-go run rate: what's left, per day for the rest of the year */}
      <div
        className="mt-4 rounded-xl border border-[#fed7aa] bg-[#fffbeb] p-4"
        data-testid="target-funnel-runrate"
      >
        <div className="flex items-center gap-1.5 mb-3">
          <Lightning size={15} weight="fill" className="text-[#c2410c]" />
          <span className="text-[12px] font-bold uppercase tracking-wide text-[#7c2d12]">
            Still to go
          </span>
          <span className="text-[11px] text-[#92400e] inline-flex items-center gap-1">
            <CalendarBlank size={12} weight="bold" /> {daysLeft} days left in {year}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <RunRate label="Revenue" total={fmtKESCompact(active.remaining)}
            perDay={daysLeft > 0 ? `${fmtKESCompact(active.remaining / daysLeft)}/day` : "—"} />
          <RunRate label="Orders" total={fmtInt(active.orders_remaining)}
            perDay={active.orders_per_day != null ? `${fmtInt(active.orders_per_day)}/day` : "—"} />
          <RunRate
            label="Store visitors"
            total={active.has_footfall ? fmtInt(active.footfall_remaining) : "N/A"}
            perDay={active.footfall_per_day != null ? `${fmtInt(active.footfall_per_day)}/day` : (active.has_footfall ? "—" : "no footfall")}
          />
          <RunRate label="Customers" total={fmtInt(active.customers_remaining)}
            perDay={active.customers_per_day != null ? `${fmtInt(active.customers_per_day)}/day` : "—"} />
        </div>
      </div>

      <p className="mt-3 text-[11px] text-[#9ca3af]">
        Requirements are reverse-engineered from this year's run-rates (average basket, conversion,
        orders per customer). Store-visitor figures cover retail markets only. Overall visitor/customer
        totals sum the individual markets.
      </p>
    </div>
  );
}

function RunRate({ label, total, perDay }) {
  return (
    <div className="rounded-lg bg-white border border-[#fde3c0] p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#92400e]">{label}</div>
      <div className="text-[18px] font-extrabold text-[#0f3d24] leading-tight tabular-nums">{total}</div>
      <div className="text-[11px] font-bold text-[#c2410c] tabular-nums">{perDay}</div>
    </div>
  );
}
