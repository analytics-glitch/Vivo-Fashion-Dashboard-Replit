import React from "react";

/**
 * KPI tile — eyebrow, big tabular number, meta row.
 * Variants: "brand" gets a brand-deep border + green tint (top entity).
 *           "default" gets thin border, orange progress accent.
 */
export const KpiCard = ({ title, value, sub, icon: Icon, accent = "default", testId, progress, onClick }) => {
  const isBrand = accent === "brand";
  const clickable = typeof onClick === "function";
  const Cmp = clickable ? "button" : "div";
  return (
    <Cmp
      onClick={onClick}
      data-testid={testId}
      type={clickable ? "button" : undefined}
      className={`relative overflow-hidden rounded-2xl border bg-card p-4 shadow-none transition-colors text-left w-full ${
        isBrand ? "border-brand" : "border-border"
      } ${clickable ? "hover:border-accent-mid/60 cursor-pointer" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">{title}</div>
          <div className="mt-2 font-extrabold tracking-tight text-[28px] leading-none tabular-nums text-foreground">{value}</div>
          {sub && <div className="mt-1.5 text-[11px] text-muted-foreground">{sub}</div>}
        </div>
        {Icon && (
          <div className={`grid h-9 w-9 place-items-center rounded-full ${isBrand ? "bg-brand text-background" : "bg-accent-soft text-accent-deep"}`}>
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
      {typeof progress === "number" && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-panel">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.max(0, Math.min(100, progress))}%`, background: isBrand ? "hsl(var(--brand))" : "hsl(var(--accent-mid))" }}
          />
        </div>
      )}
      {clickable && (
        <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          Tap to see who →
        </div>
      )}
    </Cmp>
  );
};
