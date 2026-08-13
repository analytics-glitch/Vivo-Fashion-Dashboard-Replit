import React, { useState } from 'react';
import { TierBadge, Avatar, PointsAction } from "./ui";
import { MapPin, Package, ArrowRight, SignOut, Camera, Ruler } from "@phosphor-icons/react";

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

export default function TabProfile({ member, onSignOut }) {
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [styleDNA] = useState(["Bold Prints", "Flowy Fits", "Earth Tones"]);

  const m = member || {};
  const stats = m.stats || {};
  const orders = m.recent_orders || [];

  return (
    <div className="animate-in fade-in duration-500 max-w-5xl mx-auto">
      {/* Profile Header Card */}
      <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-sm border border-[#f0e9e1] mb-8 relative overflow-hidden">
        {/* Background decorative blob */}
        <div className="absolute -top-20 -right-20 w-64 h-64 bg-[#f5ece4] rounded-full blur-3xl opacity-60" />

        <div className="relative flex flex-col md:flex-row items-center md:items-start gap-8">
          <Avatar initials={m.initials || "V"} tier={m.tier} size="lg" />

          <div className="flex-grow text-center md:text-left">
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-2">
              <h1 data-testid="profile-name" className="text-3xl font-black text-[#2c2a29]">{m.name || "Vivo Member"}</h1>
              <TierBadge tier={m.tier} className="self-center" />
            </div>
            <div className="text-[#7a746e] text-sm flex flex-wrap items-center justify-center md:justify-start gap-x-2 gap-y-1 mb-2">
              <span className="flex items-center gap-1.5"><MapPin size={16} /> {stats.city || "Kenya"}</span>
              <span>• Member since {m.joined || "today"}</span>
            </div>
            {stats.preferred_size && (
              <div className="inline-flex items-center gap-1.5 bg-[#f5ece4] text-[#c25e30] text-xs font-bold px-3 py-1 rounded-full mb-4">
                <Ruler size={14} weight="bold" /> Preferred size: {stats.preferred_size}
              </div>
            )}

            {/* Style DNA or Quiz CTA */}
            {!quizCompleted ? (
              <div className="bg-gradient-to-r from-[#ebdcd0] to-[#f5ece4] p-4 rounded-xl border border-[#d2ba9f] inline-block text-left w-full md:w-auto mt-2">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div>
                    <div className="font-bold text-[#2c2a29]">Complete your Style Quiz</div>
                    <div className="text-xs text-[#7a746e]">Personalize your feed and earn points.</div>
                  </div>
                  <PointsAction points={50} onClick={() => setQuizCompleted(true)}>
                    <button data-testid="take-quiz-btn" className="bg-[#c25e30] text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-[#a64e26] transition-colors flex items-center gap-2 whitespace-nowrap">
                      Take Quiz <ArrowRight size={14} weight="bold" />
                    </button>
                  </PointsAction>
                </div>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row items-center md:items-start gap-2 mt-2">
                <span className="text-xs font-bold uppercase text-[#a8a199] md:mt-1">Style DNA</span>
                <div className="flex flex-wrap justify-center md:justify-start gap-2">
                  {styleDNA.map(dna => (
                    <span key={dna} className="bg-[#2c2a29] text-[#fbf9f6] text-xs px-3 py-1 rounded-full font-medium">
                      {dna}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-4 mt-8 pt-8 border-t border-[#f0e9e1] text-center">
          <div>
            <div className="text-xl sm:text-2xl font-black text-[#2c2a29]">0</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Posts</div>
          </div>
          <div>
            <div data-testid="profile-points" className="text-xl sm:text-2xl font-black text-[#c25e30]">{(m.lifetime_points ?? 0).toLocaleString()}</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Lifetime Pts</div>
          </div>
          <div>
            <div data-testid="profile-orders" className="text-xl sm:text-2xl font-black text-[#2c2a29]">{stats.orders ?? 0}</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Orders</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-black text-[#2c2a29]">0</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Following</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* My Posts Grid */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-bold text-[#2c2a29] mb-4">My Style Journal</h2>
          <div className="bg-white rounded-2xl border border-dashed border-[#d2ba9f] p-10 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-[#f5ece4] text-[#c25e30] flex items-center justify-center mb-4">
              <Camera size={26} weight="bold" />
            </div>
            <h3 className="font-bold text-[#2c2a29] mb-1">Your journal is waiting</h3>
            <p className="text-sm text-[#7a746e] mb-5 max-w-sm mx-auto">
              Share your first look with the community and start building your style story.
            </p>
            <PointsAction points={30}>
              <button className="bg-[#c25e30] text-white text-sm font-bold px-5 py-2.5 rounded-xl hover:bg-[#a64e26] transition-colors">
                Share your first look
              </button>
            </PointsAction>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          <div>
            <h2 className="text-xl font-bold text-[#2c2a29] mb-4 flex items-center gap-2">
              <Package size={24} weight="bold" /> Recent Orders
            </h2>
            <div className="bg-white rounded-2xl border border-[#e8dfd5] shadow-sm overflow-hidden divide-y divide-[#f0e9e1]">
              {orders.map(o => (
                <div key={o.order} className="p-4 hover:bg-[#faf8f5] transition-colors cursor-pointer group">
                  <div className="flex justify-between items-start mb-2">
                    <div className="font-bold text-[#2c2a29] text-sm group-hover:text-[#c25e30] transition-colors">{o.order}</div>
                    <div className="text-[#c25e30] font-bold text-sm">+{o.pts} pts</div>
                  </div>
                  <div className="flex justify-between items-end text-xs">
                    <div className="text-[#7a746e]">{fmtDate(o.date)}</div>
                    <div className="font-bold text-[#2c2a29]">KES {Math.round(o.total_kes).toLocaleString()}</div>
                  </div>
                </div>
              ))}
              {orders.length === 0 && (
                <div className="p-6 text-center text-sm text-[#7a746e]">
                  No purchases yet — shop with your phone number in store and they'll appear here.
                </div>
              )}
            </div>
          </div>

          <button
            data-testid="btn-signout"
            onClick={onSignOut}
            className="w-full py-4 text-center text-[#7a746e] text-sm font-bold hover:text-[#b3261e] transition-colors border border-transparent hover:border-[#f5c6c0] rounded-xl flex items-center justify-center gap-2"
          >
            <SignOut size={18} weight="bold" /> Sign out
          </button>
        </div>
      </div>

    </div>
  );
}
