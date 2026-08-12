---
name: Playwright e2e browser shim on NixOS workspace
description: How to run the repo's ./e2e Playwright suite here — downloaded browsers fail on missing system libs; shim the nix-store chromium into the expected revision folder.
---

# Running the ./e2e Playwright suite in this workspace

The repo has a real Playwright suite (`e2e/*.spec.js`, `playwright.config.js`,
`npm run test:e2e`) with auth handled by `e2e/global-setup.js` (inserts a temp
admin `user_sessions` row, exposes `VIVO_E2E_TOKEN`, injected as
`localStorage.vivo_token`). It runs against `http://localhost:80` (the proxy),
so the api-server and vivo-bi workflows must be running.

**Problem:** `npx playwright install chromium` downloads glibc-linked binaries
that crash on NixOS with `error while loading shared libraries:
libglib-2.0.so.0`. `install-deps` cannot work here either.

**Fix that works:** symlink a nix-store Playwright chromium into a shim
directory named after the revision the installed `@playwright/test` expects,
then point `PLAYWRIGHT_BROWSERS_PATH` at it:

```bash
# find bundles: ls /nix/store | grep playwright-browsers
NIXCHROME=/nix/store/<hash>-playwright-browsers-1.55.0-with-cjk/chromium-1187/chrome-linux/chrome
mkdir -p /tmp/pw-browsers/chromium_headless_shell-<REV>/chrome-headless-shell-linux64
ln -sf $NIXCHROME /tmp/pw-browsers/chromium_headless_shell-<REV>/chrome-headless-shell-linux64/chrome-headless-shell
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true npx playwright test ...
```

`<REV>` = the revision in the "Executable doesn't exist at …" error (e.g.
chromium_headless_shell-1228 for @playwright/test 1.61). A full-chromium nix
binary works fine as the headless shell despite the version gap (140 vs 149) —
7/7 smoke tests pass.

**Why:** nix binaries are patched to link against nix-store libs; Playwright
only checks the executable path exists. Rebuild the shim if /tmp is wiped.

**How to apply:** any time e2e verification is wanted (merch-hub-smoke,
l10-meeting-smoke, style-tracker specs). The suite asserts KPI presence via
`[data-testid*="kpi"]` + class fallback — keep `testId` props on KPI cards.
