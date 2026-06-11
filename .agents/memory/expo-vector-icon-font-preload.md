---
name: Expo vector-icon font preload (tofu on Android)
description: Why tab/vector icons render as missing-glyph "tofu" boxes on native Android/Expo Go but look fine on web, and the fix.
---

# Expo vector-icon "tofu" on Android

Tab bar / vector icons render correctly on the Expo **web** build but show as
missing-glyph "tofu" boxes (hourglass-in-a-box) on **Android via Expo Go**.

**Cause:** The root layout gates first render on `useFonts({...})` for the custom
text fonts only, and never preloads the `@expo/vector-icons` glyph font. On web the
icon font is injected via CSS so it always works; on native the glyph font isn't
loaded by the time the tab bar renders, so glyphs fall back to system tofu.

**Fix:** Spread the icon set's `.font` into the same `useFonts` call so it's loaded
before render:

```ts
import { Feather } from "@expo/vector-icons";
const [loaded] = useFonts({
  Jakarta_400Regular: ...,
  ...Feather.font,   // preload the glyph font used by the tab bar
});
```

**How to apply:** Whenever an Expo app uses `@expo/vector-icons` (Feather/Ionicons/
etc.) for tab icons AND gates render on `useFonts`, add that icon set's `.font` to
the `useFonts` map. Add every icon family actually used. Symptom is platform-split:
web fine, native tofu.
