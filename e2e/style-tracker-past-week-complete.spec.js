// @ts-check
/**
 * E2E test: When the last incomplete style in an overdue past week is marked
 * as done, the week disappears from the board entirely, the week picker no
 * longer offers it, and the selected week falls back to the current week
 * without a crash or blank column.
 *
 * Auth: uses the shared admin session token created by global-setup.js.
 *
 * Test data: the test creates ONE style in ISO week 25 of 2026 (22 Jun–28 Jun,
 * comfortably in the past with no seed data). The style is created via the API
 * before the test and deleted after. We verify the week has zero pre-existing
 * incomplete styles before inserting, so the test is self-contained and the
 * edge case is pure: completing that one style must make the week vanish.
 */

const { test, expect } = require("@playwright/test");

const TEST_WEEK_YEAR = 2026;
const TEST_WEEK_NUM  = 25;
const WEEK_KEY       = `${TEST_WEEK_YEAR}-${TEST_WEEK_NUM}`;
const CHIP_TESTID    = `week-chip-${WEEK_KEY}`;
const COL_TESTID     = `style-tracker-col-${WEEK_KEY}`;
const STYLE_NAME     = "ST826-PastWeekComplete-TestStyle";

let createdStyleId = null;

test.describe("Style Tracker — past week disappears when last style is done", () => {
  test.beforeAll(async ({ request }) => {
    const token = process.env.VIVO_E2E_TOKEN;
    if (!token) throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

    // Guard: confirm W25 2026 has no pre-existing incomplete styles so the
    // test is isolated. If this fires, a previous run leaked data.
    const boardResp = await request.get("/api/style-tracker/board", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const board = await boardResp.json();
    const w25 = (board.weeks || []).find(
      (w) => w.iso_year === TEST_WEEK_YEAR && w.iso_week === TEST_WEEK_NUM
    );
    const incompleteInW25 = (w25?.styles || []).filter((s) => !s.completed && !s.archived);
    if (incompleteInW25.length > 0) {
      throw new Error(
        `W25 2026 already has ${incompleteInW25.length} incomplete style(s) — ` +
        "clean up previous test run before re-running."
      );
    }

    // Create the one test style.
    const createResp = await request.post("/api/style-tracker/styles", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {
        style_name: STYLE_NAME,
        brand: "VIVO",
        category: "WOVEN",
        quantity: 50,
        status: "Warehouse",
        iso_year: TEST_WEEK_YEAR,
        iso_week: TEST_WEEK_NUM,
      },
    });
    expect(createResp.ok()).toBeTruthy();
    const createBody = await createResp.json();
    createdStyleId = createBody?.style?.id;
    expect(createdStyleId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    const token = process.env.VIVO_E2E_TOKEN;
    if (!token || !createdStyleId) return;
    // Best-effort cleanup — delete the test style.
    await request.post(`/api/style-tracker/styles/${createdStyleId}/delete`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test.beforeEach(async ({ page }) => {
    const token = process.env.VIVO_E2E_TOKEN;
    await page.goto("/");
    await page.evaluate((t) => window.localStorage.setItem("vivo_token", t), token);
    await page.goto("/style-tracker");
    await page.waitForSelector('[data-testid="style-tracker-page"]', { timeout: 20_000 });
  });

  test("completing the last incomplete style removes the overdue past week from the board", async ({ page }) => {
    const picker = page.locator('[data-testid="week-picker-select"]');

    // 1. The W25 chip must be visible (overdue week present in the summary panel).
    await expect(page.locator(`[data-testid="${CHIP_TESTID}"]`)).toBeVisible({
      timeout: 10_000,
    });

    // 2. Select W25 in the week picker so the board column for that week is shown.
    await picker.selectOption(WEEK_KEY);
    await page.waitForSelector(`[data-testid="${COL_TESTID}"]`, { timeout: 10_000 });

    // 3. The test style card must be visible in the W25 column.
    const styleCard = page.locator(`[data-testid="style-card-${createdStyleId}"]`);
    await expect(styleCard).toBeVisible();
    await expect(styleCard).toContainText(STYLE_NAME);

    // 4. The "Mark as completed" button must be enabled (status = Warehouse → canDone).
    const doneBtn = page.locator(`[data-testid="style-card-complete-${createdStyleId}"]`);
    await expect(doneBtn).toBeVisible();
    await expect(doneBtn).not.toBeDisabled();

    // 5. Click the done button.
    await doneBtn.click();

    // 6. The W25 chip must disappear — the week has no more incomplete styles so the
    //    board endpoint stops returning it, and the frontend removes it from the DOM.
    await expect(page.locator(`[data-testid="${CHIP_TESTID}"]`)).not.toBeVisible({
      timeout: 10_000,
    });

    // 7. The board column for W25 must also be gone (no stale column rendered).
    await expect(page.locator(`[data-testid="${COL_TESTID}"]`)).not.toBeVisible({
      timeout: 5_000,
    });

    // 8. The board is still rendered — no crash, no blank page.
    await expect(page.locator('[data-testid="style-tracker-page"]')).toBeVisible();

    // 9. The week picker must no longer offer W25 as a selectable option.
    const pickerOptions = await picker.locator("option").allTextContents();
    const hasW25 = pickerOptions.some((text) => text.includes("WK 25") || text.includes("W25"));
    expect(hasW25).toBe(false);

    // 10. The selected week has fallen back to the current week (the picker value
    //     is not W25, and the board shows "This week" somewhere visible).
    const selectedVal = await picker.inputValue();
    expect(selectedVal).not.toBe(WEEK_KEY);
    await expect(page.getByText("This week")).toBeVisible({ timeout: 5_000 });
  });
});
