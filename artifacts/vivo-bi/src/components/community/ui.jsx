import React, { useState } from 'react';

export function TierBadge({ tier, className = "" }) {
  const gradients = {
    Bronze: "from-[#cd7f32] to-[#a0522d] text-white",
    Silver: "from-[#c0c0c0] to-[#808080] text-white",
    Gold: "from-[#d4af37] to-[#b8860b] text-white",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gradient-to-br ${gradients[tier] || gradients.Bronze} shadow-sm ${className}`}>
      {tier}
    </span>
  );
}

export function PointsAction({ onClick, children, points = 10, className = "" }) {
  const [floats, setFloats] = useState([]);
  
  const handleClick = (e) => {
    const id = Date.now();
    setFloats(prev => [...prev, id]);
    setTimeout(() => {
      setFloats(prev => prev.filter(f => f !== id));
    }, 1000);
    if(onClick) onClick(e);
  };
  
  return (
    <div className={`relative inline-block ${className}`}>
      <div onClick={handleClick} className="cursor-pointer">{children}</div>
      {floats.map(id => (
        <div key={id} className="absolute -top-6 left-1/2 -translate-x-1/2 text-[#c25e30] font-bold text-sm pointer-events-none animate-float-up whitespace-nowrap z-50 drop-shadow-md">
          +{points}pts ✨
        </div>
      ))}
    </div>
  );
}

export function Avatar({ initials, tier, size = "md" }) {
  const sizes = {
    sm: "w-8 h-8 text-xs",
    md: "w-12 h-12 text-sm",
    lg: "w-20 h-20 text-xl",
  };
  const borders = {
    Bronze: "border-[#cd7f32]",
    Silver: "border-[#c0c0c0]",
    Gold: "border-[#d4af37]",
  };
  return (
    <div className={`${sizes[size]} rounded-full flex items-center justify-center bg-[#e8dfd5] text-[#2c2a29] font-bold border-2 ${borders[tier] || "border-transparent"}`}>
      {initials}
    </div>
  );
}

export function ImagePlaceholder({ aspectRatio = "aspect-[4/5]", className = "" }) {
  return (
    <div className={`w-full bg-[#ebdcd0] rounded-xl flex items-center justify-center text-[#c9b4a1] ${aspectRatio} ${className}`}>
      <span className="text-4xl">📸</span>
    </div>
  );
}
