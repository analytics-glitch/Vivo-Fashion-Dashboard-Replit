import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChartBar } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import {
  PERIOD_PRESETS,
  accountingMonths,
  monthLabelLong,
  Tag,
} from "./finance/shared";
import PLStatement from "./finance/PLStatement";
import RevenueReport from "./finance/RevenueReport";
import CostOfRevenueReport from "./finance/CostOfRevenueReport";
import OpexReport from "./finance/OpexReport";
import PayrollReport from "./finance/PayrollReport";
import VendorReport from "./finance/VendorReport";
import KpiTrendReport from "./finance/KpiTrendReport";

// Finance Reports Suite — seven leadership-grade reports built on the official
// Odoo-structured `finance_pl_summary` view (GET /api/finance/pl) plus
// account-level detail (/finance/pl-detail) and vendor spend
// (/finance/expense-by-vendor). All KES, read-only, with per-report CSV export
// and data-honesty tags (not-closed = partial; cost anomaly = under review).
//
// The suite drives its OWN month-grain period (a P&L needs month granularity),
// independent of the global daily filter bar. The default period is the span of
// months that actually carry Odoo accounting (Feb 2026+).

const TABS = [
  { key: "pl", label: "P&L Statement", Comp: PLStatement },
  { key: "revenue", label: "Revenue", Comp: RevenueReport },
  { key: "cost", label: "Cost of Revenue", Comp: CostOfRevenueReport },
  { key: "opex", label: "Operating Expenses", Comp: OpexReport },
  { key: "payroll", label: "Payroll", Comp: PayrollReport },
  { key: "vendor", label: "Vendor Spend", Comp: VendorReport },
  { key: "trend", label: "P&L Trend & KPIs", Comp: KpiTrendReport },
];

const ym = (m) => String(m || "").slice(0, 7);

export default function Finance() {
  const [allMonths, setAllMonths] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("pl");
  const [range, setRange] = useState({ from: null, to: null });
  const defaultedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/finance/pl")
      .then((r) => {
        if (cancelled) return;
        const months = r.data?.months || [];
        setAllMonths(months);
      })
      .catch((e) => !cancelled && setError(e?.message || "Failed to load Finance data"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Default the period to the accounting span once, after data arrives.
  useEffect(() => {
    if (defaultedRef.current || allMonths.length === 0) return;
    const acct = accountingMonths(allMonths);
    const from = (acct[0] || allMonths[0]).month;
    const to = allMonths[allMonths.length - 1].month;
    setRange({ from, to });
    defaultedRef.current = true;
  }, [allMonths]);

  const bounds = useMemo(() => {
    if (allMonths.length === 0) return { min: null, max: null };
    return { min: ym(allMonths[0].month), max: ym(allMonths[allMonths.length - 1].month) };
  }, [allMonths]);

  const months = useMemo(() => {
    if (!range.from || !range.to) return [];
    return allMonths.filter((m) => m.month >= range.from && m.month <= range.to);
  }, [allMonths, range]);

  const periodLabel = range.from ? `${monthLabelLong(range.from)} – ${monthLabelLong(range.to)}` : "";

  const applyPreset = (preset) => {
    const { from, to } = preset.range();
    // Clamp to the months we actually have.
    const lo = bounds.min ? `${bounds.min}-01` : from;
    const hi = bounds.max ? `${bounds.max}-01` : to;
    setRange({ from: from < lo ? lo : from, to: to > hi ? hi : to });
  };

  const ActiveComp = TABS.find((t) => t.key === tab)?.Comp || PLStatement;

  return (
    <div className="space-y-5" data-testid="finance-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight flex items-center gap-2">
            <ChartBar size={22} weight="duotone" className="text-brand" />
            Finance Reports
          </h1>
          <p className="text-[13px] text-muted mt-1">
            Official Odoo Profit &amp; Loss, in Kenyan Shillings. {periodLabel && <span className="font-medium text-foreground">{periodLabel}</span>}
          </p>
        </div>
        <Tag tone="slate" title="Read-only · sourced from Odoo accounting (finance_pl_summary)">
          Read-only · KES
        </Tag>
      </div>

      {loading ? (
        <Loading label="Loading Finance data…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : allMonths.length === 0 ? (
        <ErrorBox message="No Finance data available." />
      ) : (
        <>
          {/* Period selector */}
          <div className="card-white p-3.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {PERIOD_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => applyPreset(p)}
                    data-testid={`finance-preset-${p.key}`}
                    className="text-[12px] font-medium px-2.5 py-1.5 rounded-md border border-border text-muted hover:text-brand hover:border-brand transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <label className="text-[12px] text-muted">From</label>
                <input
                  type="month"
                  value={ym(range.from)}
                  min={bounds.min}
                  max={ym(range.to)}
                  onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: `${e.target.value}-01` }))}
                  data-testid="finance-from"
                  className="text-[12.5px] border border-border rounded px-2 py-1 bg-white"
                />
                <label className="text-[12px] text-muted">To</label>
                <input
                  type="month"
                  value={ym(range.to)}
                  min={ym(range.from)}
                  max={bounds.max}
                  onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: `${e.target.value}-01` }))}
                  data-testid="finance-to"
                  className="text-[12.5px] border border-border rounded px-2 py-1 bg-white"
                />
              </div>
            </div>
          </div>

          {/* Tab nav */}
          <div className="border-b border-border">
            <nav className="flex flex-wrap -mb-px">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  data-testid={`finance-tab-${t.key}`}
                  className={`px-3.5 py-2.5 text-[13px] font-semibold border-b-2 transition-colors ${
                    tab === t.key
                      ? "border-brand text-brand"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Active report */}
          <ActiveComp months={months} allMonths={allMonths} fromMonth={range.from} toMonth={range.to} periodLabel={periodLabel} />
        </>
      )}
    </div>
  );
}
