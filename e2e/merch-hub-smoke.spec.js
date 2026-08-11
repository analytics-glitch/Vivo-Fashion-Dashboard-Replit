// @ts-check
/**
 * Smoke test: Merchandising Hub tabs 5–8 in the vivo-bi React SPA.
 *
 * Covers four tabs that were introduced together:
 *   merch-category    — Category Performance      (/api/merch/by-subcategory + /api/merch/summary)
 *   merch-lifecycle   — Style Lifecycle & Age     (/api/merch/styles + /api/merch/by-tier)
 *   merch-atrisk      — At-Risk & Actions         (/api/merch/styles)
 *   merch-replen      — Replenishment Planning    (/api/merch/styles + /api/merch/by-subcategory
 *                                                   + /api/merch/by-tier + /api/merch/summary)
 *
 * For each tab the test asserts:
 *   1. No ErrorBox is visible (no data-testid="error-box").
 *   2. The expected page heading is present.
 *   3. At least one KPI card is rendered with a non-empty value.
 *   4. At least one Recharts SVG chart is rendered.
 *
 * Auth: global-setup.js inserts a temporary admin session row into
 * user_sessions and writes the token to process.env.VIVO_E2E_TOKEN.
 * We inject it into localStorage before navigating to any gated page.
 */

const { test, expect } = require("@playwright/test");

// ── constants ────────────────────────────────────────────────────────────────

/** Tabs to exercise: { id, heading, kpiLabel } */
const MERCH_TABS = [
  {
    id: "merch-category",
    heading: "Category Performance",
    kpiLabel: "Top Category",
  },
  {
    id: "merch-lifecycle",
    heading: "Style Lifecycle & Age",
    // Lifecycle renders a heading containing this substring
    headingContains: true,
  },
  {
    id: "merch-atrisk",
    heading: "At-Risk Styles",
    headingContains: true,
    kpiLabel: "At Risk Styles",
  },
  {
    id: "merch-replen",
    heading: "Replenishment",
    headingContains: true,
    kpiLabel: "Total Weekly Velocity",
  },
];

/**
 * API endpoints that must return HTTP 200 before the UI test runs.
 * These are called with the same session token used by the browser.
 */
const MERCH_ENDPOINTS = [
  "/api/merch/by-subcategory",
  "/api/merch/summary",
  "/api/merch/styles",
  "/api/merch/by-tier",
];

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Open the vivo-bi SPA root with the e2e session token in localStorage,
 * then navigate to /?tab=<tabId> and wait for the loading spinner to clear.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} tabId
 */
async function openMerchTab(page, tabId) {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

  // Set token before navigation so the SPA picks it up on mount.
  await page.goto("/");
  await page.evaluate((t) => window.localStorage.setItem("vivo_token", t), token);

  // Navigate directly to the Merchandising Hub with the target tab.
  await page.goto(`/merchandising?tab=${tabId}`);

  // Wait for the SPA auth check to complete — the merch tab bar should appear.
  await page.waitForSelector('[data-testid="merch-tabs"]', { timeout: 30_000 });

  // The tab's loading state clears once the API responses arrive (5–10 s on a
  // cold cache). We wait for the loading spinner text to disappear, then add a
  // small settle pause for Recharts to paint.  The per-step assertions use
  // generous timeouts as the final safety net.
  await page
    .waitForFunction(
      () => !document.body.innerText.includes("Loading "),
      { timeout: 45_000 }
    )
    .catch(() => {
      // Proceed even if still loading — heading/chart assertions will surface
      // a cleaner failure message.
    });

  // Extra settle time for Recharts to complete its paint pass.
  await page.waitForTimeout(1_500);
}

// ── API health pre-check ──────────────────────────────────────────────────────

test("merch API endpoints return HTTP 200 with expected response shapes", async ({
  request,
}) => {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

  for (const endpoint of MERCH_ENDPOINTS) {
    const resp = await request.get(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status(), `${endpoint} should return 200`).toBe(200);

    const body = await resp.json();
    if (endpoint.includes("styles")) {
      expect(
        Array.isArray(body.styles),
        `${endpoint}: response must have a 'styles' array`
      ).toBe(true);
    } else if (endpoint.includes("summary")) {
      expect(
        typeof body.total_styles !== "undefined",
        `${endpoint}: response must have 'total_styles'`
      ).toBe(true);
    } else {
      // by-subcategory, by-tier
      expect(
        Array.isArray(body.rows),
        `${endpoint}: response must have a 'rows' array`
      ).toBe(true);
    }
  }
});

// ── per-tab UI smoke tests ────────────────────────────────────────────────────

for (const tab of MERCH_TABS) {
  test(`${tab.id}: heading, KPI card, and chart render without errors`, async ({
    page,
  }) => {
    await openMerchTab(page, tab.id);

    // 1. No error box
    await expect(
      page.locator('[data-testid="error-box"]'),
      `${tab.id}: must not show an error box`
    ).toHaveCount(0);

    // 2. Correct heading visible
    const headingLocator = tab.headingContains
      ? page.locator("h2").filter({ hasText: tab.heading })
      : page.locator("h2", { hasText: tab.heading });
    await expect(
      headingLocator.first(),
      `${tab.id}: heading "${tab.heading}" must be visible`
    ).toBeVisible({ timeout: 45_000 });

    // 3. At least one KPI card with a non-empty value
    // KPI cards are rendered by the KPICard component; they produce a
    // card containing a value element.  We look for any card whose value
    // text is not "—" and not blank.
    const nonEmptyKpi = await page.evaluate(() => {
      // KPI values: look for short bold/large text inside a card-white div
      const cards = [
        ...document.querySelectorAll('[class*="card"]'),
        ...document.querySelectorAll('[class*="kpi"]'),
      ];
      return cards.some((el) => {
        const t = (el.textContent || "").trim();
        return t.length > 0 && t !== "—";
      });
    });
    expect(
      nonEmptyKpi,
      `${tab.id}: at least one KPI card must have a non-empty value`
    ).toBe(true);

    // 4. At least one Recharts SVG rendered
    const chartCount = await page
      .locator(".recharts-wrapper svg, .recharts-surface")
      .count();
    expect(
      chartCount,
      `${tab.id}: at least one Recharts chart SVG must be rendered`
    ).toBeGreaterThan(0);
  });
}
