import React, { useEffect, useMemo, useState } from "react";
import { api, fmtKES, fmtNum, fmtPct, countryColor } from "@/lib/api";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { SortableTable, exportCSV } from "@/components/SortableTable";
import { Target, TrendUp, TrendDown, Buildings, Info } from "@phosphor-icons/react";

/**
 * Quarterly Target Scorecard (leadership + admin).
 *
 * A read-only executive scorecard for the CURRENT quarter (defaults to
 * whatever quarter today falls in — Q3 Jul–Sep 2026 for this cycle). All
 * figures come from ONE call to GET /api/analytics/quarter-scorecard, which
 * derives revenue targets from the seeded leadership budget and auto-derives
 * every other metric from last-year's same-quarter actuals × the budget
 * growth factor. Money is KES, net of returns. Nothing is editable here.
 *
 * Sections:
 *   1. Header strip — quarter window, completion, days left, growth factor.
 *   2. Revenue scorecard — one card per market/channel + a Total card
 *      (Q3 target, Q3-to-date actual, progress %, vs-LY-Q3 to-date).
 *   3. Derived-metric scorecard — Conversion, Footfall, New/Return Customers,
 *      Turn-In, Made in Africa Qty, Qty to Buy, Qty to Produce.
 *   4. Per-store goals table — revenue target (share-allocated), actual,
 *      progress, required run-rate, ahead/behind, and share-allocated count
 *      targets. Sortable + CSV export.
 */

// KES compact for the tile face — millions / thousands.
function fmtKESCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `KES ${(v / 1_000).toFixed(0)}K`;
  return `KES ${v.toFixed(0)}`;
}

function progColor(pct) {
  const v = Number(pct) || 0;
  if (v >= 100) return "#00c853";
  if (v >= 70) return "#d97706";
  return "#dc2626";
}

function ProgressRing({ pct, size = 84, stroke = 8, color = "#00c853", trackColor = "#fde7c5" }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const dash = (clamped / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rotate-[-90deg]">
      <circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor} strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        stroke={color} strokeWidth={stroke} fill="none"
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.22, 1, 0.36, 1)" }}
      />
    </svg>
  );
}

// A YoY delta chip (green up / red down). `pp` renders as percentage points.
function YoYChip({ value, pp = false, testId }) {
  if (value == null) return <span className="text-[11px] text-muted">—</span>;
  const up = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-bold tabular-nums ${
        up ? "text-[#166534]" : "text-[#9f1239]"
      }`}
      data-testid={testId}
    >
      {up ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
      {up ? "+" : ""}{Number(value).toFixed(1)}{pp ? "pp" : "%"}
    </span>
  );
}

// ── Revenue tile ─────────────────────────────────────────────────────
function RevenueTile({ row, started, isTotal }) {
  const pct = Number(row.pct) || 0;
  const color = progColor(pct);
  const dotColor = !isTotal ? countryColor(row.bucket) : null;
  const slug = row.bucket.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div
      className={`relative overflow-hidden rounded-xl border p-4 ${
        isTotal
          ? "border-[#1a5c38] bg-gradient-to-br from-[#1a5c38] to-[#0f3d24] text-white shadow-lg"
          : "border-[#fdba74] bg-white"
      }`}
      data-testid={`qsc-rev-tile-${slug}`}
    >
      <div className="flex items-center gap-1.5 mb-3 min-w-0">
        {!isTotal && <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} aria-hidden />}
        <span className={`text-[12px] font-bold uppercase tracking-wide truncate ${isTotal ? "text-white/90" : "text-[#1a5c38]"}`}>
          {row.bucket}
        </span>
        {row.sheet_gap && (
          <span
            className="ml-auto text-[9px] font-bold uppercase bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full shrink-0"
            title="This market's budget differs slightly from the leadership summary sheet; the seeded budget value is shown as-is."
          >
            sheet Δ
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative shrink-0" style={{ width: 84, height: 84 }}>
          <ProgressRing
            pct={pct}
            color={color}
            trackColor={isTotal ? "rgba(255,255,255,0.15)" : "#fde7c5"}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className={`text-[15px] font-extrabold leading-none ${isTotal ? "text-white" : "text-[#1a5c38]"}`}>
              {started ? `${pct.toFixed(0)}%` : "—"}
            </div>
            <div className={`text-[9px] font-semibold uppercase mt-0.5 ${isTotal ? "text-white/70" : "text-[#6b7280]"}`}>
              of target
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className={`text-[10px] font-semibold uppercase tracking-wide ${isTotal ? "text-white/65" : "text-[#6b7280]"}`}>Q-to-date</div>
          <div className={`text-[17px] font-extrabold leading-tight tabular-nums ${isTotal ? "text-white" : "text-[#0f3d24]"}`} data-testid={`qsc-rev-actual-${slug}`}>
            {fmtKESCompact(row.actual)}
          </div>
          <div className={`text-[10.5px] mt-1 ${isTotal ? "text-white/65" : "text-[#6b7280]"}`}>
            Target {fmtKESCompact(row.target)}
          </div>
        </div>
      </div>

      <div className={`mt-3 pt-3 border-t ${isTotal ? "border-white/15" : "border-[#fde0c2]"} flex items-center justify-between`}>
        <span className={`text-[10.5px] ${isTotal ? "text-white/65" : "text-[#6b7280]"}`} title="vs the same period last-year Q3 (to date)">vs LY Q-to-date</span>
        <YoYChip value={row.yoy_pct} testId={`qsc-rev-yoy-${slug}`} />
      </div>
    </div>
  );
}

// ── Metric scorecard row ─────────────────────────────────────────────
function MetricCard({ m }) {
  const isRate = m.kind === "rate";
  const fmtVal = (v) => {
    if (v == null) return "—";
    return isRate ? `${Number(v).toFixed(1)}%` : fmtNum(v);
  };
  const pct = m.pct;
  return (
    <div
      className={`rounded-xl border p-4 ${m.available ? "border-border bg-white" : "border-dashed border-border bg-neutral-50"}`}
      data-testid={`qsc-metric-${m.key}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[12px] font-bold uppercase tracking-wide text-[#1a5c38]">{m.label}</span>
        {!m.available && (
          <span className="text-[9px] font-bold uppercase bg-neutral-200 text-neutral-600 px-1.5 py-0.5 rounded-full shrink-0" title={m.note}>
            N/A
          </span>
        )}
      </div>

      {m.available ? (
        <>
          <div className="flex items-end justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase text-[#6b7280]">Actual</div>
              <div className="text-[18px] font-extrabold text-[#0f3d24] tabular-nums leading-tight">{fmtVal(m.actual)}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold uppercase text-[#6b7280]">Target</div>
              <div className="text-[14px] font-bold text-[#1a5c38] tabular-nums leading-tight">{fmtVal(m.target)}</div>
            </div>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-neutral-100 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(0, Math.min(100, Number(pct) || 0))}%`, backgroundColor: progColor(pct) }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-[#6b7280] tabular-nums">
              {pct == null ? "—" : `${Number(pct).toFixed(0)}% of target`}
            </span>
            <YoYChip value={m.yoy_pct} pp={isRate} testId={`qsc-metric-yoy-${m.key}`} />
          </div>
          {m.basis && (
            <p className="mt-2 pt-2 border-t border-neutral-100 text-[10.5px] text-[#6b7280] leading-snug" data-testid={`qsc-metric-basis-${m.key}`}>
              <span className="font-semibold uppercase tracking-wide text-[9px] text-[#9ca3af]">Basis</span>{" "}
              {m.basis}{m.note ? ` · ${m.note}` : ""}
            </p>
          )}
        </>
      ) : (
        <p className="text-[11.5px] text-[#6b7280] leading-snug">{m.note}</p>
      )}
    </div>
  );
}

export default function QuarterScorecard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.get("/analytics/quarter-scorecard")
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e?.message || "Failed to load scorecard"); });
    return () => { cancelled = true; };
  }, []);

  const storeColumns = useMemo(() => ([
    { key: "store", label: "Store / Channel", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.store}</span> },
    { key: "market", label: "Market",
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: countryColor(r.market) }} />
          {r.market}
        </span>
      ) },
    { key: "share_pct", label: "Share of Market", numeric: true, render: (r) => fmtPct(r.share_pct) },
    { key: "rev_target", label: "Rev Target", numeric: true, render: (r) => fmtKES(r.rev_target) },
    { key: "rev_actual", label: "Rev Actual", numeric: true, render: (r) => fmtKES(r.rev_actual) },
    { key: "pct", label: "Progress", numeric: true,
      render: (r) => <span style={{ color: progColor(r.pct) }} className="font-semibold">{fmtPct(r.pct)}</span> },
    { key: "required_run_rate", label: "Req. Run-Rate / day", numeric: true, render: (r) => fmtKES(r.required_run_rate) },
    { key: "status", label: "Pace", sortable: true,
      sortValue: (r) => (r.status === "ahead" ? 2 : r.status === "behind" ? 0 : 1),
      render: (r) => {
        if (r.status === "not_started") return <span className="text-muted text-[11px]">not started</span>;
        const ahead = r.status === "ahead";
        return (
          <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${
            ahead ? "bg-[#dcfce7] text-[#166534]" : "bg-[#fee2e2] text-[#9f1239]"
          }`}>
            {ahead ? <TrendUp size={11} weight="bold" /> : <TrendDown size={11} weight="bold" />}
            {ahead ? "Ahead" : "Behind"}
          </span>
        );
      } },
    { key: "footfall_target", label: "Footfall Target", numeric: true, render: (r) => fmtNum(r.footfall_target) },
    { key: "new_customers_target", label: "New Cust. Target", numeric: true, render: (r) => fmtNum(r.new_customers_target) },
    { key: "return_customers_target", label: "Return Cust. Target", numeric: true, render: (r) => fmtNum(r.return_customers_target) },
    { key: "made_in_africa_target", label: "Made-in-Africa Target", numeric: true, render: (r) => fmtNum(r.made_in_africa_target) },
    { key: "conversion_target", label: "Conv. Target", numeric: true, render: (r) => (r.conversion_target == null ? "—" : `${Number(r.conversion_target).toFixed(1)}%`) },
    { key: "turn_in_target", label: "Turn-In Target", numeric: true, render: (r) => (r.turn_in_target == null ? "—" : `${Number(r.turn_in_target).toFixed(1)}%`) },
  ]), []);

  const exportStores = () => {
    if (!data?.stores?.length) return;
    exportCSV(
      data.stores,
      [
        { key: "store", label: "Store / Channel" },
        { key: "market", label: "Market" },
        { key: "share_pct", label: "Share of Market %" },
        { key: "rev_target", label: "Revenue Target (KES)" },
        { key: "rev_actual", label: "Revenue Actual (KES)" },
        { key: "pct", label: "Progress %" },
        { key: "pace_expected", label: "Pace-Expected (KES)" },
        { key: "required_run_rate", label: "Required Run-Rate / day (KES)" },
        { key: "status", label: "Pace" },
        { key: "footfall_target", label: "Footfall Target" },
        { key: "new_customers_target", label: "New Customers Target" },
        { key: "return_customers_target", label: "Return Customers Target" },
        { key: "made_in_africa_target", label: "Made-in-Africa Target" },
        { key: "conversion_target", label: "Conversion Target %" },
        { key: "turn_in_target", label: "Turn-In Target %" },
      ],
      `${data.quarter}-${data.year}-store-scorecard.csv`
    );
  };

  if (error) return <ErrorBox message={error} />;
  if (!data) return (
    <div className="space-y-6">
      <SectionTitle title="Quarterly Scorecard" subtitle="Per-store targets for the current quarter" />
      <Loading label="Loading scorecard…" />
    </div>
  );

  const qLabel = `${data.quarter} ${data.year}`;
  const winStart = new Date(data.quarter_start);
  const winEnd = new Date(data.quarter_end);
  const fmtD = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const revenueRows = data.revenue || [];
  const total = data.revenue_total;

  return (
    <div className="space-y-6" data-testid="quarter-scorecard-page">
      <SectionTitle
        title={`${qLabel} Target Scorecard`}
        subtitle={`${fmtD(winStart)} – ${fmtD(winEnd)}, ${data.year} · Quarterly goals by market, metric & store · money KES, net of returns`}
      />

      {/* Header strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card-white p-4">
          <div className="text-[11px] font-semibold uppercase text-[#6b7280]">Quarter completion</div>
          <div className="text-[22px] font-extrabold text-[#0f3d24] tabular-nums">{fmtPct(data.completion_pct)}</div>
          <div className="text-[11px] text-[#6b7280] mt-0.5">Day {data.days_elapsed} of {data.days_total}</div>
        </div>
        <div className="card-white p-4">
          <div className="text-[11px] font-semibold uppercase text-[#6b7280]">Days remaining</div>
          <div className="text-[22px] font-extrabold text-[#0f3d24] tabular-nums">{fmtNum(data.days_left)}</div>
          <div className="text-[11px] text-[#6b7280] mt-0.5">{data.started ? "in progress" : "not started"}</div>
        </div>
        <div className="card-white p-4">
          <div className="text-[11px] font-semibold uppercase text-[#6b7280]">Growth factor</div>
          <div className="text-[22px] font-extrabold text-[#0f3d24] tabular-nums">×{Number(data.growth_factor).toFixed(3)}</div>
          <div className="text-[11px] text-[#6b7280] mt-0.5">budget ÷ LY-Q actual</div>
        </div>
        <div className="card-white p-4">
          <div className="text-[11px] font-semibold uppercase text-[#6b7280]">Total revenue target</div>
          <div className="text-[22px] font-extrabold text-[#1a5c38] tabular-nums">{fmtKESCompact(total?.target)}</div>
          <div className="text-[11px] text-[#6b7280] mt-0.5">{fmtKESCompact(total?.actual)} to date</div>
        </div>
      </div>

      {/* Revenue scorecard */}
      <div>
        <SectionTitle title="Revenue targets by market & channel" subtitle="Gross-net revenue vs the seeded leadership budget" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 mt-3">
          {revenueRows.map((r) => (
            <RevenueTile key={r.bucket} row={r} started={data.started} />
          ))}
          {total && <RevenueTile row={total} started={data.started} isTotal />}
        </div>
        {data.revenue_note && (
          <p className="mt-2 text-[11px] text-[#6b7280] flex items-start gap-1.5">
            <Info size={13} className="mt-0.5 shrink-0" /> {data.revenue_note}
          </p>
        )}
      </div>

      {/* Derived-metric scorecard */}
      <div>
        <SectionTitle
          title="Operational metric targets"
          subtitle="Auto-derived from last-year same-quarter actuals × growth (counts) or held with a small capped uplift (rates)"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
          {(data.metrics || []).map((m) => <MetricCard key={m.key} m={m} />)}
        </div>
      </div>

      {/* Per-store goals */}
      <div>
        <SectionTitle
          title="Per-store goals"
          subtitle="Each store's targets are its trailing-12-month share within its own market; revenue & count goals split the market target by that share, rate goals use the market's LY rate"
          action={
            data.stores?.length ? (
              <button
                type="button"
                onClick={exportStores}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-semibold border border-border bg-white hover:border-brand/60 hover:text-brand transition-colors"
                data-testid="qsc-export-stores"
              >
                Export CSV
              </button>
            ) : null
          }
        />
        <div className="mt-3">
          {data.stores?.length ? (
            <SortableTable
              columns={storeColumns}
              rows={data.stores}
              initialSort={{ key: "rev_target", dir: "desc" }}
              testId="qsc-store-table"
              emptyLabel="No store goals for this quarter"
            />
          ) : (
            <Empty label="No store goals available for this quarter." />
          )}
        </div>
      </div>
    </div>
  );
}
