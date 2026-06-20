import React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

/**
 * DeltaChip — small pill showing absolute or percentage change.
 * Pass: current, previous, invert (true if lower is better, e.g. hours_lost),
 *       format ("pct" | "num"), suffix.
 */
export default function DeltaChip({ current = 0, previous = 0, invert = false, format = "pct", suffix = "", className = "" }) {
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  let pct = 0;
  if (prev === 0 && curr === 0) pct = 0;
  else if (prev === 0) pct = 100;
  else pct = ((curr - prev) / Math.abs(prev)) * 100;

  const isPositive = curr > prev;
  const isFlat = curr === prev;
  // "good" depends on invert flag
  const good = isFlat ? null : invert ? !isPositive : isPositive;

  const color = isFlat
    ? "bg-muted text-muted-foreground"
    : good
      ? "bg-success/15 text-success"
      : "bg-danger/15 text-danger";
  const Icon = isFlat ? Minus : isPositive ? TrendingUp : TrendingDown;

  const display = format === "pct"
    ? `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`
    : `${curr - prev > 0 ? "+" : ""}${(curr - prev).toFixed(format === "num1" ? 1 : 0)}${suffix}`;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${color} ${className}`}
      title={`Previous: ${prev.toLocaleString()}${suffix}`}
    >
      <Icon className="h-2.5 w-2.5" />
      {display}
    </span>
  );
}
