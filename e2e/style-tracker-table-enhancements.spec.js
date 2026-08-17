// @ts-check
/**
 * E2E test: Style Launch Planner table-view enhancements —
 *   1. Order Date + % Recv columns (11-column header)
 *   2. Column filters below the header (style text + selects) with the
 *      toolbar "Filters active — Clear" pill
 *   3. Excel export button downloading Style_Launch_Planner_<date>.xlsx
 *
 * Uses live board data: style id=3 ("Safari Mansi Wide Hem Tent Dress…") and
 * id=5 ("Vivo Studio Cowl Neck Maxi Dress") both sit in week 2026-27, so the
 * "Mansi" style filter keeps id=3 and hides id=5 without any week collapsing.
 *
 * Auth: global-setup.js injects a temporary admin session row into
 * user_sessions; the SPA rides on the httpOnly session cookie.
 */

const { test, expect } = require("@playwright/test");
const fs = require("fs");

test.describe("Style Launch Planner — table enhancements", () => {
  test.beforeEach(async ({ page }) => {
    const token = process.env.VIVO_E2E_TOKEN;
    if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

    await page.goto("/");
    await page.context().addCookies([{ name: "session_token", value: token, url: page.url() }]);
    await page.goto("/style-tracker");
    await page.waitForSelector('[data-testid="style-tracker-page"]', { timeout: 20_000 });
    await page.locator('[data-testid="style-tracker-view-table"]').click();
    await page.waitForSelector('[data-testid="style-tracker-table-view"]', { timeout: 15_000 });
  });

  test("Order Date and % Recv columns render with an 11-column header", async ({ page }) => {
    const headers = page
      .locator('[data-testid="style-tracker-table-view"] thead tr')
      .first()
      .locator("th");
    await expect(headers).toHaveCount(11);
    await expect(headers.nth(6)).toHaveText(/Order Date/i);
    await expect(headers.nth(9)).toHaveText(/% Recv/i);

    // % Recv badge for style id=3 (warehouse pct > 0 in live data) ends in "%"
    // and carries the wh_units tooltip.
    const pctBadge = page.locator('[data-testid="style-wh-pct-3"] span').first();
    await expect(pctBadge).toBeVisible();
    await expect(pctBadge).toHaveText(/^\d+%$/);
    await expect(pctBadge).toHaveAttribute("title", /ordered units received/i);

    // Order Date cell renders ("—" when the style has no order_date).
    await expect(page.locator('[data-testid="style-order-date-3"]')).toBeVisible();

    await page.screenshot({ path: "/tmp/st_table_enhanced.png", fullPage: false });
  });

  test("column filters narrow rows, show the pill, and clear", async ({ page }) => {
    // Both styles visible before filtering.
    await expect(page.locator('[data-testid="style-order-date-3"]')).toBeVisible();
    await expect(page.locator('[data-testid="style-order-date-5"]')).toBeVisible();
    await expect(page.locator('[data-testid="style-tracker-filters-active-pill"]')).toHaveCount(0);

    await page.locator('[data-testid="style-tracker-filter-style"]').fill("Mansi");

    await expect(page.locator('[data-testid="style-tracker-filters-active-pill"]')).toBeVisible();
    await expect(page.locator('[data-testid="style-order-date-3"]')).toBeVisible();
    await expect(page.locator('[data-testid="style-order-date-5"]')).toHaveCount(0);

    await page.screenshot({ path: "/tmp/st_table_filtered.png", fullPage: false });

    // Clear via the filter-row link restores all rows.
    await page.locator('[data-testid="style-tracker-filter-clear"]').click();
    await expect(page.locator('[data-testid="style-tracker-filters-active-pill"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="style-order-date-5"]')).toBeVisible();

    // An impossible style filter yields the filtered empty-state message.
    await page.locator('[data-testid="style-tracker-filter-style"]').fill("zzz-no-such-style-zzz");
    await expect(
      page.locator('[data-testid="style-tracker-table-view"]')
    ).toContainText("No styles match the current filters.");
  });

  test("Export downloads Style_Launch_Planner_<date>.xlsx", async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.locator('[data-testid="style-tracker-export"]').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^Style_Launch_Planner_\d{4}-\d{2}-\d{2}\.xlsx$/
    );
    const p = await download.path();
    const buf = fs.readFileSync(p);
    expect(buf.length).toBeGreaterThan(1000);
    // .xlsx is a zip container — magic bytes "PK".
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });
});
