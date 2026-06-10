import React from "react";

/**
 * Business-action variance classifier for product-level stock-to-sales
 * comparisons. Invoked by Inventory, Products, Re-Order, IBT, CEO Report —
 * anywhere "sales share vs stock share" is shown.
 *
 * Mapping (inverted from raw math to call-to-action). Bands match the
 * Stock-to-Sales variance spec in the BI docs (06/03):
 *   |v| ≤ 1 pp                         → GREEN  (healthy balance)
 *   1 < |v| ≤ 3, v > 0                 → AMBER  (watch — stockout watch)
 *   1 < |v| ≤ 3, v < 0                 → AMBER  (watch — overstock watch)
 *   |v| > 3,     v > 0                 → RED    (stockout risk — re-order)
 *   |v| > 3,     v < 0                 → RED    (overstock risk — markdown / IBT)
 *
 * Thresholds are symmetric (pp); tune VAR_GREEN / VAR_AMBER if the
 * merchandising team re-calibrates. Icons are rendered alongside color so
 * colorblind readers get the same signal.
 */
export const VAR_GREEN = 1;
export const VAR_AMBER = 3;

export const varianceStyle = (v) => {
  if (v == null || isNaN(v))
    return { cls: "pill-neutral", icon: "", flag: "Unknown", tip: "No variance data" };
  const abs = Math.abs(v);
  if (abs <= VAR_GREEN)
    return { cls: "pill-green", icon: "✅", flag: "Healthy", tip: "Stock and sales in balance." };
  if (abs <= VAR_AMBER) {
    if (v > 0)
      return { cls: "pill-amber", icon: "⚠️", flag: "Monitor (Stockout watch)", tip: "Sales slightly ahead of stock — monitor, plan re-order." };
    return { cls: "pill-amber", icon: "⚠️", flag: "Monitor (Overstock watch)", tip: "Stock slightly ahead of sales — monitor, plan promotions." };
  }
  if (v > 0)
    return { cls: "pill-red", icon: "🔴", flag: "Stockout Risk", tip: "Sales outpacing stock — stockout risk. Review re-order urgently." };
  return { cls: "pill-red", icon: "🔴", flag: "Overstock Risk", tip: "Stock outpacing sales — overstock risk. Review markdowns or IBT." };
};

export const VarianceCell = ({ value, suffix = "%" }) => {
  const { cls, icon, tip, flag } = varianceStyle(value);
  return (
    <span
      className={`${cls} inline-flex items-center gap-1`}
      title={tip}
      data-variance-flag={flag}
    >
      <span aria-hidden="true">{icon}</span>
      {value >= 0 ? "+" : ""}
      {(value || 0).toFixed(2)}
      {suffix}
    </span>
  );
};

export const varianceFlag = (v) => varianceStyle(v).flag;
