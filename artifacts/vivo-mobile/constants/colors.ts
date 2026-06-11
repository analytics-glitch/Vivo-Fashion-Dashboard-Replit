/**
 * Semantic design tokens for the Vivo BI mobile app.
 *
 * Mirrors the web cockpit's warm-peach / safari-green identity
 * (artifacts/vivo-bi/src/index.css) so both share one visual language.
 * Light mode only, per the project's design preference.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: "#1a1a1a",
    tint: "#1a5c38",

    // Core surfaces
    background: "#fed7aa", // warm peach
    foreground: "#1a1a1a",
    panel: "#ffedd5", // soft cream panel
    textSub: "#4b5563",

    // Cards / elevated surfaces
    card: "#ffffff",
    cardForeground: "#1a1a1a",

    // Primary action color (safari green)
    primary: "#1a5c38",
    primaryForeground: "#ffffff",
    primaryDeep: "#0f3d24",

    // Secondary / less-emphasis interactive surfaces
    secondary: "#ffedd5",
    secondaryForeground: "#1a1a1a",

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: "#ffedd5",
    mutedForeground: "#6b7280",

    // Accent highlights
    accent: "#00c853",
    accentForeground: "#0f3d24",

    // Destructive actions
    destructive: "#dc2626",
    destructiveForeground: "#ffffff",

    // Amber (Uganda / warnings)
    amber: "#d97706",

    // Borders and input outlines
    border: "#fdba74",
    borderStrong: "#fb923c",
    input: "#fdba74",
  },

  // Border radius (px). Web --radius is 0.75rem = 12px.
  radius: 12,
};

// Country accent colors — match the web cockpit. Represent countries with
// colored dots + the name (no flag glyphs), per the design preference.
export const COUNTRY_COLORS: Record<string, string> = {
  Kenya: "#1a5c38",
  Uganda: "#d97706",
  Rwanda: "#00c853",
  Online: "#4b7bec",
  Other: "#6b7280",
};

export const countryColor = (name?: string | null): string =>
  (name && COUNTRY_COLORS[name]) || COUNTRY_COLORS.Other;

export default colors;
