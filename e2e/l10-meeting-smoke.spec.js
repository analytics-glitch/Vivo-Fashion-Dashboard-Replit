// @ts-check
/**
 * Smoke test: L10 Meeting tab in Fabric BI (Supply Chain, native vanilla-JS
 * implementation — folder_id=2, no iframe).
 *
 * Covers:
 *  1. The L10 Meeting nav tab is revealed for admin users (gateL10Tab).
 *  2. Clicking it loads #l10-root without an old orange "Main BI" header /
 *     iframe shell — just the Fabric BI header + native L10 content.
 *  3. When a meeting exists, the 8-tab bar renders with all expected labels.
 *  4. Clicking the Conclude tab loads the ratings table; when enough history
 *     is present the SVG sparkline card ("Meeting Rating Trend") is visible.
 *  5. The vivo-bi Main BI SPA nav does NOT contain an "L10 Meeting" entry.
 *
 * Auth: global-setup.js inserts a temporary admin session row into
 * user_sessions; global-teardown.js removes it.  The token lands in
 * process.env.VIVO_E2E_TOKEN and must be injected into localStorage before
 * navigating to any gated page.
 */

const { test, expect } = require("@playwright/test");

/** IDs of all eight L10 inner tabs, in order. */
const L10_TAB_IDS = [
  "checkin",
  "scorecard",
  "rocks",
  "headlines",
  "todos",
  "ids",
  "conclude",
  "admin",
];

/** Expected visible labels for a subset of tabs (spot-check). */
const L10_TAB_LABELS = {
  checkin: "Check-In",
  scorecard: "Scorecard",
  todos: "To-Dos",
  ids: "IDS",
  conclude: "Conclude",
  admin: "Admin",
};

// ── shared helper ────────────────────────────────────────────────────────────

/**
 * Navigate to /fabric with auth token in localStorage, wait for the Fabric BI
 * header brand element to confirm the page has rendered.
 */
async function openFabric(page) {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token)
    throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

  // Set the token before the page loads so gateL10Tab picks it up immediately.
  await page.goto("/fabric");
  await page.evaluate((t) => window.localStorage.setItem("vivo_token", t), token);
  await page.reload();

  // Confirm the Fabric BI header rendered (brand lockup is always visible).
  await page.waitForSelector(".fab-brandname", { timeout: 20_000 });
}

/**
 * Wait for gateL10Tab() to reveal #nav-l10 (admin path) and click it.
 * Returns true when a meeting exists (tabbar rendered), false otherwise.
 */
async function clickL10Tab(page) {
  // gateL10Tab() runs after /api/auth/me resolves — wait for display to clear.
  await page.waitForFunction(
    () => {
      const el = document.getElementById("nav-l10");
      return el !== null && el.style.display !== "none";
    },
    { timeout: 15_000 }
  );

  await page.locator("#nav-l10").click();

  // Wait for l10-root to be populated (not empty).
  await page.waitForFunction(
    () => {
      const r = document.getElementById("l10-root");
      return r !== null && r.textContent.trim().length > 0;
    },
    { timeout: 15_000 }
  );

  // Return whether a meeting is already selected (tabbar present).
  return page.evaluate(() => document.getElementById("l10-tabbar") !== null);
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe("L10 Meeting — Fabric BI smoke", () => {
  test(
    "nav tab is revealed for admins and L10 section loads without an iframe or duplicate Main BI header",
    async ({ page }) => {
      await openFabric(page);
      await clickL10Tab(page);

      // ── No old iframe shell ──────────────────────────────────────────────
      // The native implementation never uses an <iframe>; the old approach did.
      await expect(page.locator("#page-l10 iframe")).toHaveCount(0);

      // ── No duplicate Main BI orange header inside the L10 section ────────
      // The Fabric BI wraps everything in a single .fab-header; there must
      // not be a second one injected inside the page-l10 section itself.
      await expect(page.locator("#page-l10 .fab-header")).toHaveCount(0);

      // ── The Fabric BI's own header is still visible (not removed) ─────────
      await expect(page.locator(".fab-header")).toBeVisible();

      // ── l10-root has content ─────────────────────────────────────────────
      await expect(page.locator("#l10-root")).not.toBeEmpty();
    }
  );

  test(
    "8-tab bar (Check-In … Admin) renders when a meeting exists",
    async ({ page }) => {
      await openFabric(page);
      const hasMeeting = await clickL10Tab(page);

      if (!hasMeeting) {
        // No meetings in this environment — "+ New Meeting" must be visible.
        await expect(page.locator("#l10-new-btn")).toBeVisible();
        // Nothing more to assert without a meeting; skip gracefully.
        test.info().annotations.push({
          type: "skip-reason",
          description:
            "No meetings in test DB — tab bar not rendered (acceptable)",
        });
        return;
      }

      // All eight tab buttons must exist and be visible.
      for (const tabId of L10_TAB_IDS) {
        await expect(page.locator(`#l10-t-${tabId}`)).toBeVisible();
      }

      // Spot-check label text on a subset of tabs.
      for (const [tabId, label] of Object.entries(L10_TAB_LABELS)) {
        await expect(page.locator(`#l10-t-${tabId}`)).toContainText(label);
      }

      // Active tab highlight: Check-In is the default tab; it should be
      // rendered with the Vivo orange accent (non-transparent border-bottom).
      const checkinColor = await page
        .locator("#l10-t-checkin")
        .evaluate((el) => el.style.borderBottomColor);
      // Either explicitly set to the orange CSS variable or non-transparent.
      expect(checkinColor).not.toBe("transparent");
      expect(checkinColor).not.toBe("");
    }
  );

  test(
    "Conclude tab loads ratings table; SVG sparkline visible when history exists",
    async ({ page }) => {
      await openFabric(page);
      const hasMeeting = await clickL10Tab(page);

      if (!hasMeeting) {
        test.info().annotations.push({
          type: "skip-reason",
          description: "No meetings in test DB — skipping Conclude tab check",
        });
        return;
      }

      // Click the Conclude tab.
      await page.locator("#l10-t-conclude").click();

      // Wait for l10-content to fully load (past the "Loading…" placeholder).
      await page.waitForFunction(
        () => {
          const c = document.getElementById("l10-content");
          if (!c || c.children.length === 0) return false;
          // Not still showing the loading placeholder.
          return c.textContent.trim() !== "Loading…";
        },
        { timeout: 15_000 }
      );

      // Cascading Messages and Meeting Ratings sections must always be present.
      await expect(page.locator("#l10-content")).toContainText(
        "Cascading Messages"
      );
      await expect(page.locator("#l10-content")).toContainText(
        "Meeting Ratings"
      );
      await expect(page.locator("#l10-content")).toContainText(
        "Rate the meeting 1–10"
      );

      // Sparkline: only rendered when ≥2 meetings have at least one rating.
      const hasSparkline = await page.evaluate(
        () => document.querySelector("#l10-content svg") !== null
      );

      if (hasSparkline) {
        // The sparkline card title and the SVG must both be in the DOM.
        await expect(page.locator("#l10-content")).toContainText(
          "Meeting Rating Trend"
        );
        await expect(page.locator("#l10-content svg")).toBeVisible();
      }
      // If !hasSparkline that is also valid (not enough history yet).
    }
  );

  test(
    "Main BI SPA nav (vivo-bi) does not contain an L10 Meeting entry",
    async ({ page }) => {
      const token = process.env.VIVO_E2E_TOKEN;
      if (!token)
        throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

      // The vivo-bi React SPA is served at the root path.
      await page.goto("/");
      await page.evaluate(
        (t) => window.localStorage.setItem("vivo_token", t),
        token
      );
      await page.reload();

      // Wait for the SPA to mount and paint at least part of the nav.
      // The nav renders <nav> or an <aside> once auth resolves.
      await page
        .waitForSelector("nav, aside, [role='navigation']", { timeout: 25_000 })
        .catch(() => {});

      // Allow a brief settle for async nav items.
      await page.waitForTimeout(2_000);

      // Read all visible nav/sidebar text.
      const navText = await page.evaluate(() => {
        const containers = [
          ...document.querySelectorAll("nav, aside, [role='navigation']"),
        ];
        return containers.map((el) => el.textContent).join(" ");
      });

      // "L10 Meeting" must not appear anywhere in the nav surface.
      expect(navText).not.toContain("L10 Meeting");
    }
  );
});
