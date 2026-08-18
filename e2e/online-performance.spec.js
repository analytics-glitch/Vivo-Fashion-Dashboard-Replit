// Online Performance tab — smoke: page renders, KPI cards + charts appear,
// no error boundary, mode toggle works.
const { test, expect } = require("@playwright/test");
const fs = require("fs");

test("online performance tab renders", async ({ page }) => {
  test.setTimeout(240000);
  const token = fs.readFileSync("/tmp/probe_token.txt", "utf8").trim();
  await page.context().addCookies([{
    name: "session_token", value: token, url: "http://localhost:80",
  }]);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto("http://localhost:80/merchandising?tab=merch-online");
  await expect(page.locator('[data-testid="online-performance-page"]')).toBeVisible({ timeout: 120000 });

  // KPI cards
  for (const id of ["op-kpi-rev", "op-kpi-share", "op-kpi-fpsor", "op-kpi-soh",
                    "op-kpi-sor", "op-kpi-depth", "op-kpi-promo", "op-kpi-returns"]) {
    await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
  }
  // Chart sections
  for (const id of ["op-trend", "op-categories", "op-subcats", "op-colours",
                    "op-sizes", "op-mix", "op-depth-trend", "op-soh-cat", "op-insights"]) {
    await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
  }
  // Subcategory drill-down loads
  await expect(page.locator('[data-testid="op-subcat-select"]')).toBeVisible({ timeout: 60000 });

  // Toggle to Online only and back
  await page.locator('[data-testid="op-mode-online"]').click();
  await expect(page.locator('[data-testid="online-performance-page"]')).toBeVisible();
  await page.locator('[data-testid="op-mode-compare"]').click();
  await page.waitForTimeout(1500);

  const boundary = await page.getByText(/something went wrong/i).count();
  expect(boundary, "error boundary must not be visible").toBe(0);
  const boundaryErrors = consoleErrors.filter((t) => /ErrorBoundary caught/i.test(t));
  expect(boundaryErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
