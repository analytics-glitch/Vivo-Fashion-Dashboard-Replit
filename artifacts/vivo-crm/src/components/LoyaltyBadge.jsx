import React from "react";

const TIERS = {
  dormant: { label: "Dormant", bg: "#E5E7EB", border: "#6B7280", text: "#374151", emoji: "" },
  bronze: { label: "Bronze", bg: "#F1E0CE", border: "#B07A47", text: "#6B3B17", emoji: "" },
  silver: { label: "Silver", bg: "#E8EAED", border: "#9CA3AF", text: "#3F4855", emoji: "" },
  gold:   { label: "Gold",   bg: "#FAEBC3", border: "#D4A93B", text: "#7A5A12", emoji: "" },
  vip:    { label: "VIP",    bg: "#D7E6DC", border: "#1a5c38", text: "#0F3D24", emoji: "" },
};

export function LoyaltyBadge({ tier, size = "md", className = "", testid }) {
  if (!tier || !TIERS[tier]) return null;
  const t = TIERS[tier];
  const dims = size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-[11px] px-2 py-1";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border font-semibold uppercase tracking-wider ${dims} ${className}`}
      style={{ backgroundColor: t.bg, borderColor: t.border, color: t.text }}
      data-testid={testid || `loyalty-badge-${tier}`}
      title={`${t.label} tier`}
    >
      {t.label}
    </span>
  );
}

export default LoyaltyBadge;
