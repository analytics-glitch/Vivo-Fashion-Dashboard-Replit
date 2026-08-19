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
 *  5. Main BI opens only Main-owned folders, even with a forged folder_id=2 URL.
 *  6. Direct list, bootstrap, and ID-mutation requests cannot cross surfaces.
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

async function openMainL10(page, requestedFolder = 1) {
  const token = process.env.VIVO_E2E_TOKEN;
  if (!token)
    throw new Error("VIVO_E2E_TOKEN not set — check global-setup.js");

  await page.goto("/");
  await page.context().addCookies([
    { name: "session_token", value: token, url: page.url() },
  ]);
  await page.goto(`/l10?folder_id=${requestedFolder}`);
  await page.waitForSelector('[data-testid="l10-page"]', { timeout: 25_000 });
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

      // global-setup.js always seeds at least one meeting, so hasMeeting
      // must be true.  Fail loudly if the seed didn't take.
      expect(hasMeeting).toBe(true);

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

      // global-setup.js always seeds at least one meeting, so hasMeeting
      // must be true.  Fail loudly if the seed didn't take.
      expect(hasMeeting).toBe(true);

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

      // Sparkline: global-setup.js seeds 2 meetings each with a rating row,
      // which meets the ≥2-rated-meetings threshold.  Assert it is always
      // present so regressions in the sparkline path are caught immediately.
      await expect(page.locator("#l10-content")).toContainText(
        "Meeting Rating Trend"
      );
      await expect(page.locator("#l10-content svg")).toBeVisible();
    }
  );

  test(
    "Main BI ignores a forged folder_id=2 URL and never offers Supply Chain",
    async ({ page }) => {
      const requestedL10Urls = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/l10/")) {
          requestedL10Urls.push(request.url());
        }
      });

      await openMainL10(page, 2);

      await expect(page.getByTestId("l10-page")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Supply Chain", exact: true })
      ).toHaveCount(0);
      expect(
        requestedL10Urls.some((url) => /[?&]folder_id=2(?:&|$)/.test(url))
      ).toBe(false);
    }
  );

  test(
    "surface APIs preserve Fabric history and reject forged cross-surface reads and writes",
    async ({ page }) => {
      await openFabric(page);
      const result = await page.evaluate(async () => {
        const request = async (url, options) => {
          const response = await fetch(url, {
            credentials: "include",
            headers: {
              ...(window.localStorage.getItem("vivo_token")
                ? { Authorization: `Bearer ${window.localStorage.getItem("vivo_token")}` }
                : {}),
              ...(options?.body ? { "Content-Type": "application/json" } : {}),
            },
            ...options,
          });
          let data = null;
          try { data = await response.json(); } catch {}
          return { status: response.status, data };
        };

        const fabricMeetings = await request(
          "/api/fabric/l10/meetings?folder_id=2"
        );
        const fabricMembers = await request(
          "/api/fabric/l10/members?folder_id=2"
        );
        const fabricSettings = await request("/api/fabric/l10/settings");
        const mainFolders = await request("/api/l10/folders");
        const mainCrossList = await request(
          "/api/l10/meetings?folder_id=2"
        );
        const fabricCrossList = await request(
          "/api/fabric/l10/meetings?folder_id=1"
        );
        const supplyMeeting = fabricMeetings.data?.[0];
        const mainCrossMutation = supplyMeeting
          ? await request(`/api/l10/meetings/${supplyMeeting.id}`, {
              method: "PUT",
              body: JSON.stringify({ start_time: supplyMeeting.start_time || "08:00" }),
            })
          : { status: 0 };

        return {
          fabricMeetings,
          fabricMembers,
          fabricSettings,
          mainFolders,
          mainCrossList,
          fabricCrossList,
          mainCrossMutation,
        };
      });

      expect(result.fabricMeetings.status).toBe(200);
      expect(result.fabricMeetings.data.length).toBeGreaterThan(0);
      expect(result.fabricMeetings.data.every((meeting) => meeting.folder_id === 2)).toBe(true);
      expect(result.fabricMembers.status).toBe(200);
      expect(result.fabricSettings.status).toBe(200);
      expect(result.mainFolders.status).toBe(200);
      expect(result.mainFolders.data.some((folder) => folder.id === 2)).toBe(false);
      expect(result.mainCrossList.status).toBe(403);
      expect(result.fabricCrossList.status).toBe(403);
      expect(result.mainCrossMutation.status).toBe(403);
    }
  );
});
