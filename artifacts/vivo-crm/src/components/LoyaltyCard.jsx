import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Award, Gift, Scissors, Sparkles, AlertTriangle, Calendar as CalIcon } from "lucide-react";

const fmtKES = (n) => `KES ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function LoyaltyCard({ customerId, customerName, sourceAliases = [] }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sourceKey, setSourceKey] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/loyalty/customer/${customerId}`, { params: sourceKey ? { source_key: sourceKey } : {} });
      setData(r.data);
    } catch (e) { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => {
    setSourceKey(sourceAliases.length === 1 ? sourceAliases[0].source_key : "");
  }, [customerId, sourceAliases]);
  useEffect(() => { if (sourceKey || sourceAliases.length <= 1) load(); }, [customerId, sourceKey]);

  if (loading) {
    if (sourceAliases.length > 1 && !sourceKey) {
      return (
        <div className="vivo-card p-5 rounded-sm">
          <div className="eyebrow">Loyalty programme</div>
          <p className="text-xs text-[var(--vivo-muted)] mt-2">Select the exact source account. Balances are never combined.</p>
          <select value="" onChange={(e) => setSourceKey(e.target.value)}
            className="mt-3 h-9 max-w-full rounded-sm border border-[var(--vivo-border)] bg-white px-2 font-mono-num"
            data-testid="loyalty-source-account">
            <option value="">Select exact source…</option>
            {sourceAliases.map((a) => <option key={a.source_key} value={a.source_key}>{a.source_key}</option>)}
          </select>
        </div>
      );
    }
    return (
      <div className="vivo-card p-5 rounded-sm" data-testid="loyalty-card-loading">
        <div className="text-xs uppercase tracking-wider text-[var(--vivo-muted)]">Loyalty</div>
        <div className="text-sm text-[var(--vivo-muted)] mt-2">Loading…</div>
      </div>
    );
  }
  if (!data) return null;

  const { tier, spend_12mo_kes, progress, retention, anniversary, voucher, tailoring, styling, benefits } = data;
  const normalizedTier = String(tier || "bronze").toLowerCase();

  const issueVoucher = async () => {
    setBusy(true);
    try {
      await api.post(`/loyalty/customer/${customerId}/voucher/issue`, { source_key: sourceKey });
      toast.success("Voucher issued");
      await load();
    } catch { toast.error("Could not issue voucher"); }
    setBusy(false);
  };
  const redeemVoucher = async () => {
    if (!voucher) return;
    setBusy(true);
    try {
      await api.post(`/loyalty/voucher/${voucher.voucher_id}/redeem`);
      toast.success("Voucher redeemed");
      await load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not redeem"); }
    setBusy(false);
  };
  const bookStyling = async () => {
    const dt = window.prompt("Schedule styling session — date (YYYY-MM-DD):");
    if (!dt) return;
    setBusy(true);
    try {
      await api.post(`/loyalty/customer/${customerId}/styling/book`, { scheduled_for: dt, source_key: sourceKey });
      toast.success("Styling session booked");
      await load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not book"); }
    setBusy(false);
  };

  return (
    <div className="vivo-card p-5 rounded-sm space-y-5" data-testid="loyalty-card">
      {/* Header */}
      {sourceAliases.length > 0 && (
        <label className="block text-xs text-[var(--vivo-muted)]">
          Loyalty source account
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}
            className="ml-2 h-8 max-w-full rounded-sm border border-[var(--vivo-border)] bg-white px-2 font-mono-num"
            data-testid="loyalty-source-account">
            <option value="">Select exact source…</option>
            {sourceAliases.map((a) => <option key={a.source_key} value={a.source_key}>{a.source_key}</option>)}
          </select>
        </label>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow inline-flex items-center gap-1.5"><Award className="h-3.5 w-3.5"/>Loyalty programme</div>
          <div className="flex items-center gap-3 mt-2">
            <LoyaltyBadge tier={tier} />
            <span className="text-sm font-semibold text-[var(--vivo-navy)]" data-testid="loyalty-spend-12mo">
              {fmtKES(spend_12mo_kes)} · last 12 mo
            </span>
          </div>
        </div>
        {anniversary?.in_grace_period && (
          <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-red-700 bg-red-50 border border-red-200 rounded-sm px-2 py-1" data-testid="loyalty-grace-warning">
            <AlertTriangle className="h-3 w-3"/>Grace period
          </span>
        )}
      </div>

      {/* Progress to next tier */}
      {progress?.next_tier && (
        <div data-testid="loyalty-progress">
          <div className="flex items-center justify-between text-xs text-[var(--vivo-muted)] mb-1">
            <span>Progress to <strong className="text-[var(--vivo-navy)] uppercase">{progress.next_tier}</strong></span>
            <span>{progress.percent}%</span>
          </div>
          <div className="h-2 w-full bg-[var(--vivo-bg)] rounded-sm overflow-hidden border border-[var(--vivo-border)]">
            <div
              className="h-full"
              style={{ width: `${progress.percent}%`, backgroundColor: progress.next_tier === "gold" ? "#D4A93B" : "#9CA3AF" }}
            />
          </div>
          <div className="text-[11px] text-[var(--vivo-muted)] mt-1">
            {fmtKES(progress.needed_kes)} more spend in the rolling 12-mo window
          </div>
        </div>
      )}

      {/* Retention */}
      {normalizedTier !== "bronze" && retention && (
        <div className="text-xs text-[var(--vivo-muted)]" data-testid="loyalty-retention">
          Retention: need {fmtKES(retention.required_kes)} / yr ·{" "}
          {retention.met ? (
            <span className="text-green-700 font-medium">on track</span>
          ) : (
            <span className="text-red-700 font-medium">short by {fmtKES(retention.shortfall_kes)}</span>
          )}
        </div>
      )}

      {/* Anniversary */}
      {anniversary?.first_purchase_date && (
        <div className="text-xs text-[var(--vivo-muted)] inline-flex items-center gap-1.5" data-testid="loyalty-anniversary">
          <CalIcon className="h-3 w-3"/>
          Enrolment anniversary in {anniversary.days_to_anniversary} day{anniversary.days_to_anniversary === 1 ? "" : "s"}
        </div>
      )}

      {/* Voucher */}
      <div className="border-t border-[var(--vivo-border)] pt-4" data-testid="loyalty-voucher-section">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold inline-flex items-center gap-2"><Gift className="h-4 w-4"/>Birthday voucher</div>
          {!voucher && (
            <button onClick={issueVoucher} disabled={busy} className="text-xs px-2 py-1 rounded-sm border border-[var(--vivo-gold)] text-[var(--vivo-navy)] hover:bg-[var(--vivo-bg)] disabled:opacity-50" data-testid="loyalty-issue-voucher">
              Issue manually
            </button>
          )}
        </div>
        {voucher ? (
          <div className="bg-[var(--vivo-bg)] border border-[var(--vivo-gold)] rounded-sm p-3 flex items-center justify-between" data-testid="loyalty-active-voucher">
            <div>
              <div className="font-semibold text-[var(--vivo-navy)]">{fmtKES(voucher.amount_kes)}</div>
              <div className="text-[11px] text-[var(--vivo-muted)]">
                Expires {voucher.expires_at?.slice(0, 10)} · {voucher.reason}
              </div>
            </div>
            <Button size="sm" onClick={redeemVoucher} disabled={busy} className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90 h-8" data-testid="loyalty-redeem-voucher">
              Redeem
            </Button>
          </div>
        ) : (
          <div className="text-xs text-[var(--vivo-muted)]">No active voucher</div>
        )}
      </div>

      {/* Tailoring */}
      <div className="border-t border-[var(--vivo-border)] pt-4" data-testid="loyalty-tailoring-section">
        <div className="text-sm font-semibold inline-flex items-center gap-2"><Scissors className="h-4 w-4"/>Tailoring</div>
        <div className="text-xs text-[var(--vivo-muted)] mt-1">
          {tailoring?.eligible
            ? <>Complimentary on in-store purchases · {tailoring.turnaround_days <= 2 ? "48-hour priority" : `${tailoring.turnaround_days}-day standard`}</>
            : "Pay-per-service (Silver and Gold receive it free)"}
        </div>
      </div>

      {/* Styling sessions (Gold) */}
      {tier === "gold" && (
        <div className="border-t border-[var(--vivo-border)] pt-4" data-testid="loyalty-styling-section">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold inline-flex items-center gap-2"><Sparkles className="h-4 w-4"/>Personal styling</div>
            <button onClick={bookStyling} disabled={busy || styling.remaining <= 0} className="text-xs px-2 py-1 rounded-sm border border-[var(--vivo-gold)] text-[var(--vivo-navy)] hover:bg-[var(--vivo-bg)] disabled:opacity-50" data-testid="loyalty-book-styling">
              Book session
            </button>
          </div>
          <div className="text-xs text-[var(--vivo-muted)]">
            {styling.remaining > 0
              ? <>{styling.remaining} of {styling.allowed_per_year} sessions remaining this year</>
              : <>Annual session used · additional at member rate</>}
          </div>
          {styling.sessions?.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {styling.sessions.slice(0, 3).map((s) => (
                <li key={s.session_id} className="flex items-center justify-between border-b border-[var(--vivo-border)] pb-1 last:border-0">
                  <span>{s.scheduled_for}</span>
                  <span className="text-[var(--vivo-muted)]">{s.stylist_name || "Unassigned"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Benefits expander */}
      <details className="border-t border-[var(--vivo-border)] pt-3" data-testid="loyalty-benefits">
        <summary className="text-xs font-semibold text-[var(--vivo-navy)] cursor-pointer">All {tier} benefits</summary>
        <ul className="mt-2 space-y-1 text-xs">
          {benefits?.map((b, i) => (
            <li key={i} className="flex items-start justify-between gap-2 border-b border-[var(--vivo-border)] pb-1 last:border-0">
              <span className="text-[var(--vivo-muted)]">{b.label}</span>
              <span className="text-[var(--vivo-navy)] font-medium text-right">{b.value}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export default LoyaltyCard;
