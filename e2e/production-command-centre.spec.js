/**
 * Release coverage for the Production Command Centre.
 *
 * The global setup creates a short-lived active-admin session and global
 * teardown deletes it. These tests deliberately never create or change
 * production records.
 */
const { test, expect } = require("@playwright/test");
const fs = require("fs");

const COMMAND_CENTRE_URL = "/production?tab=dashboard";
const STANDALONE_WORKSPACE_URL = "/production-workspace";
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

const TOKEN_ENV_BY_ROLE = {
  admin: "VIVO_E2E_TOKEN",
  production: "VIVO_E2E_PRODUCTION_TOKEN",
  quality: "VIVO_E2E_QUALITY_TOKEN",
};

async function authenticate(page, role = "admin") {
  const token = process.env[TOKEN_ENV_BY_ROLE[role]];
  if (!token) throw new Error("VIVO_E2E_TOKEN not set — check e2e/global-setup.js");

  await page.goto("/");
  await page.context().addCookies([
    { name: "session_token", value: token, url: page.url() },
  ]);
}

function commandCentre(page) {
  return page.locator('[data-testid="production-command-centre"]');
}

async function openCommandCentre(page) {
  await page.goto(COMMAND_CENTRE_URL);
  await expect(commandCentre(page)).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("Production Command Centre", { exact: true })).toBeVisible();
  for (const id of REQUIRED_SECTIONS) {
    await expect(page.locator(`[data-testid="${id}"]`), `${id} must be visible`).toBeVisible({
      timeout: 90_000,
    });
  }
}

async function openStandaloneWorkspace(page, tab = "") {
  await page.goto(`${STANDALONE_WORKSPACE_URL}${tab ? `?tab=${tab}` : ""}`);
  await expect(page.locator('[data-testid="pw-shell"]')).toBeVisible({
    timeout: 90_000,
  });
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

async function waitForRenderedCommandScope(page, expectedScope) {
  await expect.poll(async () => {
    const href = await commandCentre(page).getByRole("link", { name: "Quality", exact: true }).getAttribute("href");
    const destination = new URL(href || "/", "http://localhost");
    return Object.fromEntries(
      Object.keys(expectedScope).map((key) => [`prod_${key}`, destination.searchParams.get(`prod_${key}`)]),
    );
  }, {
    message: "Command Centre drill targets must reflect the rendered filter scope",
    timeout: 20_000,
  }).toEqual(Object.fromEntries(
    Object.entries(expectedScope).map(([key, value]) => [`prod_${key}`, value || null]),
  ));
}

test.beforeEach(async ({ page }, testInfo) => {
  const browserLog = [];
  const add = (kind, detail) => browserLog.push(`[${new Date().toISOString()}] ${kind}: ${detail}`);
  testInfo.browserLog = browserLog;
  page.on("console", (message) => add(`console.${message.type()}`, message.text()));
  page.on("pageerror", (error) => add("pageerror", error.stack || error.message));
  page.on("requestfailed", (request) => add("requestfailed", `${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      add("api-error", `${response.status()} ${response.url()}`);
    }
  });
});

test.afterEach(async ({}, testInfo) => {
  const content = testInfo.browserLog?.length
    ? testInfo.browserLog.join("\n")
    : "No browser console messages or failed requests recorded.";
  fs.writeFileSync(testInfo.outputPath("browser-console.txt"), `${content}\n`, "utf8");
});

test("Command Centre desktop handles filters, refresh failure, recovery, partial data, and every enabled drill-down", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 768 });
  await authenticate(page);
  await openCommandCentre(page);

  await expect(page.locator('[data-testid="command-error"]')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("command-centre-desktop-healthy.png"), fullPage: true });

  const initialScope = {
    plan_status: "approved",
    search: "e2e-command-centre",
  };
  await page.locator('select[aria-label="Plan status"]').selectOption("approved");
  await expect(page).toHaveURL(/prod_plan_status=approved/);
  await page.locator('input[aria-label="Search production scope"]').fill("e2e-command-centre");
  await expect(page).toHaveURL(/prod_search=e2e-command-centre/);
  await waitForRenderedCommandScope(page, initialScope);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await waitForRenderedCommandScope(page, { plan_status: "", search: "" });
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
  await expect(page.locator('[data-testid="command-completeness-warning"]')).not.toContainText(partialMessage);

  const expectedScope = {
    prod_plan_status: "approved",
    prod_search: "e2e-production-proof",
  };
  await page.locator('select[aria-label="Plan status"]').selectOption("approved");
  await expect(page).toHaveURL(/prod_plan_status=approved/);
  await page.locator('input[aria-label="Search production scope"]').fill("e2e-production-proof");
  await expect(page).toHaveURL(/prod_search=e2e-production-proof/);

  const drills = [
    {
      label: "Quality",
      click: () => commandCentre(page).getByRole("link", { name: "Quality", exact: true }).click(),
      url: /\/quality\?.*date_from=.*date_to=/,
      ready: () => expect(page.locator('[data-testid="app-shell"]')).toBeVisible(),
      scopedApi: "/api/production-workspace/execution/events",
    },
    {
      label: "Execution Capture",
      click: () => commandCentre(page).getByRole("button", { name: "Capture", exact: true }).click(),
      url: /\/production\?.*tab=capture/,
      ready: () => expect(page.locator('[data-testid="production-execution"]')).toBeVisible({ timeout: 90_000 }),
      scopedApi: "/api/production-workspace/execution",
    },
    {
      label: "Production Tracker",
      click: () => commandCentre(page).getByRole("button", { name: "Tracker", exact: true }).click(),
      url: /\/production\?.*tab=tracker/,
      ready: () => expect(page.locator('[data-testid="production-title"]')).toBeVisible({ timeout: 90_000 }),
      unsupportedScope: true,
    },
    {
      label: "Production Report",
      click: () => commandCentre(page).getByRole("button", { name: "Report", exact: true }).click(),
      url: /\/production\?.*tab=report/,
      ready: () => expect(page.locator('[data-testid="production-report"]')).toBeVisible({ timeout: 90_000 }),
      unsupportedScope: true,
    },
    {
      label: "Order Tracker",
      click: () => commandCentre(page).getByRole("link", { name: "Order Tracker", exact: true }).click(),
      url: /\/central-tracker\?.*date_from=.*date_to=/,
      ready: () => expect(page.locator('[data-testid="app-shell"]')).toBeVisible(),
      unsupportedScope: true,
    },
    {
      label: "Planning Workspace",
      click: () => commandCentre(page).getByRole("button", { name: "Planning", exact: true }).click(),
      url: /\/production\?.*tab=workspace/,
      ready: () => expect(page.locator('[data-testid="production-planning-workspace"]')).toBeVisible({ timeout: 90_000 }),
      scopedApi: "/api/production-workspace/plans",
    },
    {
      label: "Productivity & Recovery",
      click: () => commandCentre(page).getByRole("button", { name: "Recovery history", exact: true }).click(),
      url: /\/production\?.*tab=insights/,
      ready: () => expect(page.locator('[data-testid="production-insights"]')).toBeVisible({ timeout: 90_000 }),
      scopedApi: "/api/production-workspace/productivity",
    },
  ];
  await expect(commandCentre(page).getByRole("link", { name: "Quality", exact: true })).toHaveCount(1);
  for (const label of ["Capture", "Tracker", "Report", "Planning", "Recovery history"]) {
    await expect(commandCentre(page).getByRole("button", { name: label, exact: true }), `${label} must be enabled for admin`).toHaveCount(1);
  }
  for (const drill of drills) {
    await openCommandCentre(page);
    const drillScope = {
      plan_status: "approved",
      search: "e2e-production-proof",
    };
    await page.locator('select[aria-label="Plan status"]').selectOption("approved");
    await expect(page).toHaveURL(/prod_plan_status=approved/);
    await page.locator('input[aria-label="Search production scope"]').fill("e2e-production-proof");
    await expect(page).toHaveURL(/prod_search=e2e-production-proof/);
    await waitForRenderedCommandScope(page, drillScope);
    const scopedRequest = drill.scopedApi
      ? page.waitForRequest((request) => {
        if (!request.url().includes(drill.scopedApi)) return false;
        const requestUrl = new URL(request.url());
        return requestUrl.searchParams.has("date_from")
          && requestUrl.searchParams.has("date_to")
          && requestUrl.searchParams.get("plan_status") === "approved"
          && requestUrl.searchParams.get("search") === "e2e-production-proof";
      }, { timeout: 90_000 })
      : null;
    await drill.click();
    await expect(page, `${drill.label} must keep the Command Centre destination`).toHaveURL(drill.url);
    // Navigation sets the destination tab first and applies the inherited
    // scope on the following render. Poll rather than sampling the URL between
    // those two state updates, otherwise a correct transition is flaky.
    await expect.poll(() => {
      const destination = new URL(page.url());
      return Object.fromEntries(
        Object.keys(expectedScope).map((key) => [key, destination.searchParams.get(key)]),
      );
    }, {
      message: `${drill.label} must preserve the Command Centre scope`,
      timeout: 20_000,
    }).toEqual(expectedScope);
    await drill.ready();
    if (scopedRequest) await scopedRequest;
    if (drill.unsupportedScope) {
      await expect(page.locator('[data-testid="production-scope"]')).toHaveAttribute("data-scope-applied", "false");
    }
    await page.screenshot({
      path: testInfo.outputPath(`command-drill-${drill.label.toLowerCase().replaceAll(/[^a-z]+/g, "-")}.png`),
      fullPage: true,
    });
  }
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

  await commandCentre(page).getByRole("link", { name: "Quality", exact: true }).click();
  await expect(page).toHaveURL(/\/quality\?.*date_from=.*date_to=/);
});

test("Standalone Production Workspace uses factory modules, direct URLs and legacy tab mappings", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticate(page);
  await openStandaloneWorkspace(page);

  await expect(page).toHaveURL(/\/production-workspace$/);
  await expect(page.locator('[data-testid="pw-workspace-home"]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-testid="pw-scope-bar"]')).toContainText("Factory");
  await expect(page.locator('[data-testid="pw-scope-bar"]')).toContainText("Delivery risk");
  await expect(page.locator('[data-testid="pw-nav"] button')).toHaveText([
    "Workspace",
    "Production Plan",
    "Line Board",
    "Work Orders",
    "Execution",
    "Quality & Rework",
    "Machines",
    "Operator Productivity",
    "Recovery Room",
    "Shift Huddle / L10",
    "Team",
    "Resources",
    "Setup & Settings",
  ]);

  await page.locator('[data-testid="pw-nav-plan"]').click();
  await expect(page).toHaveURL(/\/production-workspace\/plan/);
  await expect(page.locator('[data-testid="production-planning-workspace"]')).toBeVisible({ timeout: 90_000 });

  await openStandaloneWorkspace(page, "capture");
  await expect(page.locator('[data-testid="production-execution"]')).toBeVisible({ timeout: 90_000 });

  await openStandaloneWorkspace(page, "insights");
  await expect(page.locator('[data-testid="production-insights"]')).toBeVisible({ timeout: 90_000 });

  await page.goto("/production-workspace/quality");
  await expect(page.locator('[data-testid="pw-quality-rework"]')).toBeVisible({ timeout: 90_000 });
  await page.goto("/production-workspace/settings");
  await expect(page.locator('[data-testid="pw-settings"]')).toBeVisible({ timeout: 90_000 });

  await page.goto(COMMAND_CENTRE_URL);
  await expect(commandCentre(page)).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-testid="prod-tab-tracker"]')).toBeVisible();
  await expect(page.locator('[data-testid="pw-shell"]')).toHaveCount(0);
  await page.goto(STANDALONE_WORKSPACE_URL);
  await page.screenshot({ path: testInfo.outputPath("standalone-production-workspace-desktop.png"), fullPage: true });
});

test("Production Workspace fails closed without a session", async ({ page }) => {
  await page.goto(STANDALONE_WORKSPACE_URL);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('[data-testid="pw-shell"]')).toHaveCount(0);
});

test("Production role can use production destinations but is denied Order Tracker", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await authenticate(page, "production");
  await openCommandCentre(page);

  await expect(commandCentre(page).getByRole("link", { name: "Order Tracker", exact: true })).toHaveCount(0);
  for (const label of ["Capture", "Tracker", "Report", "Planning", "Recovery history"]) {
    await expect(commandCentre(page).getByRole("button", { name: label, exact: true }), `${label} should be enabled for Production`).toBeEnabled();
  }
  await commandCentre(page).getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page).toHaveURL(/\/production\?.*tab=capture/);
  await expect(page.locator('[data-testid="production-execution"]')).toBeVisible({ timeout: 90_000 });

  await page.goto("/central-tracker");
  await expect(page).not.toHaveURL(/\/central-tracker/);
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("production-role-denied-order-tracker.png"), fullPage: true });
});

test("Quality role redacts personnel productivity at phone width", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page, "quality");
  await openCommandCentre(page);
  await expect(commandCentre(page).getByRole("link", { name: "Quality", exact: true })).toHaveCount(1);
  await expect(commandCentre(page).getByRole("link", { name: "Order Tracker", exact: true })).toHaveCount(0);
  await expect(commandCentre(page).getByRole("button", { name: "Tracker", exact: true })).toHaveCount(0);
  await expect(commandCentre(page).getByRole("button", { name: "Report", exact: true })).toHaveCount(0);
  await page.goto("/production?tab=insights");
  await expect(page.locator('[data-testid="production-insights"]')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("individual attendance and efficiency are withheld.", { exact: false })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Earned / attended", exact: true })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Efficiency", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid="prod-tab-tracker"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="prod-tab-report"]')).toHaveCount(0);
  const productivity = await page.evaluate(async () => {
    const response = await fetch("/api/production-workspace/productivity");
    return { status: response.status, body: await response.json() };
  });
  expect(productivity.status).toBe(200);
  expect(productivity.body.scope.quality_context_only).toBe(true);
  expect(productivity.body.rows).toHaveLength(1);
  expect(productivity.body.rows[0]).toMatchObject({ target_qty: 10, actual_qty: 10, good_qty: 8 });
  const fixture = JSON.parse(fs.readFileSync(process.env.VIVO_E2E_RUN_FILE, "utf8")).productionFixture;
  expect(JSON.stringify(productivity.body.rows)).not.toContain(fixture.operatorName);
  for (const row of productivity.body.rows) {
    for (const privateField of ["operator_user_id", "operator_id", "operator_name", "attended_minutes", "earned_minutes", "efficiency_pct"]) {
      expect(row, `${privateField} must not cross the quality-role API boundary`).not.toHaveProperty(privateField);
    }
  }
  await expect(page.getByText("E2E Release Line", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("quality-role-redaction-phone.png"), fullPage: true });
});

test("Weekly L10 is a distinct governed cadence from the daily Shift Huddle", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await authenticate(page);

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${STANDALONE_WORKSPACE_URL}/huddle`);
    await expect(page.locator('[data-testid="pw-huddle"]')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-testid="pw-cadence-mode-tabs"]')).toBeVisible();

    // Default mode is the daily Shift Huddle: the shift selector is present.
    await expect(page.locator('[data-testid="pw-cadence-create-shift_huddle"]')).toBeVisible();
    const shiftHuddleForm = page.locator('[data-testid="pw-cadence-create-shift_huddle"]');
    await expect(shiftHuddleForm.locator("select")).toHaveCount(2); // factory + shift selects

    // Switching to the weekly L10 tab is a genuinely distinct mode: the shift
    // selector disappears (an L10 is always factory-wide) and a "review
    // previous actions" panel is unique to this cadence type. The underlying
    // request must carry its own cadence_type, proving this is not the same
    // request with a relabeled tab.
    const l10Response = page.waitForResponse((response) =>
      response.url().includes("/api/production-workspace/cadences")
      && new URL(response.url()).searchParams.get("cadence_type") === "l10");
    await page.locator('[data-testid="pw-cadence-mode-l10"]').click();
    await l10Response;
    await expect(page.locator('[data-testid="pw-cadence-create-l10"]')).toBeVisible();
    const l10Form = page.locator('[data-testid="pw-cadence-create-l10"]');
    await expect(l10Form.locator("select")).toHaveCount(1); // factory select only, no shift
    await expect(page.locator('[data-testid="pw-cadence-mode-l10"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="pw-cadence-mode-shift_huddle"]')).toHaveAttribute("aria-selected", "false");

    // Switch back: the shift huddle request must also carry its own
    // cadence_type.
    const shiftResponse = page.waitForResponse((response) =>
      response.url().includes("/api/production-workspace/cadences")
      && new URL(response.url()).searchParams.get("cadence_type") === "shift_huddle");
    await page.locator('[data-testid="pw-cadence-mode-shift_huddle"]').click();
    await shiftResponse;
    await page.screenshot({
      path: testInfo.outputPath(`l10-cadence-tabs-${viewport.name}.png`),
      fullPage: true,
    });
  }
});

test("Weekly L10 carry-forward requires an earlier L10, is isolated from Shift Huddle data, and blocks a duplicate carry-forward", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = JSON.parse(fs.readFileSync(process.env.VIVO_E2E_RUN_FILE, "utf8")).productionFixture;
  const factoryId = fixture.ids.factory_id;
  const shiftId = fixture.ids.shift_id;
  await authenticate(page);
  // Land on an authenticated page in this origin before issuing same-origin
  // fetch() calls from the browser context.
  await page.goto(STANDALONE_WORKSPACE_URL);

  const call = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await response.json(); } catch (_e) { /* no body */ }
    return { status: response.status, json };
  }, { method, url, body });

  // Three factory-wide weekly L10s, oldest to newest.
  const l10Dates = ["2031-02-03", "2031-02-10", "2031-02-17"];
  const l10s = [];
  for (const meeting_date of l10Dates) {
    const res = await call("POST", "/api/production-workspace/cadences", {
      factory_id: factoryId, cadence_type: "l10", shift_id: null,
      meeting_date, headline: "E2E L10 release proof", reason: "e2e release proof",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // Proves the request truly created an L10, not a relabeled Shift Huddle.
    expect(res.json.record.cadence_type).toBe("l10");
    expect(res.json.record.shift_id).toBeNull();
    l10s.push(res.json.record);
  }
  const [week1, week2, week3] = l10s;

  // A Shift Huddle in the same factory and on the same date is entirely
  // separate data, not a shared row under a different label.
  const huddleRes = await call("POST", "/api/production-workspace/cadences", {
    factory_id: factoryId, cadence_type: "shift_huddle", shift_id: shiftId,
    meeting_date: l10Dates[0], headline: "E2E shift huddle release proof", reason: "e2e release proof",
  });
  expect(huddleRes.status, JSON.stringify(huddleRes.json)).toBe(200);
  expect(huddleRes.json.record.cadence_type).toBe("shift_huddle");

  const l10ListRes = await call(
    "GET",
    `/api/production-workspace/cadences?factory_id=${factoryId}&cadence_type=l10&date_from=${l10Dates[0]}&date_to=${l10Dates[2]}`,
  );
  expect(l10ListRes.status).toBe(200);
  const listedIds = l10ListRes.json.cadences.map((c) => c.id);
  expect(listedIds).toEqual(expect.arrayContaining([week1.id, week2.id, week3.id]));
  expect(listedIds).not.toContain(huddleRes.json.record.id);
  expect(l10ListRes.json.cadences.every((c) => c.cadence_type === "l10")).toBe(true);

  // Seed an open owned action on the earliest L10.
  const actionRes = await call("POST", `/api/production-workspace/cadences/${week1.id}/actions`, {
    title: "E2E carry-forward check", reason: "e2e release proof seed action",
  });
  expect(actionRes.status, JSON.stringify(actionRes.json)).toBe(200);
  const sourceActionId = actionRes.json.record.id;

  // Week 2's "review of previous actions" must surface the still-open action
  // from week 1 — this is the L10-only carry-forward review, not shared with
  // Shift Huddle.
  const week2Detail = await call(
    "GET",
    `/api/production-workspace/cadences?factory_id=${factoryId}&cadence_type=l10&date_from=${l10Dates[1]}&date_to=${l10Dates[1]}`,
  );
  const week2Payload = week2Detail.json.cadences.find((c) => c.id === week2.id);
  expect(week2Payload.prior_open_actions.map((a) => a.id)).toContain(sourceActionId);

  // Carrying the action forward into week 2 succeeds exactly once.
  const carryRes = await call("POST", `/api/production-workspace/cadences/${week2.id}/actions`, {
    carry_forward_from: sourceActionId, reason: "e2e release proof carry-forward",
  });
  expect(carryRes.status, JSON.stringify(carryRes.json)).toBe(200);
  expect(carryRes.json.record.carried_forward_from).toBe(sourceActionId);

  // A second attempt to carry the SAME source action forward — this time
  // into week 3 — must be rejected with a conflict, not silently duplicated.
  const duplicateCarryRes = await call("POST", `/api/production-workspace/cadences/${week3.id}/actions`, {
    carry_forward_from: sourceActionId, reason: "e2e release proof duplicate attempt",
  });
  expect(duplicateCarryRes.status, JSON.stringify(duplicateCarryRes.json)).toBe(409);
  expect(duplicateCarryRes.json.detail || "").toContain("already been carried forward");

  // Exactly one descendant of the source action exists, in week 2 only.
  const week2Actions = await call(
    "GET",
    `/api/production-workspace/cadences?factory_id=${factoryId}&cadence_type=l10&date_from=${l10Dates[1]}&date_to=${l10Dates[1]}`,
  );
  const week2Final = week2Actions.json.cadences.find((c) => c.id === week2.id);
  const descendants = week2Final.actions.filter((a) => a.carried_forward_from === sourceActionId);
  expect(descendants).toHaveLength(1);
});

test("Work Orders keeps unplanned tracker orders actionable and lets a viewer opt into planned-only", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = JSON.parse(fs.readFileSync(process.env.VIVO_E2E_RUN_FILE, "utf8")).productionFixture;
  await authenticate(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${STANDALONE_WORKSPACE_URL}/work-orders`);
  await expect(page.locator('[data-testid="pw-work-orders"]')).toBeVisible({ timeout: 90_000 });

  await page.locator("#pw-work-order-search").fill(fixture.runKey);
  await expect(page).toHaveURL(new RegExp(`prod_search=${fixture.runKey}`));

  const unplannedRow = page.locator("tr", { hasText: `${fixture.runKey}-unplanned` });
  const plannedRow = page.locator("tr", { hasText: `${fixture.runKey}-planned` });
  await expect(unplannedRow).toBeVisible({ timeout: 30_000 });
  await expect(plannedRow).toBeVisible();
  await expect(unplannedRow).toContainText("Unavailable — not yet planned");
  await expect(unplannedRow).toContainText("Plan this order");
  await expect(unplannedRow).toContainText("Not planned");
  await expect(page.locator('[data-testid="pw-work-orders-unplanned-note"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("work-orders-unplanned-visible.png"), fullPage: true });

  // Opting into "Planned only" must hide the unplanned order without
  // affecting the planned one, and must round-trip through the URL.
  const plannedOnlyCheckbox = page.locator('[data-testid="pw-work-orders-planned-only"] input');
  await plannedOnlyCheckbox.click();
  await expect(page).toHaveURL(/prod_intake_scope=planned/);
  await expect(plannedOnlyCheckbox).toBeChecked();
  await expect(unplannedRow).toHaveCount(0, { timeout: 30_000 });
  await expect(plannedRow).toBeVisible();
  await expect(page.locator('[data-testid="pw-work-orders-unplanned-note"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("work-orders-planned-only.png"), fullPage: true });

  await plannedOnlyCheckbox.click();
  await expect(page).not.toHaveURL(/prod_intake_scope=planned/);
  await expect(plannedOnlyCheckbox).not.toBeChecked();
  await expect(unplannedRow).toBeVisible({ timeout: 30_000 });
});