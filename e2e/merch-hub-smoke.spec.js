// @ts-check
/**
 * Smoke test: consolidated Merchandising Hub analytics tabs (Task 1286).
 *
 * The ten analytics tabs were merged into four:
 *   merch-overview   — Overview + At-Risk & Actions
 *   merch-sales      — Sales & Pricing (Sales/Financial/Sell-Through/Category)
 *   merch-inventory  — Inventory & Stock Health (renamed in Task 1324)
 *   merch-lifecycle  — Lifecycle & Launches (Lifecycle + New Arrivals)
 *
 * Navigation deliberately uses the RETIRED tab ids (merch-category,
 * merch-atrisk, merch-replen, merch-arrivals, …) so the smoke test also
 * proves the deep-link alias map resolves old bookmarks to the merged
 * successor tab instead of falling back to the first tab.
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

/** Tabs to exercise: { id, heading } — ids are retired aliases on purpose. */
const MERCH_TABS = [
  {
    // Category Performance → merged into Sales & Pricing (merch-sales)
    id: "merch-category",
    heading: "Sell-Through",
    headingContains: true,
  },
  {
    // Financial Performance → merged into Sales & Pricing (merch-sales)
    id: "merch-financial",
    heading: "Pricing & Realisation",
    headingContains: true,
  },
  {
    id: "merch-lifecycle",
    heading: "Style Lifecycle & Age",
    // Lifecycle renders a heading containing this substring
    headingContains: true,
  },
  {
    // New Arrivals & Pipeline → merged into Lifecycle & Launches
    id: "merch-arrivals",
    heading: "New Arrivals",
    headingContains: true,
  },
  {
    // At-Risk & Actions → merged into Overview
    id: "merch-atrisk",
    heading: "At-Risk Styles",
    headingContains: true,
  },
  {
    // Replenishment Planning → merged into Inventory & Stock Health
    id: "merch-replen",
    heading: "Replenishment",
    headingContains: true,
    // Renamed tab (Task 1324): the alias must land on a tab whose picker
    // option reads the new label.
    selectedLabel: "Inventory & Stock Health",
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
  // The SPA now authenticates via the httpOnly session cookie (localStorage
  // token removed for XSS hardening).
  await page.context().addCookies([{ name: "session_token", value: token, url: page.url() }]);

  // Navigate directly to the Merchandising Hub with the target tab.
  await page.goto(`/merchandising?tab=${tabId}`);

  // Wait for the SPA auth check to complete — the merch tab bar should appear.
  await page.waitForSelector('[data-testid="merch-tabs"]', { timeout: 30_000 });

  // The tab's loading state clears once the API responses arrive (5–10 s
  // warm, but the first tab hit after an api-server restart can take well
  // over a minute while the pool and merch aggregates warm up). We wait for
  // the loading spinner text to disappear, then add a small settle pause for
  // Recharts to paint.  The per-step assertions use generous timeouts as the
  // final safety net.
  await page
    .waitForFunction(
      () => !document.body.innerText.includes("Loading "),
      { timeout: 120_000 }
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

// ── SOR Report tab: must render the real SOR report, not the Exports page ────

test("pd-sor-report: renders the real SOR report component", async ({ page }) => {
  await openMerchTab(page, "pd-sor-report");
  await expect(
    page.locator('[data-testid="sor-report-tab"]'),
    "SOR Report tab must mount SORReportExport"
  ).toBeVisible({ timeout: 45_000 });
  // The Data Exports page it used to embed must NOT be present.
  await expect(page.locator('[data-testid="exports-page"]')).toHaveCount(0);
});

// ── retired pd-sor-new deep link → Catalog & SOR, which hosts the tracker ────

test("pd-sor-new alias: lands on Catalog & SOR with the 6–7-week sub-tab", async ({
  page,
}) => {
  await openMerchTab(page, "pd-sor-new");
  // Alias must resolve to the Catalog & SOR tab, whose sub-tab strip now
  // hosts the 6–7-week SOR tracker.
  const subTab = page.locator('[data-testid="subtab-sor-6wk"]');
  await expect(
    subTab,
    "Catalog & SOR must show the SOR New Styles (6–7 Wk) sub-tab"
  ).toBeVisible({ timeout: 45_000 });
  await subTab.click();
  await expect(
    page.locator('[data-testid="sor-new-styles-report-tab"]'),
    "6–7-week SOR tracker must render inside Catalog & SOR"
  ).toBeVisible({ timeout: 45_000 });
});

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

    // 2b. Renamed tab label (Task 1324): the page picker's selected option
    // must read the new label for tabs that declare one.
    if (tab.selectedLabel) {
      const pickerSelect = page.locator(
        '[data-testid="merch-tabs-select"] select'
      );
      await expect(
        pickerSelect,
        `${tab.id}: tab picker must be visible`
      ).toBeVisible({ timeout: 45_000 });
      const selectedText = await pickerSelect.evaluate(
        (el) => el.selectedOptions?.[0]?.textContent?.trim() || ""
      );
      expect(
        selectedText,
        `${tab.id}: selected tab label must read "${tab.selectedLabel}"`
      ).toBe(tab.selectedLabel);
    }

    // 3. At least one KPI card with a non-empty value
    // KPI cards are rendered by the KPICard component; they produce a
    // card containing a value element.  We look for any card whose value
    // text is not "—" and not blank.
    const nonEmptyKpi = await page.evaluate(() => {
      // KPI cards carry data-testid attributes containing "kpi"
      // (MerchKPICard testId prop); fall back to class-name matching for
      // any page still using bare card divs.
      const cards = [
        ...document.querySelectorAll('[data-testid*="kpi"]'),
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
