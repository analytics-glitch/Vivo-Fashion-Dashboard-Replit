// @ts-check
// Repro: Style Deep Dive crashes when typing into the style search input.
const { test, expect } = require("@playwright/test");

test("deep dive search typing does not crash", async ({ page }) => {
  test.setTimeout(240000);
  const token = process.env.VIVO_E2E_TOKEN;
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", e => pageErrors.push(e.stack || e.message));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("response", async r => {
    if (r.url().includes("/merch/styles")) {
      let size = "?";
      try { size = (await r.body()).length; } catch {}
      console.log("STYLES RESPONSE:", r.status(), r.url(), "bytes:", size);
    }
  });
  page.on("crash", () => console.log("!!! PAGE CRASHED at", new Date().toISOString()));
  page.on("requestfailed", r => {
    if (r.url().includes("/merch/")) console.log("REQ FAILED:", r.url(), r.failure()?.errorText);
  });

  await page.context().addCookies([{
    name: "session_token", value: token, url: "http://localhost:80",
  }]);
  await page.goto("/");
  await page.evaluate(t => localStorage.setItem("vivo_token", t), token);

  await page.goto("/merchandising?tab=merch-deepdive");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // Type into the first style search box
  const input = page.locator('[data-testid="merch-style-search"] input').first();
  await expect(input).toBeVisible({ timeout: 20000 });
  await input.click();
  await input.pressSequentially("maxi", { delay: 120 });
  await page.waitForTimeout(1500);
  await input.pressSequentially(" dress", { delay: 120 });
  await page.waitForTimeout(1500);

  // Select the first dropdown result (options have a font-mono style number span;
  // the clear "X" button does not).
  const option = page.locator('[data-testid="merch-style-search"] .font-mono').first();
  await expect(option, "dropdown should list matching styles").toBeVisible({ timeout: 10000 });
  await option.click();
  console.log("STEP: option clicked", new Date().toISOString());
  await page.waitForTimeout(1000);
  expect(page.url(), "a style should be selected").toContain("style=");
  console.log("STEP: style selected", page.url());
  // Wait for the selected-style view to finish loading & rendering
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  console.log("STEP: networkidle after select", new Date().toISOString());
  await page.waitForTimeout(6000);
  console.log("STEP: settled after select", new Date().toISOString());
  // The Gross Margin Waterfall (cost/pct branch) is the historical crash
  // site — assert the selected-style view actually rendered it.
  await expect(page.getByText("Gross Margin Waterfall"),
    "selected-style waterfall must render").toBeVisible({ timeout: 15000 });

  // Type again with a style selected
  console.log("STEP: begin type-with-selection", new Date().toISOString(), "closed:", page.isClosed());
  const input2 = page.locator('[data-testid="merch-style-search"] input').first();
  if (await input2.count()) {
    await input2.click().catch(() => {});
    await input2.pressSequentially("shirt", { delay: 100 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  console.log("STEP: typed shirt", new Date().toISOString(), "closed:", page.isClosed());
  // Exercise the clear button too
  const clearBtn = page.locator('[data-testid="merch-style-search"] > div button').first();
  if (await clearBtn.count()) await clearBtn.click().catch(() => {});
  await page.waitForTimeout(1000);
  console.log("STEP: cleared", new Date().toISOString(), "closed:", page.isClosed());
  // Type a query with no matches
  const input3 = page.locator('[data-testid="merch-style-search"] input').first();
  await input3.click().catch(() => {});
  await input3.pressSequentially("zzzqqqxx", { delay: 80 }).catch(() => {});
  await page.waitForTimeout(1200);

  console.log("FINAL URL:", page.url());
  console.log("PAGE ERRORS:\n" + (pageErrors.join("\n---\n") || "(none)"));
  console.log("CONSOLE ERRORS:\n" + (consoleErrors.slice(0, 10).join("\n") || "(none)"));
  const boundary = await page.getByText(/something went wrong/i).count();
  console.log("ERROR BOUNDARY VISIBLE:", boundary > 0);
  expect(boundary, "React error boundary must not be visible").toBe(0);
  const boundaryErrors = consoleErrors.filter(t => /ErrorBoundary caught/i.test(t));
  expect(boundaryErrors, "error boundary console errors").toEqual([]);
  expect(pageErrors, "unhandled page errors").toEqual([]);
});
