// @ts-check
/**
 * Regression coverage for the global BI date picker on phone-sized browsers.
 * The desktop picker is intentionally a Radix popover; the mobile chooser must
 * stay inside the existing Filters sheet so that there is only one scroll
 * owner and no clipped portalled content.
 */

const { test, expect } = require("@playwright/test");

async function signIn(page, path) {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

  await page.goto("/");
  await page.context().addCookies([{ name: "session_token", value: token, url: page.url() }]);
  await page.goto(path);
  await page.waitForSelector('[data-testid="filter-bar"]', { timeout: 30_000 });
}

async function openMobileDateChooser(page) {
  await page.locator('[data-testid="mobile-filters-button"]').click();
  const sheet = page.locator('[data-testid="mobile-filters-sheet"]');
  const datePill = sheet.locator('[data-testid="date-range-pill"]');
  await expect(sheet).toBeVisible();
  await datePill.click();
  await expect(sheet.locator('[data-testid="date-range-mobile-panel"]')).toBeVisible();
  await expect(page.locator('[data-testid="date-range-panel"]')).toHaveCount(0);
  return { sheet, datePill };
}

test.describe("global date picker on a phone viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("scrolls through presets, applies a custom range, cancels, and reopens", async ({ page }) => {
    await signIn(page, "/overview");
    const { sheet, datePill } = await openMobileDateChooser(page);

    const lastYear = page.locator('[data-testid="preset-last_year-mobile"]');
    await lastYear.scrollIntoViewIfNeeded();
    await expect(lastYear).toBeVisible();
    await lastYear.click();

    await expect(page.locator('[data-testid="date-range-mobile-panel"]')).toHaveCount(0);
    await expect(datePill).toContainText("Last year");
    await expect(sheet).toBeVisible();

    // Reopen, use the custom calendar, and apply. Pick two enabled calendar
    // days so the URL must switch to the existing custom preset contract.
    await datePill.click();
    const custom = page.locator('[data-testid="preset-custom-mobile"]');
    await custom.scrollIntoViewIfNeeded();
    await custom.click();
    const calendarDays = page.locator(
      '[data-testid="date-range-mobile-panel"] [role="gridcell"]:not([aria-disabled="true"])'
    );
    expect(await calendarDays.count()).toBeGreaterThan(10);
    await calendarDays.nth(3).click();
    await calendarDays.nth(5).click();
    await page.locator('[data-testid="date-range-apply-mobile"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="date-range-apply-mobile"]').click();

    await expect(page.locator('[data-testid="date-range-mobile-panel"]')).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]p=custom(?:&|$)/);
    await expect(datePill).toBeFocused();

    // Cancel must be a clean close: the Filter sheet remains usable, focus
    // returns to the date trigger, and the chooser can immediately reopen.
    await datePill.click();
    await expect(page.locator('[data-testid="date-range-mobile-panel"]')).toBeVisible();
    await page.locator('[data-testid="date-range-cancel-mobile"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="date-range-cancel-mobile"]').click();
    await expect(page.locator('[data-testid="date-range-mobile-panel"]')).toHaveCount(0);
    await expect(datePill).toBeFocused();

    await datePill.click();
    await expect(page.locator('[data-testid="date-range-mobile-panel"]')).toBeVisible();
    await page.locator('[data-testid="date-range-cancel-mobile"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="date-range-cancel-mobile"]').click();

    // The same shared FilterBar must be safe to use on another routed BI page.
    await sheet.getByRole("button", { name: "Close" }).click();
    await signIn(page, "/retail");
    await openMobileDateChooser(page);
    await page.locator('[data-testid="date-range-cancel-mobile"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="date-range-cancel-mobile"]').click();
  });
});

test("desktop retains the two-pane popover", async ({ page }) => {
  await signIn(page, "/overview");
  await page.locator('[data-testid="date-range-pill"]').click();
  const panel = page.locator('[data-testid="date-range-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="preset-last_year"]')).toBeVisible();
  await expect(panel.locator('[data-testid="preset-custom"]')).toBeVisible();
  await page.locator('[data-testid="date-range-cancel"]').click();
  await expect(panel).toHaveCount(0);
});