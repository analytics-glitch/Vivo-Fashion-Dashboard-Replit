#!/usr/bin/env bash
set -euo pipefail

# pnpm forwards an explicit `--` separator to package scripts. It is not a
# Playwright argument: leaving it here makes Playwright ignore the requested
# test file and discover the entire e2e directory.
if [[ "${1:-}" == "--" ]]; then
  shift
fi

# Give every invocation an isolated output directory. Playwright clears its
# outputDir at startup, so a shared directory would erase another run's proof.
release_run_id="${VIVO_E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export VIVO_E2E_OUTPUT_DIR="${VIVO_E2E_OUTPUT_DIR:-$PWD/artifacts/vivo-bi/test-results/run-$release_run_id}"

# Replit's NixOS image supplies a patched Chromium binary, while Playwright's
# downloaded glibc browser cannot run here.  Link that system binary into the
# revisioned locations Playwright resolves at runtime.  Keeping the shim in
# /tmp avoids committing browser binaries or test-runtime state.
chrome_bin="${PLAYWRIGHT_NIX_CHROMIUM:-}"
if [[ -z "$chrome_bin" ]]; then
  chrome_bin="$(command -v chromium 2>/dev/null || true)"
fi
if [[ -z "$chrome_bin" || ! -x "$chrome_bin" ]]; then
  for candidate in /nix/store/*-chromium-*/bin/chromium; do
    if [[ -x "$candidate" ]]; then
      chrome_bin="$candidate"
      break
    fi
  done
fi

if [[ -z "$chrome_bin" || ! -x "$chrome_bin" ]]; then
  echo "Unable to find the Nix Chromium executable. Set PLAYWRIGHT_NIX_CHROMIUM to its path." >&2
  exit 1
fi

default_path="$(node -e 'const { chromium } = require("@playwright/test"); process.stdout.write(chromium.executablePath())')"
browser_dir="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/vivo-playwright-browsers}"
chromium_revision="$(basename "$(dirname "$(dirname "$default_path")")")"
headless_revision="chromium_headless_shell-${chromium_revision#chromium-}"

mkdir -p \
  "$browser_dir/$chromium_revision/chrome-linux64" \
  "$browser_dir/$headless_revision/chrome-headless-shell-linux64"
ln -sf "$chrome_bin" "$browser_dir/$chromium_revision/chrome-linux64/chrome"
ln -sf "$chrome_bin" "$browser_dir/$headless_revision/chrome-headless-shell-linux64/chrome-headless-shell"

export PLAYWRIGHT_BROWSERS_PATH="$browser_dir"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
exec pnpm exec playwright test "$@"