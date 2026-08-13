import React, { useState } from 'react';
import { Heart, ChatCircle, ShareNetwork, ArrowRight } from "@phosphor-icons/react";
import { posts as initialPosts, challenges } from "./mockData";
import { TierBadge, Avatar, ImagePlaceholder, PointsAction } from "./ui";

function PostCard({ post }) {
  const [liked, setLiked] = useState(post.isLiked);
  const [likesCount, setLikesCount] = useState(post.likes);

  const toggleLike = () => {
    if (liked) {
      setLiked(false);
      setLikesCount(c => c - 1);
    } else {
      setLiked(true);
      setLikesCount(c => c + 1);
    }
  };

  return (
    <div className="bg-white rounded-2xl p-5 shadow-[0_2px_10px_rgba(44,42,41,0.04)] mb-8 transition-transform hover:-translate-y-1 duration-300">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Avatar initials={post.author.initials} tier={post.author.tier} />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-[#2c2a29]">{post.author.name}</span>
              <TierBadge tier={post.author.tier} />
            </div>
            <span className="text-xs text-[#7a746e]">{post.time}</span>
          </div>
        </div>
      </div>
      
      <ImagePlaceholder />
      
      <div className="mt-4">
        <p className="text-[#4a4643] text-[15px] leading-relaxed mb-3">
          {post.caption}
        </p>
        
        {post.taggedProducts?.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {post.taggedProducts.map(prod => (
              <button key={prod.id} className="bg-[#f5ece4] text-[#c25e30] text-xs font-semibold px-3 py-1.5 rounded-full hover:bg-[#eaddd1] transition-colors">
                {prod.name}
              </button>
            ))}
          </div>
        )}
        
        <div className="flex items-center gap-6 border-t border-[#f0e9e1] pt-4 mt-2">
          <PointsAction onClick={toggleLike} points={5}>
            <button data-testid="like-btn" className={`flex items-center gap-1.5 font-medium transition-colors ${liked ? "text-[#c25e30]" : "text-[#7a746e] hover:text-[#c25e30]"}`}>
              {liked ? <span>💛</span> : <Heart size={20} weight="bold" />}
              <span>{likesCount}</span>
            </button>
          </PointsAction>
          <button className="flex items-center gap-1.5 font-medium text-[#7a746e] hover:text-[#c25e30] transition-colors">
            <ChatCircle size={20} weight="bold" />
            <span>{post.comments}</span>
          </button>
          <button className="flex items-center gap-1.5 font-medium text-[#7a746e] hover:text-[#c25e30] transition-colors ml-auto">
            <ShareNetwork size={20} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TabHome({ onNavigate }) {
  const featuredChallenge = challenges.find(c => c.isFlagship);
  
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      {/* Main Feed */}
      <div className="lg:col-span-8">
        <h2 className="text-2xl font-bold mb-6 text-[#2c2a29]">For You</h2>
        {initialPosts.map(post => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>
      
      {/* Sidebar */}
      <div className="lg:col-span-4 space-y-6">
        {/* Featured Challenge */}
        {featuredChallenge && (
          <div className="bg-gradient-to-br from-[#ebdcd0] to-[#e1ccb9] rounded-2xl p-6 shadow-sm border border-[#d2ba9f]">
            <div className="inline-block px-2.5 py-1 bg-[#c25e30] text-white text-xs font-bold uppercase tracking-wider rounded mb-4">
              Featured Challenge
            </div>
            <h3 className="text-xl font-extrabold text-[#2c2a29] mb-2">{featuredChallenge.title}</h3>
            <p className="text-[#4a4643] text-sm mb-4 leading-relaxed">{featuredChallenge.description}</p>
            <div className="flex items-center justify-between mb-5">
              <span className="text-sm font-semibold text-[#c25e30]">⏳ {featuredChallenge.deadline}</span>
            </div>
            <PointsAction points={featuredChallenge.points} className="w-full">
              <button 
                data-testid="enter-challenge-btn"
                onClick={() => setTimeout(() => onNavigate("community"), 650)}
                className="w-full bg-[#2c2a29] text-white py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#1a1918] transition-colors"
              >
                Enter Now <ArrowRight size={16} weight="bold" />
              </button>
            </PointsAction>
          </div>
        )}
        
        {/* Spotlight */}
        <div className="bg-white rounded-2xl p-6 shadow-[0_2px_10px_rgba(44,42,41,0.04)]">
          <h3 className="text-sm font-bold uppercase tracking-widest text-[#a8a199] mb-4">Spotlight: Top Contributor</h3>
          <div className="flex items-center gap-4 mb-4">
            <Avatar initials="NK" tier="Gold" size="md" />
            <div>
              <div className="font-bold text-[#2c2a29] text-lg">Nyambura K.</div>
              <TierBadge tier="Gold" />
            </div>
          </div>
          <blockquote className="italic text-[#7a746e] text-sm border-l-2 border-[#c25e30] pl-3">
            "Finding a community that celebrates African curves has completely changed how I shop. Vivo is more than fashion, it's family."
          </blockquote>
        </div>
      </div>
    </div>
  );
}
