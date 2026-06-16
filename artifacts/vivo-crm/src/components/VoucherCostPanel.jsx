import React, { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";
import { api } from "@/lib/api";
import { Calculator, Gift, RefreshCw } from "lucide-react";

const fmtKES = (n) => `KES ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const PRESETS = [
  { label: "Next 30 days", from: () => todayISO(), to: () => addDaysISO(30) },
  { label: "Next 90 days", from: () => todayISO(), to: () => addDaysISO(90) },
  { label: "This month", from: () => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
    },
    to: () => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    },
  },
  { label: "Full year", from: () => todayISO(), to: () => addDaysISO(365) },
];

/**
 * Birthday-voucher cost projection. Lets a manager pick a future window
 * and see how many customers per tier will receive a birthday voucher,
 * plus the projected cost to the business at a configurable redemption rate
 * (50% default per the brief).
 */
export default function VoucherCostPanel({ config }) {
  const [dateFrom, setDateFrom] = useState(todayISO());
  const [dateTo, setDateTo] = useState(addDaysISO(30));
  const [redemptionRate, setRedemptionRate] = useState(50);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchCost = async (df, dt, rr) => {
    setLoading(true);
    try {
      const r = await api.get("/loyalty/voucher-cost", {
        params: { date_from: df, date_to: dt, redemption_rate: rr / 100 },
      });
      setData(r.data);
    } finally {
      setLoading(false);
    }
  };

  // Auto-load on mount + whenever the period changes
  useEffect(() => {
    fetchCost(dateFrom, dateTo, redemptionRate);
    // eslint-disable-next-line
  }, [dateFrom, dateTo, redemptionRate]);

  const voucherPerTier = config?.voucher_kes || { bronze: 2500, silver: 5000, gold: 10000 };

  return (
    <Card className="vivo-card p-6 rounded-sm" data-testid="voucher-cost-panel">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-sm bg-[var(--vivo-bg-soft)] flex items-center justify-center">
            <Calculator className="h-4 w-4 text-[var(--vivo-navy)]"/>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Forecast</div>
            <h3 className="font-display text-xl mt-0.5">Birthday voucher cost</h3>
            <p className="text-xs text-[var(--vivo-muted)] mt-1 max-w-md">
              How many customers per tier have a birthday in the selected window, and the projected cost assuming a {redemptionRate}% redemption rate.
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)]">Expected cost</div>
          <div className="font-display text-3xl text-[var(--vivo-navy)]" data-testid="voucher-cost-total">
            {data ? fmtKES(data.totals?.expected_cost_kes) : "—"}
          </div>
          {data && (
            <div className="text-[10px] text-[var(--vivo-muted)] mt-0.5">
              Gross liability: <strong className="text-[var(--vivo-navy)]">{fmtKES(data.totals?.gross_cost_kes)}</strong>
            </div>
          )}
        </div>
      </div>

      {/* Period controls */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => { setDateFrom(p.from()); setDateTo(p.to()); }}
            className="text-xs px-3 h-8 rounded-sm border border-[var(--vivo-border)] hover:bg-[var(--vivo-bg-soft)] press-effect"
            data-testid={`voucher-preset-${p.label.toLowerCase().replace(/ /g, "-")}`}
          >
            {p.label}
          </button>
        ))}
        <div className="flex items-center gap-2 text-xs">
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 w-36 rounded-sm border border-[var(--vivo-border)] text-xs"
            data-testid="voucher-date-from"
          />
          <span className="text-[var(--vivo-muted)]">→</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 w-36 rounded-sm border border-[var(--vivo-border)] text-xs"
            data-testid="voucher-date-to"
          />
        </div>
        <div className="flex items-center gap-2 text-xs ml-auto">
          <label className="text-[var(--vivo-muted)] uppercase tracking-wider text-[10px]">Redemption %</label>
          <Input
            type="number"
            min={0}
            max={100}
            value={redemptionRate}
            onChange={(e) => setRedemptionRate(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            className="h-8 w-20 rounded-sm border border-[var(--vivo-border)] text-xs"
            data-testid="voucher-redemption-rate"
          />
        </div>
      </div>

      {/* Per-tier breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="voucher-cost-tiers">
        {(data?.tiers || ["bronze", "silver", "gold"].map((t) => ({ tier: t, count: 0, voucher_kes: voucherPerTier[t] || 0, gross_cost_kes: 0, expected_cost_kes: 0 }))).map((row) => (
          <div
            key={row.tier}
            className="rounded-sm border border-[var(--vivo-border)] p-4"
            data-testid={`voucher-tier-${row.tier}`}
          >
            <div className="flex items-center justify-between mb-2">
              <LoyaltyBadge tier={row.tier}/>
              <span className="text-[10px] text-[var(--vivo-muted)]">{fmtKES(row.voucher_kes)} / voucher</span>
            </div>
            <div className="font-display text-2xl text-[var(--vivo-navy)]" data-testid={`voucher-tier-${row.tier}-count`}>{(row.count || 0).toLocaleString()}</div>
            <div className="text-xs text-[var(--vivo-muted)]">birthdays in window</div>
            <div className="mt-3 pt-3 border-t border-[var(--vivo-border)] text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--vivo-muted)]">Gross</span>
                <span className="font-mono-num">{fmtKES(row.gross_cost_kes)}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[var(--vivo-muted)]">Expected ({redemptionRate}%)</span>
                <span className="font-mono-num text-[var(--vivo-navy)] font-semibold">{fmtKES(row.expected_cost_kes)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--vivo-border)] text-xs text-[var(--vivo-muted)]">
        <div className="flex items-center gap-2">
          <Gift className="h-3.5 w-3.5"/>
          {loading ? "Calculating…" : (
            <>
              {data?.totals?.count?.toLocaleString() || 0} customers eligible ·
              {" "}
              {data?.days_in_window || 0} days in window
            </>
          )}
        </div>
        <button
          onClick={() => fetchCost(dateFrom, dateTo, redemptionRate)}
          disabled={loading}
          className="text-[var(--vivo-navy)] hover:underline inline-flex items-center gap-1 disabled:opacity-50"
          data-testid="voucher-cost-refresh"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}/>
          Refresh
        </button>
      </div>
    </Card>
  );
}
