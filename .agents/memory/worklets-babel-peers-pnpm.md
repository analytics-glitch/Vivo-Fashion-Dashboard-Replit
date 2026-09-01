---
name: Worklets Babel peers in pnpm
description: Why Expo production bundling needs root-level Babel helper declarations when react-native-worklets is used in this pnpm monorepo.
---

`react-native-worklets` 0.5.x loads `@babel/types`, `@babel/generator`, and
`@babel/traverse` from its Babel plugin but does not reliably expose those
dependencies under pnpm's strict isolation. Declare the three helpers as
workspace-root development dependencies. Declaring them only in an Expo
artifact is insufficient because the plugin resolves from its own package path.

**Why:** Production Metro bundling failed at the first module with HTTP 500 and
`Cannot find module '@babel/types'`; after adding that helper alone, the same
plugin failed on `@babel/generator`. Root-level declarations for the complete
require set restored both iOS and Android bundles.

**How to apply:** If an Expo artifact using worklets fails inside
`babel-preset-expo` before application modules transform, inspect the plugin's
actual Babel requires and keep those build-tool dependencies at the workspace
root. Preserve detailed Metro response bodies in custom build wrappers.