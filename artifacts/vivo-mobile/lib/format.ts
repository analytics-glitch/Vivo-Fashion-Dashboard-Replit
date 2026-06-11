/**
 * Formatting helpers, ported from the web cockpit (artifacts/vivo-bi/src/lib/api.js)
 * so money, counts, and percentages render identically across web and mobile.
 * All money is in Kenyan Shillings (KES).
 */

/** Compact 2-decimal currency. e.g. 354_985_308 -> "KES 354.99M". */
export const fmtKES = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(Number(n))) return "KES 0";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return "KES " + (v / 1_000_000_000).toFixed(2) + "B";
  if (abs >= 1_000_000) return "KES " + (v / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return "KES " + (v / 1_000).toFixed(2) + "K";
  return "KES " + Math.round(v).toLocaleString("en-US");
};

/** Full-precision currency for detail rows. */
export const fmtKESLong = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(Number(n))) return "KES 0";
  return "KES " + Math.round(Number(n)).toLocaleString("en-US");
};

/** Compact integer count. e.g. 144_281 -> "144.3K". */
export const fmtCompact = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(Number(n))) return "0";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return String(Math.round(v));
};

/** Grouped integer. e.g. 144281 -> "144,281". */
export const fmtNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(Number(n))) return "0";
  return Math.round(Number(n)).toLocaleString("en-US");
};

export const fmtPct = (n: number | null | undefined, d = 1): string => {
  if (n === null || n === undefined || isNaN(Number(n))) return "0%";
  return `${Number(n).toFixed(d)}%`;
};
