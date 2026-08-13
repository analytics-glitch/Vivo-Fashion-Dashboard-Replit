import React, { useState } from 'react';
import { currentUser } from "./mockData";
import { TierBadge, Avatar, ImagePlaceholder, PointsAction } from "./ui";
import { Gear, MapPin, Package, ArrowRight } from "@phosphor-icons/react";

export default function TabProfile() {
  const [quizCompleted, setQuizCompleted] = useState(false);
  
  const myPosts = Array(6).fill(null);
  
  const orders = [
    { id: "ORD-9482", date: "Aug 10, 2026", items: 2, total: 10700, pts: 214 },
    { id: "ORD-8391", date: "Jul 18, 2026", items: 1, total: 4500, pts: 90 },
    { id: "ORD-7102", date: "Jun 22, 2026", items: 3, total: 15200, pts: 304 },
  ];

  return (
    <div className="animate-in fade-in duration-500 max-w-5xl mx-auto">
      {/* Profile Header Card */}
      <div className="bg-white rounded-3xl p-6 sm:p-10 shadow-sm border border-[#f0e9e1] mb-8 relative overflow-hidden">
        {/* Background decorative blob */}
        <div className="absolute -top-20 -right-20 w-64 h-64 bg-[#f5ece4] rounded-full blur-3xl opacity-60" />
        
        <div className="relative flex flex-col md:flex-row items-center md:items-start gap-8">
          <Avatar initials={currentUser.initials} tier={currentUser.tier} size="lg" />
          
          <div className="flex-grow text-center md:text-left">
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-2">
              <h1 className="text-3xl font-black text-[#2c2a29]">{currentUser.name}</h1>
              <TierBadge tier={currentUser.tier} className="self-center" />
            </div>
            <div className="text-[#7a746e] text-sm flex items-center justify-center md:justify-start gap-2 mb-4">
              <MapPin size={16} /> Nairobi, Kenya • Member since {currentUser.joined}
            </div>
            
            {/* Style DNA or Quiz CTA */}
            {!quizCompleted ? (
              <div className="bg-gradient-to-r from-[#ebdcd0] to-[#f5ece4] p-4 rounded-xl border border-[#d2ba9f] inline-block text-left w-full md:w-auto">
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
              <div className="flex flex-col md:flex-row items-center md:items-start gap-2">
                <span className="text-xs font-bold uppercase text-[#a8a199] md:mt-1">Style DNA</span>
                <div className="flex flex-wrap justify-center md:justify-start gap-2">
                  {currentUser.styleDNA.map(dna => (
                    <span key={dna} className="bg-[#2c2a29] text-[#fbf9f6] text-xs px-3 py-1 rounded-full font-medium">
                      {dna}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          
          <button className="hidden md:flex p-2 text-[#7a746e] hover:text-[#2c2a29] hover:bg-[#f5ece4] rounded-full transition-colors absolute top-4 right-4">
            <Gear size={24} />
          </button>
        </div>
        
        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-4 mt-8 pt-8 border-t border-[#f0e9e1] text-center">
          <div>
            <div className="text-xl sm:text-2xl font-black text-[#2c2a29]">24</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Posts</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-black text-[#c25e30]">2.8k</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Lifetime Pts</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-black text-[#2c2a29]">{currentUser.orders}</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Orders</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-black text-[#2c2a29]">{currentUser.following}</div>
            <div className="text-[10px] sm:text-xs font-bold uppercase text-[#a8a199] mt-1">Following</div>
          </div>
        </div>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* My Posts Grid */}
        <div className="lg:col-span-2">
          <h2 className="text-xl font-bold text-[#2c2a29] mb-4">My Style Journal</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
            {myPosts.map((_, i) => (
              <div key={i} className="rounded-xl overflow-hidden shadow-sm group relative">
                <ImagePlaceholder aspectRatio="aspect-square" className="rounded-none group-hover:scale-105 transition-transform duration-500" />
                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                  <div className="bg-white/90 backdrop-blur rounded-full px-3 py-1 text-xs font-bold text-[#2c2a29]">
                    View
                  </div>
                </div>
              </div>
            ))}
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
                <div key={o.id} className="p-4 hover:bg-[#faf8f5] transition-colors cursor-pointer group">
                  <div className="flex justify-between items-start mb-2">
                    <div className="font-bold text-[#2c2a29] text-sm group-hover:text-[#c25e30] transition-colors">{o.id}</div>
                    <div className="text-[#c25e30] font-bold text-sm">+{o.pts} pts</div>
                  </div>
                  <div className="flex justify-between items-end text-xs">
                    <div className="text-[#7a746e]">{o.date} • {o.items} items</div>
                    <div className="font-bold text-[#2c2a29]">KES {o.total.toLocaleString()}</div>
                  </div>
                </div>
              ))}
              <div className="p-3 text-center bg-[#fcfaf8] hover:bg-[#f5ece4] transition-colors cursor-pointer">
                <button className="text-sm font-bold text-[#c25e30]">View All Orders</button>
              </div>
            </div>
          </div>
          
          <button className="w-full py-4 text-center text-[#7a746e] text-sm font-bold hover:text-[#2c2a29] transition-colors border border-transparent hover:border-[#e8dfd5] rounded-xl flex items-center justify-center gap-2">
            <Gear size={18} /> Settings & Preferences
          </button>
        </div>
      </div>
      
    </div>
  );
}
