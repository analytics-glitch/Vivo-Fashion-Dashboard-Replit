import React from 'react';
import { TierBadge } from "./ui";
import { Star, Gift, ShoppingBag, Receipt, Ticket, Sparkle, MagicWand, VideoCamera, Ruler, UsersThree, CalendarCheck } from "@phosphor-icons/react";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function TabRewards({ member }) {
  const m = member || {};
  const points = m.points ?? 0;
  const maxTierPoints = 1000;
  const progressPercent = Math.min((points / maxTierPoints) * 100, 100);

  const transactions = [
    ...(m.recent_orders || []).map((o, i) => ({
      id: `order-${i}`,
      action: `Purchase ${o.order}`,
      date: fmtDate(o.date),
      pts: `+${o.pts}`,
      status: "Posted",
    })),
    {
      id: "welcome",
      action: "Joined Vivo Community 🎉",
      date: m.joined || "",
      pts: "+200",
      status: "Posted",
    },
  ];

  const earnWays = [
    { title: "Purchases", pts: "1 pt per 50 KES", icon: <ShoppingBag weight="fill" size={24} /> },
    { title: "Text Review", pts: "10 pts", icon: <Receipt weight="fill" size={24} /> },
    { title: "Photo Review", pts: "25 pts", icon: <Star weight="fill" size={24} /> },
    { title: "Video Review", pts: "40 pts", icon: <VideoCamera weight="fill" size={24} /> },
    { title: "Style Post", pts: "30 pts", icon: <Gift weight="fill" size={24} /> },
    { title: "Fit Notes", pts: "15 pts", icon: <Ruler weight="fill" size={24} /> },
    { title: "Join Challenge", pts: "Up to 150 pts", icon: <Ticket weight="fill" size={24} /> },
    { title: "Refer a Friend", pts: "200 pts", icon: <UsersThree weight="fill" size={24} /> },
    { title: "Weekly Missions", pts: "Up to 100 pts", icon: <CalendarCheck weight="fill" size={24} /> },
  ];

  return (
    <div className="animate-in fade-in duration-500 max-w-4xl mx-auto space-y-10">

      {/* Hero Balance & Tier */}
      <div className="bg-gradient-to-br from-[#d4af37] via-[#c25e30] to-[#8a3818] rounded-3xl p-8 sm:p-12 text-center text-white shadow-xl relative overflow-hidden">
        {/* Abstract shapes */}
        <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 20% 150%, white 20%, transparent 60%)' }} />

        <div className="relative z-10">
          <div className="text-white/80 font-bold uppercase tracking-widest text-sm mb-2">Available Balance</div>
          <div data-testid="rewards-points" className="text-6xl sm:text-7xl font-black mb-4 tracking-tight">{points.toLocaleString()} <span className="text-2xl font-bold opacity-80">pts</span></div>
          <TierBadge tier={m.tier} className="text-sm px-4 py-1.5 shadow-lg shadow-black/20" />

          <div className="mt-10 bg-black/20 backdrop-blur-sm rounded-2xl p-6 text-left border border-white/10">
            <div className="flex justify-between text-sm font-bold mb-3">
              <span>Tier Progress</span>
              <span>{points >= maxTierPoints ? 'Max Tier Reached' : `${(maxTierPoints - points).toLocaleString()} pts to next tier`}</span>
            </div>
            <div className="h-3 bg-black/30 rounded-full overflow-hidden relative">
              <div className="absolute top-0 left-0 h-full bg-white rounded-full transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="flex justify-between mt-3 text-xs font-bold text-white/60">
              <span>Bronze (0)</span>
              <span>Silver (500)</span>
              <span className={points >= 1000 ? 'text-white' : ''}>Gold (1000+)</span>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-center gap-2 text-sm font-medium text-white/70">
            <ShoppingBag size={16} /> Earn as you shop — 1 point for every 50 KES spent.
          </div>
        </div>
      </div>

      {/* Active Missions */}
      <div>
        <h2 className="text-xl font-bold text-[#2c2a29] mb-4">Active Weekly Missions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl p-5 border border-[#e8dfd5] shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-[#2c2a29]">Leave a review</h3>
                <p className="text-sm text-[#7a746e] mt-0.5">Share your thoughts on recent purchases.</p>
              </div>
              <span className="bg-[#f5ece4] text-[#c25e30] text-xs font-bold px-2 py-1 rounded">20pts</span>
            </div>
            <div className="flex justify-between text-xs font-bold mb-2 text-[#7a746e]">
              <span>Progress</span>
              <span>0/1 done</span>
            </div>
            <div className="h-2 bg-[#f0e9e1] rounded-full overflow-hidden">
              <div className="h-full bg-[#c25e30] w-0" />
            </div>
          </div>

          <div className="bg-white rounded-2xl p-5 border border-[#e8dfd5] shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-[#2c2a29]">Post a look</h3>
                <p className="text-sm text-[#7a746e] mt-0.5">Show us how you style it.</p>
              </div>
              <span className="bg-[#f5ece4] text-[#c25e30] text-xs font-bold px-2 py-1 rounded">50pts</span>
            </div>
            <div className="flex justify-between text-xs font-bold mb-2 text-[#7a746e]">
              <span>Progress</span>
              <span>0/3 done</span>
            </div>
            <div className="h-2 bg-[#f0e9e1] rounded-full overflow-hidden">
              <div className="h-full bg-[#c25e30] w-0" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        {/* History */}
        <div>
          <h2 className="text-xl font-bold text-[#2c2a29] mb-4">Points History</h2>
          <div className="bg-white rounded-2xl border border-[#e8dfd5] overflow-hidden shadow-sm">
            {transactions.map((t, i) => (
              <div key={t.id} className={`p-4 flex items-center justify-between ${i !== 0 ? 'border-t border-[#f0e9e1]' : ''}`}>
                <div>
                  <div className="font-bold text-[#2c2a29] text-sm">{t.action}</div>
                  <div className="text-xs text-[#7a746e] mt-1">{t.date}</div>
                </div>
                <div className="text-right">
                  <div className={`font-bold ${t.pts.startsWith('+') ? 'text-[#047857]' : 'text-[#b91c1c]'}`}>{t.pts}</div>
                  <div className={`text-[10px] font-bold uppercase mt-1 ${t.status.includes('Pending') ? 'text-[#c25e30]' : 'text-[#047857]'}`}>
                    {t.status}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* How to Earn */}
        <div>
          <h2 className="text-xl font-bold text-[#2c2a29] mb-4">How to Earn</h2>
          <div className="grid grid-cols-2 gap-3">
            {earnWays.map(w => (
              <div key={w.title} className="bg-[#fcfaf8] rounded-xl p-4 border border-[#f0e9e1] text-center flex flex-col items-center justify-center">
                <div className="text-[#c25e30] mb-2">{w.icon}</div>
                <div className="font-bold text-[#2c2a29] text-sm mb-1">{w.title}</div>
                <div className="text-xs font-medium text-[#7a746e]">{w.pts}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Redemption Options */}
      <div>
        <h2 className="text-xl font-bold text-[#2c2a29] mb-4">Redeem Rewards</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            { title: "10% off next order", pts: 500, icon: <Ticket weight="duotone" /> },
            { title: "Early access to new drop", pts: 800, icon: <Sparkle weight="duotone" /> },
            { title: "Free styling session", pts: 1200, icon: <MagicWand weight="duotone" /> }
          ].map(r => (
            <div key={r.title} className="bg-white rounded-2xl p-6 border border-[#e8dfd5] shadow-sm flex flex-col items-center text-center group hover:border-[#c25e30] transition-colors cursor-pointer">
              <div className="text-4xl mb-4 text-[#a8a199] group-hover:text-[#c25e30] transition-all">{r.icon}</div>
              <h3 className="font-bold text-[#2c2a29] mb-2">{r.title}</h3>
              <div className="text-[#c25e30] font-extrabold mb-4">{r.pts} pts</div>
              <button className="mt-auto w-full py-2 bg-[#f5ece4] text-[#c25e30] font-bold rounded-xl text-sm group-hover:bg-[#c25e30] group-hover:text-white transition-colors">
                Redeem
              </button>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
