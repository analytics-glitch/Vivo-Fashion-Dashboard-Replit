/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Johari uses the same warm Vivo palette as the Community web app.
    text: '#262321',
    tint: '#c43e00',

    // Core surfaces
    background: '#faf8f3',
    foreground: '#262321',

    // Cards / elevated surfaces
    card: '#ffffff',
    cardForeground: '#262321',

    // Primary action color (buttons, links, active states)
    primary: '#fe5000',
    primaryForeground: '#ffffff',
    primaryDeep: '#c43e00',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#eee9df',
    secondaryForeground: '#262321',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#f1eee8',
    mutedForeground: '#706c68',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#eee9df',
    accentForeground: '#262321',

    // Destructive actions (delete, error states)
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#e2ddd4',
    input: '#d8d1c6',
    scrim: 'rgba(38, 35, 33, 0.42)',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 4,
};

export default colors;
