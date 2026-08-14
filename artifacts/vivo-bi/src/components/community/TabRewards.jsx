import React from 'react';
import { currentUser } from "./mockData";
import { TierBadge } from "./ui";
import { Clock, Star, Gift, ShoppingBag, Receipt, Ticket, Sparkle, MagicWand, VideoCamera, Ruler, UsersThree, CalendarCheck, Scissors, Truck, TShirt } from "@phosphor-icons/react";

export default function TabRewards() {
  const points = currentUser.points;
  // Tier progress runs on lifetime earn — redeeming never walks the tier back.
  const lifetimePoints = currentUser.lifetime_points ?? points;
  const maxTierPoints = 1000;
  const progressPercent = Math.min((lifetimePoints / maxTierPoints) * 100, 100);
  
  const transactions = [
    { id: 1, action: "Purchased Amani Flowy Maxi", date: "Aug 10, 2026", pts: "+110", status: "Posted" },
    { id: 2, action: "Entered #MyVivoStory Challenge", date: "Aug 08, 2026", pts: "+50", status: "Pending — awarded when published" },
    { id: 3, action: "Left a photo review", date: "Aug 02, 2026", pts: "+25", status: "Posted" },
    { id: 4, action: "Redeemed Alteration on One Style", date: "Jul 26, 2026", pts: "-800", status: "Posted" },
  ];

  const earnWays = [
    { title: "Purchases", pts: "1 pt per 100 KES", icon: <ShoppingBag weight="fill" size={24} /> },
    { title: "Text Review", pts: "10 pts when published", icon: <Receipt weight="fill" size={24} /> },
    { title: "Photo Review", pts: "25 pts when published", icon: <Star weight="fill" size={24} /> },
    { title: "Video Review", pts: "40 pts when published", icon: <VideoCamera weight="fill" size={24} /> },
    { title: "Style Post", pts: "30 pts when published", icon: <Gift weight="fill" size={24} /> },
    { title: "Fit Notes", pts: "15 pts when published", icon: <Ruler weight="fill" size={24} /> },
    { title: "Join Challenge", pts: "Up to 150 pts when published", icon: <Ticket weight="fill" size={24} /> },
    { title: "Refer a Friend", pts: "200 pts", icon: <UsersThree weight="fill" size={24} /> },
    { title: "Weekly Missions", pts: "Up to 100 pts", icon: <CalendarCheck weight="fill" size={24} /> },
  ];

  return (
    <div className="animate-in fade-in duration-500 max-w-4xl mx-auto space-y-10">
      
      {/* Balance & tier — compact card */}
      <div className="bg-white rounded-2xl p-5 border border-[#e8dfd5] shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="text-xs font-bold uppercase tracking-[0.25em] text-[#7a746e]">Vivo Johari</div>
          <TierBadge tier={currentUser.tier} />
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div className="text-4xl font-black tracking-tight text-[#2c2a29]">{points.toLocaleString()} <span className="text-lg font-bold opacity-60">pts</span></div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#7a746e]">Available Balance</span>
        </div>
        <div className="mt-4">
          <div className="flex justify-between text-xs font-bold mb-2 text-[#7a746e]">
            <span>Tier Progress</span>
            <span>{lifetimePoints >= maxTierPoints ? 'Max Tier Reached' : `${maxTierPoints - lifetimePoints} pts to next tier`}</span>
          </div>
          <div className="h-1.5 bg-[#f0e9e1] rounded-full overflow-hidden relative">
            <div className="absolute top-0 left-0 h-full bg-[#FE5000] rounded-full transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="flex justify-between mt-2 text-[10px] font-bold text-[#a39d97]">
            <span>Tsavorite (0)</span>
            <span>Ruby (500+)</span>
            <span className={lifetimePoints >= 1000 ? 'text-[#C43E00]' : ''}>Tanzanite (1,000+)</span>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-[#7a746e]">
          <Clock size={13} /> Your points expire in 45 days — earn to reset the clock.
        </div>
      </div>
      
      {/* Our gems — the story behind the tier names */}
      <div className="bg-white rounded-2xl p-5 border border-[#e8dfd5] shadow-sm">
        <h2 className="text-xl font-bold text-[#2c2a29] mb-1">Our Gems</h2>
        <p className="text-sm text-[#7a746e] mb-4">Every tier is a gemstone from East African soil — your journey moves through the treasures of our own region.</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3"><TierBadge tier="Tsavorite" className="mt-0.5 shrink-0" /><p className="text-sm text-[#2c2a29]/80">The vivid green garnet discovered in Kenya's Tsavo — where everyone begins.</p></div>
          <div className="flex items-start gap-3"><TierBadge tier="Ruby" className="mt-0.5 shrink-0" /><p className="text-sm text-[#2c2a29]/80">Warm, deep red from East Africa's ruby heartlands.</p></div>
          <div className="flex items-start gap-3"><TierBadge tier="Tanzanite" className="mt-0.5 shrink-0" /><p className="text-sm text-[#2c2a29]/80">Found only at the foot of Kilimanjaro — rarer than diamond.</p></div>
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
              <span className="bg-[#f5ece4] text-[#C43E00] text-[11px] leading-snug font-bold px-2.5 py-1.5 rounded shrink-0 max-w-[110px] text-center">20 pts when published</span>
            </div>
            <div className="flex justify-between text-xs font-bold mb-2 text-[#7a746e]">
              <span>Progress</span>
              <span>0/1 done</span>
            </div>
            <div className="h-2 bg-[#f0e9e1] rounded-full overflow-hidden">
              <div className="h-full bg-[#FE5000] w-0" />
            </div>
          </div>
          
          <div className="bg-white rounded-2xl p-5 border border-[#e8dfd5] shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-[#2c2a29]">Post a look</h3>
                <p className="text-sm text-[#7a746e] mt-0.5">Show us how you style it.</p>
              </div>
              <span className="bg-[#f5ece4] text-[#C43E00] text-[11px] leading-snug font-bold px-2.5 py-1.5 rounded shrink-0 max-w-[110px] text-center">50 pts when published</span>
            </div>
            <div className="flex justify-between text-xs font-bold mb-2 text-[#7a746e]">
              <span>Progress</span>
              <span>1/3 done</span>
            </div>
            <div className="h-2 bg-[#f0e9e1] rounded-full overflow-hidden">
              <div className="h-full bg-[#FE5000] w-1/3" />
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
                  <div className={`text-[10px] font-bold uppercase mt-1 max-w-[150px] ml-auto ${t.status.includes('Pending') ? 'text-[#C43E00]' : 'text-[#047857]'}`}>
                    {t.status}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p data-testid="pending-note" className="text-xs text-[#7a746e] leading-relaxed mt-3">
            Pending points land the moment your entry is published. If one doesn't go live, we'll let you know — you can tweak and reshare anytime.
          </p>
        </div>
        
        {/* How to Earn */}
        <div>
          <h2 className="text-xl font-bold text-[#2c2a29] mb-4">How to Earn</h2>
          <div className="grid grid-cols-2 gap-3">
            {earnWays.map(w => (
              <div key={w.title} className="bg-[#fcfaf8] rounded-xl p-4 border border-[#f0e9e1] text-center flex flex-col items-center justify-center">
                <div className="text-[#C43E00] mb-2">{w.icon}</div>
                <div className="font-bold text-[#2c2a29] text-sm mb-1">{w.title}</div>
                <div className="text-xs font-medium text-[#7a746e]">{w.pts}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-[#7a746e] leading-relaxed mt-3">
            Reviews, photos, videos, fit notes, style posts and challenge entries are reviewed with love before they go live — each earns its points when it's published.
          </p>
        </div>
      </div>
      
      {/* Redemption Options */}
      <div>
        <h2 className="text-xl font-bold text-[#2c2a29] mb-1">Redeem Rewards</h2>
        <p className="text-sm text-[#7a746e] mb-4">From everyday value to insider access — the ladder climbs as you earn.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            { title: "KES 500 off voucher", pts: 300, icon: <Ticket weight="duotone" />, note: "A fixed KES 500 off your next order." },
            { title: "Free delivery on your next order", pts: 500, icon: <Truck weight="duotone" /> },
            { title: "Alteration on one style", pts: 800, icon: <Scissors weight="duotone" />, note: "Basic alterations only — hems, waists and simple adjustments. At participating stores. T&Cs apply." },
            { title: "Personal styling session", pts: 1200, icon: <MagicWand weight="duotone" /> },
            { title: "Personalised Embroidered Tank", pts: 1600, img: "/api/community/product-image/V0225026BUTM", icon: <TShirt weight="duotone" />, note: "Vivo's ribbed tank finished with your own embroidered design, stitched in-house. Members pick size and colour, then upload a design or choose a monogram." },
            { title: "Members' event invitation", pts: 2000, icon: <Sparkle weight="duotone" />, note: "Styling evenings and first looks at new collections, in store." }
          ].map(r => (
            <div key={r.title} className="bg-white rounded-2xl border border-[#e8dfd5] shadow-sm flex flex-col items-center text-center group hover:border-[#FE5000] transition-colors cursor-pointer overflow-hidden">
              {r.img && (
                <img src={r.img} alt={r.title} className="w-full h-40 object-cover object-top" />
              )}
              <div className="p-6 flex flex-col items-center flex-1 w-full">
                {!r.img && (
                  <div className="text-4xl mb-4 text-[#a8a199] group-hover:text-[#C43E00] transition-all">{r.icon}</div>
                )}
                <h3 className="font-bold text-[#2c2a29] mb-2">{r.title}</h3>
                <div className="text-[#C43E00] font-extrabold mb-4">{r.pts.toLocaleString()} pts</div>
                {r.note && (
                  <p className="text-xs text-[#7a746e] leading-relaxed -mt-2 mb-4">{r.note}</p>
                )}
                <button className="mt-auto w-full py-2 bg-[#f5ece4] text-[#C43E00] font-bold rounded-xl text-sm group-hover:bg-[#FE5000] group-hover:text-white transition-colors">
                  Redeem
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      
    </div>
  );
}