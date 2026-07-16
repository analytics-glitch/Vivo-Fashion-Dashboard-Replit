# Design Palette — "Bluish Glass" system

The blur/glassmorphism color system used in Vivo Loyalty. Portable to any app
(Tailwind v4 `@theme` + CSS variables). Copy the token blocks below.

---

## 1. Brand ramp (indigo → violet)

The core bluish family. Used for gradients, accents, soft chips, focus rings.

| Token | Hex | Typical use |
| --- | --- | --- |
| `brand-50`  | `#eef2ff` | soft chip backgrounds |
| `brand-100` | `#e0e7ff` | ring / hover tint |
| `brand-200` | `#c7d2fe` | borders on hover |
| `brand-300` | `#a5b4fc` | subtle accents |
| `brand-400` | `#818cf8` | icon accents |
| `brand-500` | `#6366f1` | **primary brand** |
| `brand-600` | `#4f46e5` | buttons / strong fills |
| `brand-700` | `#4338ca` | button hover |
| `brand-800` | `#3730a3` | deep accents |
| `brand-900` | `#312e81` | dark chips |

```css
@theme {
  --color-brand-50:  #eef2ff;
  --color-brand-100: #e0e7ff;
  --color-brand-200: #c7d2fe;
  --color-brand-300: #a5b4fc;
  --color-brand-400: #818cf8;
  --color-brand-500: #6366f1;
  --color-brand-600: #4f46e5;
  --color-brand-700: #4338ca;
  --color-brand-800: #3730a3;
  --color-brand-900: #312e81;
}
```

## 2. Surface tokens (light + dark)

The neutral canvas the glass sits on. Auto-switches with `prefers-color-scheme`.

```css
:root {
  color-scheme: light;
  --bg:          #f6f7fb;  /* app background            */
  --card:        #ffffff;  /* elevated surface          */
  --card-border: #eef0f5;  /* hairline border           */
  --text:        #0b0b12;  /* primary text              */
  --text-muted:  #6b7280;  /* secondary text            */
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg:          #0a0a0f;
    --card:        #14141c;
    --card-border: #23232e;
    --text:        #f5f5f7;
    --text-muted:  #9ca3af;
  }
}
```

## 3. Signature gradients

```css
/* Dashboard "points hero" — 135° bluish→violet.
   The first stop is dynamic (per-tier colour), falling back to brand-500. */
background: linear-gradient(135deg, #6366f1 0%, #4f46e5 55%, #7c3aed 100%);

/* Referral hero — brand → fuchsia */
background: linear-gradient(135deg, #4f46e5 0%, #c026d3 100%);
```

Tailwind equivalent for the referral hero: `bg-gradient-to-br from-brand-600 to-fuchsia-600`.

## 4. Shadows & glow

```css
--shadow-card: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
--shadow-glow: 0 8px 40px rgba(99,102,241,.35);   /* brand glow under primary buttons */
```

## 5. The "blur" (glassmorphism) recipe

Frosted bars over content — the defining look of this system:

```html
<!-- Sticky top bar / bottom nav -->
<header class="backdrop-blur-xl"
        style="background: color-mix(in srgb, var(--bg) 80%, transparent)">
```

- **Frosted surface:** `backdrop-blur-xl` + a semi-transparent `--bg` via
  `color-mix(in srgb, var(--bg) 80%, transparent)`.
- **Ambient light blobs** (behind login/hero): large, low-opacity, heavily blurred
  circles of brand + fuchsia:
  ```html
  <div class="absolute h-72 w-72 rounded-full bg-brand-500/30 blur-3xl"></div>
  <div class="absolute h-72 w-72 rounded-full bg-fuchsia-500/20 blur-3xl"></div>
  ```
- **Card blur-glass:** `bg-[var(--card)]/90 backdrop-blur-xl` with a hairline
  `border-[var(--card-border)]`.

## 6. Semantic / status colors

| Purpose | Hex |
| --- | --- |
| Success | `#16a34a` |
| Warning | `#f59e0b` |
| Danger  | `#ef4444` / `#dc2626` |
| Info    | `#4f46e5` |
| Neutral | `#6b7280` |

## 7. Optional accent override (Vivo = orange)

Vivo keeps everything above bluish but recolors **buttons + tabs** with an orange
accent. This is the pattern for theming one app off this base palette:

```css
:root {
  --accent:        #fe6a02;
  --accent-600:    #ea5f00;
  --accent-700:    #c25000;
  --accent-soft:   #fff1e6;
  --shadow-accent: 0 8px 30px rgba(254,106,2,.35);
}
/* dark mode */
--accent-soft: rgba(254,106,2,.14);
```

Apply `--accent` to primary buttons and active tab/nav states; leave hero gradients
and soft chips on the bluish `brand-*` ramp.

---

_Fonts: **Inter** (variable). Radii: cards `1.75rem`, controls `1rem–1.25rem`._
