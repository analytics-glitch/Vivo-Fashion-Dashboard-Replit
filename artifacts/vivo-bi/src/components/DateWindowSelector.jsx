import React from "react";

/**
 * DateWindowSelector — Iter 89w-h
 *
 * Compact preset selector for "look back N days" windows. Used by the
 * stock-to-sales / SOR tables across Inventory, Products, Marketing
 * and Range Mgmt so each table can be re-windowed independently of
 * the global filter bar.
 *
 * value: integer days (e.g. 30)
 * onChange(days: number): void
 *
 * The presets are intentionally conservative: 7/14/30/60/90 days
 * map cleanly to "week / fortnight / month / 2 months / quarter" —
 * which is how the merch team thinks about velocity.
 */
const PRESETS = [
  { v: 7,  l: "7d"  },
  { v: 14, l: "14d" },
  { v: 30, l: "30d" },
  { v: 60, l: "60d" },
  { v: 90, l: "90d" },
];

export default function DateWindowSelector({
  value = 30,
  onChange,
  presets = PRESETS,
  testId = "date-window",
  label = "Window",
  // Opt-in custom From/To range. When `allowCustom` is true a "Custom"
  // button is shown; selecting it sets `value` to the sentinel "custom"
  // and reveals two separate date inputs. The custom range is controlled
  // by the parent via `customFrom`/`customTo` + `onCustomChange(from, to)`.
  // Other consumers (Inventory, Marketing, Range Mgmt) leave this off so
  // they are unaffected.
  allowCustom = false,
  customFrom = "",
  customTo = "",
  onCustomChange,
}) {
  const isCustom = value === "custom";
  const invalid = isCustom && customFrom && customTo && customFrom > customTo;
  return (
    <div
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-2 py-1 flex-wrap"
      data-testid={`${testId}-wrap`}
      title="Re-windows this table — global filter bar dates are not affected."
    >
      {label ? (
        <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted">{label}</span>
      ) : null}
      <div className="inline-flex rounded-md overflow-hidden border border-border">
        {presets.map((p) => (
          <button
            key={p.v}
            type="button"
            onClick={() => onChange?.(p.v)}
            data-testid={`${testId}-${p.v}`}
            className={`text-[10.5px] font-bold px-2 py-0.5 transition-colors ${
              value === p.v
                ? "bg-[#1a5c38] text-white"
                : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"
            }`}
          >
            {p.l}
          </button>
        ))}
        {allowCustom ? (
          <button
            type="button"
            onClick={() => onChange?.("custom")}
            data-testid={`${testId}-custom`}
            className={`text-[10.5px] font-bold px-2 py-0.5 transition-colors border-l border-border ${
              isCustom
                ? "bg-[#1a5c38] text-white"
                : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"
            }`}
          >
            Custom
          </button>
        ) : null}
      </div>
      {allowCustom && isCustom ? (
        <div className="inline-flex items-center gap-1" data-testid={`${testId}-custom-range`}>
          <input
            type="date"
            value={customFrom || ""}
            max={customTo || undefined}
            onChange={(e) => onCustomChange?.(e.target.value, customTo)}
            data-testid={`${testId}-custom-from`}
            className={`text-[11px] rounded border px-1.5 py-0.5 ${invalid ? "border-red-400" : "border-border"}`}
          />
          <span className="text-[11px] text-muted">→</span>
          <input
            type="date"
            value={customTo || ""}
            min={customFrom || undefined}
            onChange={(e) => onCustomChange?.(customFrom, e.target.value)}
            data-testid={`${testId}-custom-to`}
            className={`text-[11px] rounded border px-1.5 py-0.5 ${invalid ? "border-red-400" : "border-border"}`}
          />
          {invalid ? (
            <span className="text-[10.5px] font-semibold text-red-500" data-testid={`${testId}-custom-error`}>
              From must be on or before To
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
