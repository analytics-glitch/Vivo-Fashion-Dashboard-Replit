/**
 * Branded SVG placeholder for product tiles when the BI feed has no
 * image URL (current state of Vivo's catalogue API). Generates a
 * deterministic colour from the product brand/collection so adjacent
 * products on the lookbook stay visually distinct, and overlays the
 * collection + colour + product-type text on top.
 *
 * Why not Unsplash? Generic fashion photos signal "stock" to the
 * customer and risk showing competitor garments. A brand-locked
 * placeholder is honest, recognisable, and prints fine on a 30-day
 * share link.
 */

import React from "react";

const PALETTE = [
  { bg: "#0F4D31", fg: "#FCEFD9" },   // forest / cream
  { bg: "#1A3D2E", fg: "#FCEFD9" },   // deep forest / cream
  { bg: "#704F2C", fg: "#FCEFD9" },   // saddle / cream
  { bg: "#9C3D2D", fg: "#FCEFD9" },   // rust / cream
  { bg: "#222222", fg: "#D4A93B" },   // charcoal / gold
  { bg: "#D4A93B", fg: "#0F4D31" },   // gold / forest
  { bg: "#5F6F52", fg: "#FCEFD9" },   // sage / cream
  { bg: "#FCEFD9", fg: "#0F4D31" },   // cream / forest
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

export default function ProductTilePlaceholder({ item, className = "" }) {
  const seed = item?.sku || item?.product_title || "vivo";
  const palette = PALETTE[hashStr(seed) % PALETTE.length];
  const lines = [
    (item?.collection || item?.style_name || item?.brand || "Vivo").toString(),
    (item?.color || item?.color_print || "").toString(),
    (item?.product_type || item?.subcategory || "").toString(),
  ].filter(Boolean);

  return (
    <svg
      viewBox="0 0 300 400"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={lines.join(" · ") || "Vivo product"}
      className={className}
    >
      <rect width="300" height="400" fill={palette.bg} />
      {/* subtle texture lines */}
      <g stroke={palette.fg} strokeWidth="0.5" opacity="0.18">
        <line x1="0"   y1="80"  x2="300" y2="80"  />
        <line x1="0"   y1="320" x2="300" y2="320" />
      </g>
      {/* monogram */}
      <text
        x="150" y="170"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontStyle="italic"
        fontWeight="700"
        fontSize="78"
        fill={palette.fg}
        opacity="0.95"
      >V</text>
      {/* product line text */}
      <g
        fontFamily="Inter, system-ui, sans-serif"
        textAnchor="middle"
        fill={palette.fg}
      >
        <text x="150" y="230" fontSize="11" letterSpacing="3" opacity="0.65">VIVO</text>
        <text x="150" y="260" fontSize="14" fontWeight="600">{lines[0] || ""}</text>
        {lines[1] && <text x="150" y="282" fontSize="11" opacity="0.78">{lines[1]}</text>}
        {lines[2] && <text x="150" y="302" fontSize="10" opacity="0.6" letterSpacing="2">{lines[2].toUpperCase()}</text>}
      </g>
    </svg>
  );
}
