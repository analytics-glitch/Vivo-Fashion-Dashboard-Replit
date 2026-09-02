---
name: Metro image-size compatibility
description: Keep Expo Metro on the safe image-size release that still accepts file paths.
---

Metro 0.83.x passes image file paths to `image-size`; the 2.0.2 override can crash with `TextDecoder.decode` during Expo bundling. Use patched 1.2.1 for Metro specifically. Its patch must guard zero-size ICNS entries, JXL partial-stream boxes, and the shared HEIF/JXL box scanner.

**Why:** A workspace-wide security override caused publish to fail only when the Expo mobile artifact bundled its `file.png` asset. No upstream `image-size` release fixes the zero-size parser advisories, so version-only audits cannot recognize the local remediation.

**How to apply:** Keep the targeted `'metro>image-size': 1.2.1` override and patched dependency. After lockfile changes, resolve Metro's active symlink and verify all three zero-size parser cases return under a shell timeout; audit exceptions are valid only for the locally patched CVEs.