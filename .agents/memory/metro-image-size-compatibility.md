---
name: Metro image-size compatibility
description: Keep Expo Metro on the safe image-size release that still accepts file paths.
---

Metro 0.83.x passes image file paths to `image-size`; the 2.0.2 override can crash with `TextDecoder.decode` during Expo bundling. Use the patched 1.2.1 release for Metro specifically, while retaining the newer global resolution for other consumers.

**Why:** A workspace-wide security override caused publish to fail only when the Expo mobile artifact bundled its `file.png` asset; the web build itself completed successfully.

**How to apply:** Prefer a workspace-level global `image-size` override plus a targeted `'metro>image-size': 1.2.1` override. Verify with the mobile production build and `pnpm install --frozen-lockfile`.