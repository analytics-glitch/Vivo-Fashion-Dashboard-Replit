import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests for the Vivo Loyalty PWA.
 *
 * The tests target the loyalty app served through the shared dev proxy at
 * http://localhost:80/loyalty-app (the same origin the browser sees in the
 * Replit preview pane).  Set LOYALTY_E2E_BASE_URL to override.
 *
 * Authentication: tests create a temporary Customer row + OTP directly in the
 * loyalty_app Postgres schema, then navigate to the magic-link sign-in URL so
 * the SPA auto-verifies without needing a working SMTP server.
 *
 * Run:  npx playwright test   (from this directory)
 * Or:   npm run test:e2e
 */

/**
 * Origin only — test paths must include the /loyalty-app prefix explicitly.
 * In Playwright, page.goto('/loyalty-app/rewards') resolves against the origin
 * root, so baseURL must not include the path prefix or the leading slash in
 * page.goto() calls would drop it.
 */
const BASE_URL =
  process.env.LOYALTY_E2E_BASE_URL ||
  `http://localhost:${process.env.PORT_PROXY ?? 80}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 430, height: 900 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
