const svg = (body) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240">${body}</svg>`
)}`;

const solid = (base, light = "rgba(255,255,255,.18)") => svg(`
  <rect width="360" height="240" fill="${base}"/>
  <path d="M0 38C90 8 185 60 360 20V0H0Z" fill="${light}"/>
  <path d="M0 214C112 170 235 226 360 180V240H0Z" fill="rgba(0,0,0,.10)"/>
`);

const stripes = (base, accent) => svg(`
  <rect width="360" height="240" fill="${base}"/>
  <path d="M-72 242L120 -10M-8 266L184 14M56 290L248 38M120 314L312 62M184 338L376 86" stroke="${accent}" stroke-width="34" opacity=".95"/>
  <path d="M-44 242L148 -10M20 266L212 14M84 290L276 38M148 314L340 62" stroke="rgba(255,255,255,.28)" stroke-width="6"/>
`);

const floral = (base, accent, center) => svg(`
  <rect width="360" height="240" fill="${base}"/>
  <g fill="${accent}" opacity=".95">
    <circle cx="62" cy="52" r="21"/><circle cx="94" cy="52" r="21"/><circle cx="78" cy="27" r="21"/><circle cx="78" cy="77" r="21"/>
    <circle cx="245" cy="66" r="26"/><circle cx="284" cy="66" r="26"/><circle cx="264" cy="35" r="26"/><circle cx="264" cy="97" r="26"/>
    <circle cx="135" cy="180" r="30"/><circle cx="180" cy="180" r="30"/><circle cx="157" cy="145" r="30"/><circle cx="157" cy="215" r="30"/>
    <circle cx="330" cy="192" r="18"/><circle cx="357" cy="192" r="18"/><circle cx="344" cy="170" r="18"/><circle cx="344" cy="214" r="18"/>
  </g>
  <g fill="${center}"><circle cx="78" cy="52" r="10"/><circle cx="264" cy="66" r="12"/><circle cx="157" cy="180" r="13"/><circle cx="344" cy="192" r="8"/></g>
`);

const weave = (base, accent) => svg(`
  <rect width="360" height="240" fill="${base}"/>
  <path d="M0 14H360M0 42H360M0 70H360M0 98H360M0 126H360M0 154H360M0 182H360M0 210H360" stroke="${accent}" stroke-width="13" opacity=".72"/>
  <path d="M15 0V240M45 0V240M75 0V240M105 0V240M135 0V240M165 0V240M195 0V240M225 0V240M255 0V240M285 0V240M315 0V240M345 0V240" stroke="rgba(255,255,255,.30)" stroke-width="10"/>
`);

export const STYLE_PREFERENCE_VISUALS = {
  print_preferences: [
    { value: "Plain", label: "Plain & solids", image: solid("#a67559", "rgba(255,248,230,.32)") },
    { value: "Prints", label: "Prints & patterns", image: floral("#7c3e55", "#f3bb78", "#f7e8d4") },
  ],
  colour_shades: [
    { value: "Olive", label: "Olive", image: solid("#68723d") },
    { value: "Sage", label: "Sage", image: solid("#aab89b") },
    { value: "Emerald", label: "Emerald", image: solid("#08766b") },
    { value: "Cobalt", label: "Cobalt", image: solid("#3156b8") },
    { value: "Navy", label: "Navy", image: solid("#172d51") },
    { value: "Burgundy", label: "Burgundy", image: solid("#6b2436") },
    { value: "Blush", label: "Blush", image: solid("#e8b2ad") },
    { value: "Terracotta", label: "Terracotta", image: solid("#ba6246") },
    { value: "Cocoa", label: "Cocoa", image: solid("#70493b") },
    { value: "Ivory", label: "Ivory", image: solid("#eee6d2") },
    { value: "Charcoal", label: "Charcoal", image: solid("#3e4144") },
    { value: "Black", label: "Black", image: solid("#171717") },
  ],
  fabrics: [
    { value: "Cotton", label: "Cotton", image: weave("#ead9bd", "#d0b890") },
    { value: "Silk", label: "Silk", image: stripes("#be8175", "#e7bd9f") },
    { value: "Chiffon", label: "Chiffon", image: stripes("#bd9dc8", "#f1d9e7") },
    { value: "Denim", label: "Denim", image: weave("#426a91", "#274968") },
    { value: "Knit", label: "Knit", image: weave("#b16757", "#85493e") },
    { value: "Linen", label: "Linen", image: weave("#c7ae81", "#9d835b") },
  ],
};