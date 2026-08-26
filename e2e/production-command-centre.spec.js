/**
 * Release coverage for the Production Command Centre.
 *
 * The global setup creates a short-lived active-admin session and global
 * teardown deletes it. These tests deliberately never create or change
 * production records.
 */
const { test, expect } = require("@playwright/test");

const COMMAND_CENTRE_URL = "/production?tab=dashboard";
const COMMAND_CENTRE_PATH = "/api/production-workspace/command-centre";
const REQUIRED_SECTIONS = [
  "command-source-health",
  "command-filters",
  "command-stage-wip",
  "command-quality",
  "command-lines",
  "command-delivery",
  "command-definitions",
];

async function authenticate(page) {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check e2e/global-setup.js");

  await page.goto("/");
  await page.context().addCookies([
    { name: "session_token", value: token, url: page.url() },
  ]);
}

async function openCommandCentre(page) {
  await page.goto(COMMAND_CENTRE_URL);
  await expect(page.locator('[data-testid="production-command-centre"]')).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("Production Command Centre", { exact: true })).toBeVisible();
  for (const id of REQUIRED_SECTIONS) {
    await expect(page.locator(`[data-testid="${id}"]`), `${id} must be visible`).toBeVisible({
      timeout: 90_000,
    });
  }
}

function commandCentreResponse(page, status = 200) {
  return page.waitForResponse(
    (response) =>
      response.url().includes(COMMAND_CENTRE_PATH) && response.status() === status,
    { timeout: 90_000 },
  );
}

async function refreshHealthy(page) {
  const response = commandCentreResponse(page);
  await page.locator('[data-testid="command-refresh"]').click();
  await response;
  await expect(page.locator('[data-testid="command-refresh"]')).toHaveText("Refresh");
}

test("Command Centre desktop handles filters, refresh failure, recovery, partial data, and drill-down", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await authenticate(page);
  await openCommandCentre(page);

  await expect(page.locator('[data-testid="command-error"]')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("command-centre-desktop-healthy.png"), fullPage: true });

  await page.locator('select[aria-label="Plan status"]').selectOption("approved");
  await expect(page).toHaveURL(/prod_plan_status=approved/);
  await page.locator('input[aria-label="Search production scope"]').fill("e2e-command-centre");
  await expect(page).toHaveURL(/prod_search=e2e-command-centre/);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/production\?tab=dashboard$/);

  await refreshHealthy(page);

  const outageMessage = "synthetic Command Centre outage for verification";
  const outageRoute = new RegExp(`${COMMAND_CENTRE_PATH.replace(/\//g, "\\/")}.*`);
  await page.route(outageRoute, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: outageMessage }),
    });
  });
  await page.locator('[data-testid="command-refresh"]').click();
  await expect(page.locator('[data-testid="command-error"]')).toContainText(outageMessage, {
    timeout: 20_000,
  });
  await expect(page.locator('[data-testid="production-command-centre"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("command-centre-refresh-error.png"), fullPage: true });
  await page.unroute(outageRoute);

  await refreshHealthy(page);
  await expect(page.locator('[data-testid="command-error"]')).toBeHidden();

  const partialMessage = "synthetic partial source for verification";
  const partialRoute = new RegExp(`${COMMAND_CENTRE_PATH.replace(/\//g, "\\/")}.*`);
  await page.route(partialRoute, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...payload,
        sections: {
          ...payload.sections,
          productivity: {
            ...(payload.sections?.productivity || {}),
            state: "partial",
            message: partialMessage,
          },
        },
        completeness: {
          state: "partial",
          message: partialMessage,
          issues: [{ key: "productivity", state: "partial", message: partialMessage }],
        },
      }),
    });
  });
  await page.locator('[data-testid="command-refresh"]').click();
  await expect(page.locator('[data-testid="command-completeness-warning"]')).toContainText(partialMessage, {
    timeout: 20_000,
  });
  await page.screenshot({ path: testInfo.outputPath("command-centre-partial-data.png"), fullPage: true });
  await page.unroute(partialRoute);

  await refreshHealthy(page);
  await expect(page.locator('[data-testid="command-completeness-warning"]')).toBeHidden();

  await page.getByRole("link", { name: "Quality", exact: true }).click();
  await expect(page).toHaveURL(/\/quality\?.*date_from=.*date_to=/);
  await page.goBack();
  await expect(page.locator('[data-testid="production-command-centre"]')).toBeVisible({
    timeout: 90_000,
  });
});

test("Command Centre has no page-level overflow on phone or tablet", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await authenticate(page);

  for (const viewport of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCommandCentre(page);
    await expect(page.locator('[data-testid="command-refresh"]')).toBeVisible();
    await expect(page.locator('[data-testid="command-filters"]')).toBeVisible();

    const hasNoPageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(hasNoPageOverflow, `${viewport.name} must not have page-level horizontal overflow`).toBe(true);

    await refreshHealthy(page);
    await page.screenshot({
      path: testInfo.outputPath(`command-centre-${viewport.name}.png`),
      fullPage: true,
    });
  }

  await page.getByRole("link", { name: "Quality", exact: true }).click();
  await expect(page).toHaveURL(/\/quality\?.*date_from=.*date_to=/);
});