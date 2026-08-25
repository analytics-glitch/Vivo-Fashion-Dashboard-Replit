// @ts-check
// Smoke coverage for the aggregate-only Retail Customer Engagement surface.
const { test, expect } = require("@playwright/test");

const openLocations = async (page) => {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check e2e/global-setup.js");
  await page.goto("/");
  await page.context().addCookies([{ name: "session_token", value: token, url: page.url() }]);
  await page.goto("/retail?tab=locations");
  await expect(page.locator('[data-testid="locations-page"]')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('[data-testid="customer-engagement-status"]')).toBeVisible({ timeout: 120_000 });
};

test("retail customer-health API returns aggregate cohorts only", async ({ request }) => {
  const token = process.env.VIVO_E2E_TOKEN;
  const response = await request.get(
    "/api/retail/customer-health?date_from=2026-08-01&date_to=2026-08-25&country=Kenya",
    { headers: { Authorization: `Bearer ${token}` }, timeout: 120_000 },
  );
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.metrics).toHaveProperty("unique_customers");
  expect(body.metrics).toHaveProperty("footfall_available");
  expect(body.cohorts.map((row) => row.key)).toEqual([
    "active", "cooling", "at_risk", "high_risk", "lapsed",
  ]);
  for (const cohort of body.cohorts) {
    expect(cohort).toHaveProperty("store_count_reconciles", true);
    for (const store of cohort.stores) expect(store).not.toHaveProperty("customer_id");
  }
});

test("Locations engagement cards expand, export, and remain narrow-screen safe", async ({ page }) => {
  test.setTimeout(240_000);
  await openLocations(page);

  for (const id of ["loc-kpi-footfall", "loc-kpi-conversion", "loc-kpi-unique-customers"]) {
    await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-testid="customer-engagement-active"]')).toBeVisible();
  await page.locator('[data-testid="customer-engagement-active-toggle"]').click();
  await expect(page.locator('[data-testid="customer-engagement-active-stores"]')).toBeVisible();

  const cardDownload = page.waitForEvent("download");
  await page.locator('[data-testid="customer-engagement-active-export"]').click();
  expect((await cardDownload).suggestedFilename()).toContain("active");

  const allDownload = page.waitForEvent("download");
  await page.locator('[data-testid="customer-engagement-export-all"]').click();
  expect((await allDownload).suggestedFilename()).toContain("all-statuses");

  // Filter controls should refetch without dropping the section.
  await page.locator('[data-testid="channel-group-retail"]').click();
  await expect(page.locator('[data-testid="customer-engagement-status"]')).toBeVisible({ timeout: 120_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-testid="customer-engagement-status"]')).toBeVisible();
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(horizontalOverflow).toBe(false);
});
