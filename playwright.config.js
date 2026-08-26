// @ts-check
const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

const evidenceDir = process.env.VIVO_E2E_OUTPUT_DIR
  || path.join(__dirname, "artifacts", "vivo-bi", "test-results", "manual-run");

module.exports = defineConfig({
  testDir: "./e2e",
  // Keep reviewable release evidence next to the Vivo BI artifact instead of
  // relying on a status marker that carries no screenshots, traces, or logs.
  outputDir: evidenceDir,
  timeout: 60_000,
  retries: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(evidenceDir, "release-proof-report.json") }],
  ],
  use: {
    baseURL: "http://localhost:80",
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: "on",
    // The Nix browser shim deliberately supplies Chromium only. Traces and
    // screenshots retain actionable release evidence without requiring a
    // separately-downloaded revisioned ffmpeg helper for optional video.
    video: "off",
    // Each release flow writes named screenshots itself. Disabling the generic
    // test-finished capture keeps the retained bundle's inventory exact.
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  globalSetup: "./e2e/global-setup.js",
  globalTeardown: "./e2e/global-teardown.js",
});
