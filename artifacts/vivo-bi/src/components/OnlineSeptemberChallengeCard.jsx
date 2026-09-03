import React from "react";
import { ArrowUpRight, CalendarBlank, CircleNotch, Ticket, WarningCircle } from "@phosphor-icons/react";
import { fmtKES, fmtKESLong } from "@/lib/api";

const clampPct = (value) => Math.max(0, Math.min(100, Number(value) || 0));

export default function OnlineSeptemberChallengeCard({
  campaign,
  loading,
  error,
  onOpenSnapshot,
}) {
  if (loading) {
    return (
      <div className="card-white p-5" data-testid="online-september-challenge-loading">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <CircleNotch size={16} className="animate-spin text-brand" />
          Loading the Online September Challenge…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="card-white border-rose-200 p-5 text-rose-800"
        data-testid="online-september-challenge-error"
      >
        <div className="flex items-start gap-2">
          <WarningCircle size={18} weight="fill" className="shrink-0 mt-0.5" />
          <div>
            <div className="font-extrabold text-[14px]">Online September Challenge unavailable</div>
            <div className="text-[12px] mt-1">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!campaign) return null;

  const pct = clampPct(campaign.progress_pct);
  const projected = campaign.projection_meaningful && campaign.projected_landing_kes != null
    ? campaign.projected_landing_kes
    : null;
  const isWon = campaign.status === "won";
  const statusLabel = campaign.status === "prestart"
    ? "Starts 1 Sep"
    : isWon
      ? "Goal reached"
      : campaign.status === "closed"
        ? "Closed"
        : "Live challenge";

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-[#f4b183] bg-gradient-to-br from-[#fff7ed] via-[#ffedd5] to-[#fef3c7] p-5 shadow-sm"
      data-testid="online-september-challenge-card"
    >
      <div className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-[#fed7aa]/60" />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Ticket size={20} weight="duotone" className="text-[#c2410c]" />
            <span className="text-[10px] font-black uppercase tracking-[0.14em] text-[#9a3412]">
              Limited campaign
            </span>
          </div>
          <h2 className="mt-1 text-[20px] font-extrabold tracking-tight text-[#7c2d12]" data-testid="online-september-title">
            Online September Challenge
          </h2>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-[#9a3412]">
            <CalendarBlank size={13} weight="bold" />
            September 2026 · Online only
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${
            isWon ? "bg-emerald-100 text-emerald-800" : "bg-white/75 text-[#9a3412]"
          }`}
          data-testid="online-september-status"
        >
          {statusLabel}
        </span>
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#9a3412]">Achieved</div>
          <div className="mt-0.5 text-[20px] font-extrabold tabular-nums text-[#431407]" data-testid="online-september-achieved">
            {fmtKES(campaign.achieved_kes)}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#9a3412]">Finish line</div>
          <div className="mt-0.5 text-[20px] font-extrabold tabular-nums text-[#431407]" data-testid="online-september-goal">
            {fmtKES(campaign.goal_kes)}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#9a3412]">Progress</div>
          <div className="mt-0.5 text-[20px] font-extrabold tabular-nums text-[#c2410c]" data-testid="online-september-progress">
            {Number(campaign.progress_pct || 0).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#9a3412]">Voucher</div>
          <div className="mt-0.5 text-[20px] font-extrabold tabular-nums text-[#c2410c]" data-testid="online-september-reward">
            {fmtKES(campaign.reward_kes)}
          </div>
          <div className="text-[10px] font-semibold text-[#9a3412]">per employee</div>
        </div>
      </div>

      <div className="relative mt-4 h-3 overflow-hidden rounded-full bg-[#fed7aa]" aria-label={`${Number(campaign.progress_pct || 0).toFixed(1)} percent of goal achieved`}>
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#f97316] to-[#16a34a] transition-[width] duration-500"
          style={{ width: `${pct}%` }}
          data-testid="online-september-progress-meter"
        />
      </div>

      <div className="relative mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#7c2d12]">
        <span data-testid="online-september-context">
          {campaign.is_prestart
            ? "Pre-start · sales begin 1 Sep"
            : campaign.status === "closed"
              ? `Final result · as of ${campaign.as_of}`
              : `${campaign.days_remaining} days remaining · as of ${campaign.as_of}`}
        </span>
        {projected != null && (
          <span className="font-bold" data-testid="online-september-projection">
            Projected landing: {fmtKESLong(projected)}
          </span>
        )}
      </div>

      <div className="relative mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#fdba74]/70 pt-3">
        <p className="max-w-xl text-[12px] font-bold leading-snug text-[#7c2d12]" data-testid="online-september-message">
          {campaign.status_message}
        </p>
        <button
          type="button"
          onClick={onOpenSnapshot}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#1a5c38] px-3 py-2 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-[#0f3d24]"
          data-testid="online-september-open-snapshot"
        >
          Open shareable view
          <ArrowUpRight size={14} weight="bold" />
        </button>
      </div>
    </section>
  );
}