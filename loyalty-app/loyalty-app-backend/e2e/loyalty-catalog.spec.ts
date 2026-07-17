/**
 * E2E: Rewards Catalog and Tiers section load correctly for a real member.
 *
 * Setup:  inserts a temporary Customer + OTP directly into the loyalty_app
 *         Postgres schema — no SMTP server is required.
 * Login:  navigates to the magic-link URL (/loyalty-app/login?email=…&code=…)
 *         which the SPA auto-verifies client-side and redirects to /dashboard.
 * Checks:
 *   1. All 5 seeded reward cards are visible in the Catalog tab on /rewards.
 *   2. All 4 tier names (Bronze, Silver, Gold, Platinum) appear in the Tiers
 *      section rendered on /rewards — this catches UI regressions where the
 *      tier ladder fails to render even when the API returns correct data.
 * Teardown: deletes the temporary OTP and Customer rows.
 *
 * Run:   npm run test:e2e  (from loyalty-app/loyalty-app-backend)
 * Requires: playwright install chromium  (one-time browser setup)
 */

import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_EMAIL = "pw-e2e-loyalty@vivo.test";
const TEST_CUSTOMER_ID = "pw-e2e-customer-001";
const REFERRAL_CODE = "PWTST001";

/**
 * Deterministic OTP code — 6 numeric digits, within the backend's 4–8 char
 * limit enforced by z.string().min(4).max(8) in src/routes/auth.ts.
 * OTP_LENGTH defaults to 6 (numeric); max attempts defaults to 5.
 */
const OTP_CODE = "123499";
const OTP_HASH = createHash("sha256").update(OTP_CODE).digest("hex");

const EXPECTED_REWARDS = [
  "KSh 200 off",
  "10% off",
  "Free shipping",
  "KSh 500 off",
  "20% off (VIP)",
] as const;

const EXPECTED_TIERS = ["Bronze", "Silver", "Gold", "Platinum"] as const;

// ── DB helper ─────────────────────────────────────────────────────────────────

function makePrisma(): PrismaClient {
  if (!process.env.LOYALTY_APP_DATABASE_URL && process.env.DATABASE_URL) {
    const base = process.env.DATABASE_URL;
    process.env.LOYALTY_APP_DATABASE_URL =
      base + (base.includes("?") ? "&" : "?") + "schema=loyalty_app";
  }
  return new PrismaClient();
}

async function insertFreshOtp(prisma: PrismaClient, otpId: string) {
  await prisma.otpCode.updateMany({
    where: { email: TEST_EMAIL, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.otpCode.upsert({
    where: { id: otpId },
    create: {
      id: otpId,
      email: TEST_EMAIL,
      codeHash: OTP_HASH,
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
    update: {
      // Always refresh codeHash so a stale row from a prior run can't
      // leave mismatched hash and cause spurious "That code is incorrect."
      codeHash: OTP_HASH,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      attempts: 0,
    },
  });
}

async function signIn(page: Page) {
  // Full path required: baseURL is origin-only (http://localhost:80), so
  // page.goto('/loyalty-app/login?...') resolves to the correct SPA route.
  const url = `/loyalty-app/login?email=${encodeURIComponent(TEST_EMAIL)}&code=${encodeURIComponent(OTP_CODE)}`;
  await page.goto(url);
  await page.waitForURL(/\/loyalty-app\/(dashboard|home)($|\?)/, { timeout: 20_000 });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();

  await prisma.customer.upsert({
    where: { id: TEST_CUSTOMER_ID },
    create: {
      id: TEST_CUSTOMER_ID,
      email: TEST_EMAIL,
      emailVerified: true,
      role: "CUSTOMER",
      pointsBalance: 0,
      lifetimePoints: 0,
      streakCount: 0,
      referralCode: REFERRAL_CODE,
    },
    update: {},
  });
});

test.afterAll(async () => {
  await prisma.otpCode.deleteMany({ where: { email: TEST_EMAIL } });
  await prisma.customer.deleteMany({ where: { email: TEST_EMAIL } });
  await prisma.$disconnect();
});

// Each test gets a fresh OTP so they can run independently.
test.beforeEach(async ({}, testInfo) => {
  await insertFreshOtp(prisma, `pw-e2e-otp-${testInfo.workerIndex}-${testInfo.retry}`);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test("Rewards Catalog: all 5 seeded reward cards are visible for an authenticated member", async ({
  page,
}) => {
  await signIn(page);

  await page.goto("/loyalty-app/rewards");
  await page.waitForLoadState("networkidle");

  // The "Catalog" tab is the default. Assert all 5 seeded reward titles are
  // rendered on the page. If the seed was not run, or the API is broken, this
  // will fail with an informative "Expected to find reward card: …" message.
  for (const title of EXPECTED_REWARDS) {
    await expect(
      page.getByText(title, { exact: true }),
      `Expected to find reward card: "${title}"`,
    ).toBeVisible();
  }
});

test("Tiers section: all 4 tier names are rendered in the UI on /rewards", async ({
  page,
}) => {
  await signIn(page);

  await page.goto("/loyalty-app/rewards");
  await page.waitForLoadState("networkidle");

  // The Tiers ladder is rendered above the catalog tabs (aria-label="Tiers").
  // Each tier cell has an aria-label matching the tier name, so this assertion
  // fails if the UI component is removed or the seeded tier data is missing.
  const tiersSection = page.getByRole("region", { name: "Tiers" });
  await expect(tiersSection, "Expected a Tiers section to be rendered on /rewards").toBeVisible();

  for (const name of EXPECTED_TIERS) {
    await expect(
      tiersSection.getByRole("generic", { name }),
      `Expected tier "${name}" to be visible in the Tiers section`,
    ).toBeVisible();
  }
});
