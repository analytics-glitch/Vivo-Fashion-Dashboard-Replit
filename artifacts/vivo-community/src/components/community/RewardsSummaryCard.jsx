import React from 'react';
import { TierBadge, JohariWordmark } from "./ui";

// Johari rewards summary — the dark editorial band with tier badge, greeting,
// available balance, voucher nudge and the tier-progress bar. Lives at the
// very top of the Account/Profile tab (moved from the Rewards tab hero).
export default function RewardsSummaryCard({ member }) {
  const m = member || {};
  const points = m.points ?? 0;
  // Tier progress runs on lifetime earn — redeeming a reward never walks
  // the bar (or the tier) backwards. `points` is the spendable balance.
  const lifetimePoints = m.lifetime_points ?? points;
  const maxTierPoints = 1000;
  const progressPercent = Math.min((lifetimePoints / maxTierPoints) * 100, 100);
  const firstName = String(m.full_name || m.name || "").trim().split(/\s+/)[0] || "";
  // Display-only framing: the KES 500-per-300-pts voucher already on the
  // redemption ladder, expressed as what her balance could reach today.
  const voucherValue = Math.floor(points / 300) * 500;

  return (
    <div data-testid="rewards-balance-card" className="relative overflow-hidden rounded bg-foreground text-background p-6 sm:p-9 -mx-4 sm:mx-0">
      <div className="absolute top-0 right-0 w-52 h-52 bg-white/5 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />
      <div className="flex items-center justify-between gap-4 mb-5">
        <div data-testid="johari-wordmark" className="text-[12px] text-background/70"><JohariWordmark withVivo /></div>
        <TierBadge tier={m.tier} />
      </div>
      <h2 className="font-serif text-2xl sm:text-3xl leading-tight mb-1 text-background">
        {firstName ? `You shine, ${firstName}.` : "You shine."}
      </h2>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-4">
        <div data-testid="rewards-points" className="font-serif font-light text-4xl sm:text-5xl tracking-tight">
          {points.toLocaleString()} <span className="text-xl italic opacity-60">pts</span>
        </div>
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-background/60">Available Balance</span>
      </div>
      <p data-testid="rewards-value" className="text-[13px] text-background/75 mt-2">
        {voucherValue > 0
          ? <>Worth up to <span className="font-medium text-background">KES {voucherValue.toLocaleString()}</span> in vouchers — or keep climbing the ladder on the Rewards tab.</>
          : <>{(300 - points).toLocaleString()} pts to your first KES 500 voucher.</>}
      </p>
      <div className="mt-6">
        <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wider text-background/60 mb-2">
          <span>Tier Progress</span>
          <span className="text-background/90">{lifetimePoints >= maxTierPoints ? 'Max Tier Reached' : `${(maxTierPoints - lifetimePoints).toLocaleString()} pts to next tier`}</span>
        </div>
        <div className="h-1 bg-white/15 rounded-full overflow-hidden relative">
          <div className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="flex justify-between mt-2 text-[10px] uppercase font-bold tracking-wider text-background/50">
          <span>Tsavorite</span>
          <span className={lifetimePoints >= 500 ? 'text-background/90' : ''}>Ruby (500+)</span>
          <span className={lifetimePoints >= 1000 ? 'text-background/90' : ''}>Tanzanite (1,000+)</span>
        </div>
      </div>
    </div>
  );
}
