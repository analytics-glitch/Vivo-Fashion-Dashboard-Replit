// @ts-check
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:80",
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: "on",
    // The Nix browser shim deliberately supplies Chromium only. Traces and
    // screenshots retain actionable release evidence without requiring a
    // separately-downloaded revisioned ffmpeg helper for optional video.
    video: "off",
    screenshot: "on",
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
