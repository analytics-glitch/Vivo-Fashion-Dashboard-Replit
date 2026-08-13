import React, { useState } from 'react';
import { posts, challenges, leaderboard, styleBoards } from "./mockData";
import { TierBadge, Avatar, PointsAction, ImagePlaceholder } from "./ui";
import { Trophy, Users, Heart, ChatCircle } from "@phosphor-icons/react";

function GridPost({ post, slotId }) {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow group cursor-pointer relative">
      <ImagePlaceholder aspectRatio="aspect-square" className="rounded-none" slotId={slotId} />
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4 text-white">
        <div className="flex items-center gap-1 font-bold"><Heart weight="fill" /> {post.likes}</div>
        <div className="flex items-center gap-1 font-bold"><ChatCircle weight="fill" /> {post.comments}</div>
      </div>
    </div>
  );
}

export default function TabCommunity() {
  const [subTab, setSubTab] = useState("feed");
  const [followed, setFollowed] = useState({});
  
  const SUB_TABS = [
    { id: "feed", label: "Feed" },
    { id: "challenges", label: "Challenges" },
    { id: "leaderboard", label: "Leaderboard" },
    { id: "style_boards", label: "Style Boards" },
  ];

  return (
    <div className="animate-in fade-in duration-500">
      {/* Sub Tabs */}
      <div className="flex gap-4 sm:gap-8 border-b border-[#e8dfd5] mb-8 overflow-x-auto hide-scrollbar">
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`py-3 text-sm font-bold whitespace-nowrap transition-colors border-b-2 ${
              subTab === t.id ? "border-[#2c2a29] text-[#2c2a29]" : "border-transparent text-[#a8a199] hover:text-[#4a4643]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      
      {/* Feed SubTab */}
      {subTab === "feed" && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {posts.map(p => <GridPost key={p.id} post={p} slotId={`community-feed-${p.id}`} />)}
          {posts.map(p => <GridPost key={p.id + 'dup'} post={{...p, likes: p.likes + 10}} slotId={`community-feed-${p.id}-alt`} />)}
        </div>
      )}
      
      {/* Challenges SubTab */}
      {subTab === "challenges" && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {challenges.map(c => (
              <div key={c.id} className="bg-white p-6 rounded-2xl shadow-[0_2px_10px_rgba(44,42,41,0.04)] border border-[#f0e9e1] flex flex-col">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="text-xl font-bold text-[#2c2a29]">{c.title}</h3>
                  <span className="bg-[#f5ece4] text-[#c25e30] text-xs font-bold px-2 py-1 rounded">+{c.points}pts</span>
                </div>
                <p className="text-[#4a4643] text-sm mb-6 flex-grow">{c.description}</p>
                <div className="flex items-center justify-between mt-auto pt-4 border-t border-[#f0e9e1]">
                  <div className="flex items-center gap-3 text-xs font-medium text-[#7a746e]">
                    <span>⏳ {c.deadline}</span>
                    <span>•</span>
                    <span className="flex items-center gap-1"><Users size={14}/> {c.entries} entries</span>
                  </div>
                  <PointsAction points={c.points}>
                    <button data-testid={`enter-${c.id}`} className="bg-[#c25e30] text-white text-sm font-bold px-4 py-2 rounded-lg hover:bg-[#a64e26] transition-colors">
                      Enter Challenge
                    </button>
                  </PointsAction>
                </div>
              </div>
            ))}
          </div>
          
          <div>
            <h3 className="text-lg font-bold text-[#2c2a29] mb-4">Past Winners</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-[#f5ece4] rounded-xl p-4 flex items-center gap-4">
                  <Avatar initials={["AO", "WM", "MW"][i-1]} tier={["Silver", "Gold", "Gold"][i-1]} />
                  <div>
                    <div className="font-bold text-sm text-[#2c2a29]">Winner of "Style It 3 Ways"</div>
                    <div className="text-xs text-[#7a746e]">Won 150pts ✨</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Leaderboard SubTab */}
      {subTab === "leaderboard" && (
        <div className="max-w-3xl mx-auto">
          <div className="bg-white rounded-2xl shadow-sm border border-[#f0e9e1] overflow-hidden">
            <div className="p-6 bg-gradient-to-r from-[#ebdcd0] to-[#f5ece4] border-b border-[#e8dfd5]">
              <h2 className="text-xl font-bold text-[#2c2a29] flex items-center gap-2">
                <Trophy weight="fill" className="text-[#c25e30]" /> Weekly Top Contributors
              </h2>
              <p className="text-[#7a746e] text-sm mt-1">Earn points by posting, commenting, and joining challenges.</p>
            </div>
            <div className="divide-y divide-[#f0e9e1]">
              {leaderboard.map((user, idx) => (
                <div key={user.name} className={`flex items-center justify-between p-4 sm:p-6 transition-colors hover:bg-[#faf8f5] ${idx < 3 ? 'bg-[#fcfaf8]' : ''}`}>
                  <div className="flex items-center gap-4 sm:gap-6">
                    <div className={`text-lg font-bold w-6 text-center ${idx === 0 ? 'text-[#d4af37]' : idx === 1 ? 'text-[#c0c0c0]' : idx === 2 ? 'text-[#cd7f32]' : 'text-[#a8a199]'}`}>
                      #{user.rank}
                    </div>
                    <Avatar initials={user.initials} tier={user.tier} size="md" />
                    <div>
                      <div className="font-bold text-[#2c2a29] text-sm sm:text-base">{user.name}</div>
                      <TierBadge tier={user.tier} className="mt-1" />
                    </div>
                  </div>
                  <div className="text-[#c25e30] font-bold">
                    {user.points} <span className="text-xs font-normal text-[#a8a199]">pts</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Style Boards SubTab */}
      {subTab === "style_boards" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {styleBoards.map((board) => (
            <div key={board.id} className="bg-white rounded-2xl shadow-sm overflow-hidden border border-[#f0e9e1] group">
              <div className="grid grid-cols-2 grid-rows-2 h-48 gap-0.5 bg-[#e8dfd5] p-0.5">
                <ImagePlaceholder className="rounded-none h-full w-full" aspectRatio="aspect-auto" slotId={`community-board-${board.id}-tile-1`} />
                <ImagePlaceholder className="rounded-none h-full w-full" aspectRatio="aspect-auto" slotId={`community-board-${board.id}-tile-2`} />
                <ImagePlaceholder className="rounded-none h-full w-full col-span-2" aspectRatio="aspect-auto" slotId={`community-board-${board.id}-tile-3`} />
              </div>
              <div className="p-5 flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-[#2c2a29] mb-1">{board.title}</h3>
                  <div className="text-xs text-[#7a746e]">{board.items} items • {board.followers} followers</div>
                </div>
                <button
                  data-testid="follow-btn"
                  onClick={() => setFollowed(f => ({ ...f, [board.id]: !f[board.id] }))}
                  className={`text-xs font-bold px-3 py-1.5 rounded-full transition-colors ${
                    followed[board.id]
                      ? "bg-[#c25e30] text-white"
                      : "text-[#c25e30] bg-[#f5ece4] hover:bg-[#c25e30] hover:text-white"
                  }`}
                >
                  {followed[board.id] ? "Following" : "+ Follow"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
