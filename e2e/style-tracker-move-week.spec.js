// @ts-check
/**
 * E2E test: Moving a style to a different week via the "Move to week" dropdown
 * on the Style Tracker board.
 *
 * The test uses style id=3 ("Safari Mansi Wide Hem Tent Dress in Cotton") in
 * week 2026-27, which is an overdue week with four incomplete styles (ids 3,4,5,11).
 * Moving one style away leaves three incomplete styles in 2026-27, so that week
 * stays visible in the board's week picker — avoiding the week-disappears-on-empty
 * edge case and keeping the source assertion reliable.
 *
 * Auth: the global-setup.js injects a temporary admin session row into
 * user_sessions before the suite runs; global-teardown.js deletes it after.
 * The token is written to process.env.VIVO_E2E_TOKEN by global-setup.js.
 */

const { test, expect } = require("@playwright/test");

const SOURCE_WEEK = "2026-27";
const TARGET_WEEK = "2026-29";
const STYLE_ID = 3;
const STYLE_NAME_FRAGMENT = "Mansi";

test.describe("Style Tracker — move to week", () => {
  test.beforeEach(async ({ page }) => {
    const token = process.env.VIVO_E2E_TOKEN;
    if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

    await page.goto("/");
    // SPA auth rides on the httpOnly session cookie now (no localStorage token).
    await page.context().addCookies([{ name: "session_token", value: token, url: page.url() }]);
    await page.goto("/style-tracker");
    await page.waitForSelector('[data-testid="style-tracker-page"]', { timeout: 20_000 });
  });

  test("MoveToWeekMenu dropdown moves the card to the target week and back", async ({ page }) => {
    const picker = page.locator('[data-testid="week-picker-select"]');

    // --- 1. Select the source week ---
    await picker.selectOption(SOURCE_WEEK);
    await page.waitForSelector(`[data-testid="style-tracker-col-${SOURCE_WEEK}"]`, { timeout: 10_000 });

    // --- 2. Confirm the style card is in the source week ---
    const sourceCard = page.locator(`[data-testid="style-card-${STYLE_ID}"]`);
    await expect(sourceCard).toBeVisible();
    await expect(sourceCard).toContainText(STYLE_NAME_FRAGMENT);

    // --- 3. Use the Move-to-week dropdown to move it to the target week ---
    const moveDropdown = page.locator(`[data-testid="move-to-week-${STYLE_ID}"]`);
    await expect(moveDropdown).toBeVisible();
    await moveDropdown.selectOption(TARGET_WEEK);

    // --- 4. Optimistic update: card should disappear from the source column ---
    //        (the source week stays visible because other incomplete styles remain)
    await expect(sourceCard).not.toBeVisible({ timeout: 8_000 });
    await expect(page.locator(`[data-testid="style-tracker-col-${SOURCE_WEEK}"]`)).toBeVisible();

    // --- 5. Navigate to the target week and confirm the card is there ---
    await picker.selectOption(TARGET_WEEK);
    await page.waitForSelector(`[data-testid="style-tracker-col-${TARGET_WEEK}"]`, { timeout: 10_000 });

    const targetCard = page.locator(`[data-testid="style-card-${STYLE_ID}"]`);
    await expect(targetCard).toBeVisible();
    await expect(targetCard).toContainText(STYLE_NAME_FRAGMENT);

    // --- 6. Undo: move the card back to restore board state ---
    const undoDropdown = page.locator(`[data-testid="move-to-week-${STYLE_ID}"]`);
    await undoDropdown.selectOption(SOURCE_WEEK);
    await expect(targetCard).not.toBeVisible({ timeout: 8_000 });

    // --- 7. Confirm restored in source week ---
    await picker.selectOption(SOURCE_WEEK);
    await page.waitForSelector(`[data-testid="style-tracker-col-${SOURCE_WEEK}"]`, { timeout: 10_000 });
    const restoredCard = page.locator(`[data-testid="style-card-${STYLE_ID}"]`);
    await expect(restoredCard).toBeVisible();
    await expect(restoredCard).toContainText(STYLE_NAME_FRAGMENT);
  });
});
