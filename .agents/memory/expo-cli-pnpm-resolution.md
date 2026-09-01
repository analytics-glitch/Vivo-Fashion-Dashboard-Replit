---
name: Expo CLI resolution under pnpm
description: Avoiding Expo startup and Metro preset failures caused by nested CLI resolution in this pnpm workspace.
---

In this workspace, `pnpm exec expo` launches the CLI bundled under the `expo` package, even when the artifact directly pins a different `@expo/cli` version. Invoke the artifact's pinned CLI entry point directly when the nested CLI has a known startup regression. Metro's worker resolves Babel presets from the workspace root, so `babel-preset-expo` must be an explicit root dependency.

**Why:** The nested Expo CLI failed before Metro with an Undici “Body has already been read” error. After selecting the pinned CLI, Metro exposed a second pnpm-isolation failure because its worker could not resolve the transitive Babel preset.

**How to apply:** For Expo artifacts showing pre-Metro CLI crashes, compare the version printed by `pnpm exec expo --version` with the directly resolved `@expo/cli`. If they differ, run the pinned CLI entry point directly. Keep the SDK-matched Babel preset available at workspace root.