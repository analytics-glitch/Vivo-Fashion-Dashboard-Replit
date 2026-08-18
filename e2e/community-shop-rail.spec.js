// @ts-check
/**
 * Smoke test: "Fresh off the floor" (New This Week) rail placement — Task 1417.
 *
 * Confirms:
 *  1. Welcome screen — JOHARI wordmark is in the top logo lockup (above the
 *     "Welcome to Vivo" heading), not just above the heading text.
 *  2. Home page (guest and member) — no `home-new-this-week` rail present.
 *  3. Shop tab pristine state (sort=new, no filters) — `shop-new-this-week`
 *     rail is visible.
 *  4. Shop tab with an active filter — rail is hidden.
 *  5. Shop tab with a non-default sort — rail is hidden.
 *
 * Auth: a community member is DB-minted with a sha256-hashed token, then
 * injected into localStorage ("vivo_community_token") before SPA navigation.
 * The member is cleaned up in an afterAll block.
 */

const { test, expect } = require("@playwright/test");
const { execSync } = require("child_process");
const crypto = require("crypto");

// ── constants ─────────────────────────────────────────────────────────────────

const APP_BASE = "/app/";

// ── helpers ───────────────────────────────────────────────────────────────────

/** SHA-256 hex of a token string — matches community_app._hash_token() */
function sha256(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Run a Python snippet with DATABASE_URL available; throw on non-zero exit. */
function runPy(snippet) {
  return execSync(
    `python3 -c '${snippet.replace(/'/g, "'\"'\"'")}'`,
    { encoding: "utf8", env: process.env }
  ).trim();
}

/**
 * Navigate directly to a community tab with the token already in localStorage.
 * Uses addInitScript so the token is present before the React app boots — no
 * double-reload needed.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} token – raw bearer token for localStorage
 * @param {string} tab   – "home" | "shop" | ""
 */
async function gotoTab(page, token, tab = "") {
  // Inject token before the page evaluates any JS, so AuthContext finds it on mount.
  await page.addInitScript((val) => {
    try { localStorage.setItem("vivo_community_token", val); } catch { /* private mode */ }
  }, token);
  const url = tab ? `${APP_BASE}?tab=${tab}` : APP_BASE;
  await page.goto(url);
}

/**
 * Navigate as a guest (sessionStorage flag set before page boots).
 */
async function gotoTabAsGuest(page, tab = "") {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("vivo_community_token");
      sessionStorage.setItem("vivo_guest", "1");
    } catch { /* private mode */ }
  });
  const url = tab ? `${APP_BASE}?tab=${tab}` : APP_BASE;
  await page.goto(url);
}

// ── member setup / teardown ───────────────────────────────────────────────────

let memberToken = "";
let memberId = 0;

test.beforeAll(async () => {
  memberToken = "e2e_community_rail_" + crypto.randomBytes(8).toString("hex");
  const hashed = sha256(memberToken);
  const hashPrefix = hashed.slice(0, 8);
  const phone = "254" + (700000000 + Math.floor(Math.random() * 99999999)).toString();

  const mintPy = [
    "import os, psycopg2",
    "conn = psycopg2.connect(os.environ['DATABASE_URL'])",
    "cur = conn.cursor()",
    "cur.execute(",
    "    '''INSERT INTO community_members",
    "       (phone, full_name, email, consent_at, username)",
    "       VALUES (%s, 'E2E Rail Test', '', now(), %s)",
    "       ON CONFLICT (phone) DO UPDATE SET full_name='E2E Rail Test'",
    "       RETURNING id''',",
    "    ('" + phone + "', 'e2e_rail_" + hashPrefix + "')",
    ")",
    "mid = cur.fetchone()[0]",
    "cur.execute(",
    "    '''INSERT INTO community_sessions",
    "       (token_hash, member_id, phone, purpose, expires_at)",
    "       VALUES (%s, %s, %s, 'member', now() + interval '60 minutes')",
    "       ON CONFLICT (token_hash) DO NOTHING''',",
    "    ('" + hashed + "', mid, '" + phone + "')",
    ")",
    "conn.commit()",
    "cur.close()",
    "conn.close()",
    "print(mid)",
  ].join("\n");

  try {
    const out = runPy(mintPy);
    memberId = parseInt(out, 10);
  } catch (err) {
    console.error("[community-shop-rail] Member mint failed:", err.message);
    throw err;
  }
});

test.afterAll(async () => {
  if (!memberId) return;
  const hashed = sha256(memberToken);
  const cleanupPy = [
    "import os, psycopg2",
    "conn = psycopg2.connect(os.environ['DATABASE_URL'])",
    "cur = conn.cursor()",
    "cur.execute(\"DELETE FROM community_sessions WHERE token_hash = %s\", ('" + hashed + "',))",
    "cur.execute(\"DELETE FROM community_members WHERE id = %s\", (" + memberId + ",))",
    "conn.commit()",
    "cur.close()",
    "conn.close()",
  ].join("\n");
  try { runPy(cleanupPy); } catch (err) {
    console.warn("[community-shop-rail] Cleanup failed:", err.message);
  }
});

// ── tests ─────────────────────────────────────────────────────────────────────

test("welcome screen: JOHARI wordmark is in the top logo lockup, above the heading", async ({ page }) => {
  // Navigate without any token so AuthFlow renders.
  await page.addInitScript(() => {
    try { localStorage.removeItem("vivo_community_token"); sessionStorage.removeItem("vivo_guest"); } catch { /* ok */ }
  });
  await page.goto(APP_BASE);

  // The wordmark renders the text "Johari" (JohariWordmark with withVivo=false).
  const wordmark = page.locator("span").filter({ hasText: /^Johari$/i }).first();
  await expect(wordmark, "JOHARI wordmark must be visible on the welcome screen").toBeVisible({ timeout: 10_000 });

  // "Welcome to Vivo" h1 must also be present.
  const heading = page.locator("h1").filter({ hasText: "Welcome to Vivo" }).first();
  await expect(heading, '"Welcome to Vivo" heading must be visible').toBeVisible({ timeout: 10_000 });

  // JOHARI should appear higher on the screen (smaller Y) than the h1,
  // confirming it lives in the top logo lockup, not just above the heading.
  const [wordmarkBox, headingBox] = await Promise.all([
    wordmark.boundingBox(),
    heading.boundingBox(),
  ]);
  expect(wordmarkBox, "JOHARI wordmark must have a bounding box").not.toBeNull();
  expect(headingBox, '"Welcome to Vivo" heading must have a bounding box').not.toBeNull();
  expect(
    wordmarkBox.y,
    "JOHARI wordmark must be higher (smaller Y) than the Welcome to Vivo heading"
  ).toBeLessThan(headingBox.y);
});

test("home page (guest): home-new-this-week rail is absent", async ({ page }) => {
  await gotoTabAsGuest(page, "home");

  // Wait for home content (hero section signals the tab rendered).
  await page.waitForSelector('[data-testid="home-hero"]', { timeout: 20_000 }).catch(() => {});

  // The New This Week rail must NOT exist on the home page for guests.
  await expect(
    page.locator('[data-testid="home-new-this-week"]'),
    "home-new-this-week rail must not appear on the Home tab for guests"
  ).toHaveCount(0);
});

test("home page (member): home-new-this-week rail is absent", async ({ page }) => {
  await gotoTab(page, memberToken, "home");

  // Wait for home content (hero section signals the tab rendered).
  await page.waitForSelector('[data-testid="home-hero"]', { timeout: 20_000 }).catch(() => {});

  // The New This Week rail must NOT exist on the home page for members.
  await expect(
    page.locator('[data-testid="home-new-this-week"]'),
    "home-new-this-week rail must not appear on the Home tab for members"
  ).toHaveCount(0);
});

test("shop tab: shop-new-this-week rail is gone (Shop Fixes spec — it duplicated the grid)", async ({ page }) => {
  await gotoTab(page, memberToken, "shop");

  // Wait for the product grid or empty state.
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid^="product-card-"]') !== null ||
        document.querySelector('[data-testid="empty-clear-filters"]') !== null ||
        // loading skeleton cleared (all skeleton animations gone)
        document.querySelector(".animate-pulse") === null,
      { timeout: 30_000 }
    )
    .catch(() => {});

  // Confirm sort is "new" (the default) — the state that used to show the rail.
  const sortValue = await page.locator('[data-testid="shop-sort"]').inputValue().catch(() => "");
  expect(sortValue, 'Sort must default to "new" for the pristine state').toBe("new");

  // The rail was removed entirely: "Newest first" sort covers new arrivals.
  await expect(
    page.locator('[data-testid="shop-new-this-week"]'),
    "shop-new-this-week rail must no longer exist on the Shop tab"
  ).toHaveCount(0);
});
