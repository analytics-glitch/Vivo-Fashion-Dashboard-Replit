/**
 * Brand + country accent tokens for the Vivo Loyalty web app.
 *
 * Mirrors the staff cockpit (artifacts/vivo-bi) and the Expo app
 * (artifacts/vivo-mobile/constants/colors.ts) so all surfaces share one visual
 * language. Represent brands/countries with a colored dot + the name — no
 * logos, no flag glyphs — per the project's design preference.
 */

export const BRAND_COLORS: Record<string, string> = {
  vivo: "#1a5c38",
  sz: "#7c3aed",
};

export const BRAND_LABELS: Record<string, string> = {
  vivo: "Vivo",
  sz: "Shop Zetu",
};

export const brandColor = (code?: string | null): string =>
  (code && BRAND_COLORS[code]) || "#6b7280";

export const brandLabel = (code?: string | null): string =>
  (code && BRAND_LABELS[code]) || code || "—";

export const COUNTRY_COLORS: Record<string, string> = {
  Kenya: "#1a5c38",
  Uganda: "#d97706",
  Rwanda: "#00c853",
  Online: "#4b7bec",
  Other: "#6b7280",
};

export const countryColor = (name?: string | null): string =>
  (name && COUNTRY_COLORS[name]) || COUNTRY_COLORS.Other;

/** Format a number with thousands separators (no currency). */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-GB");
}

/** Format an amount as Kenyan Shillings, e.g. "KES 1,250". */
export function fmtKES(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "KES 0";
  return `KES ${Math.round(n).toLocaleString("en-GB")}`;
}

/** Format an ISO date as "01 Jun 2026"; returns the input on parse failure. */
export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
