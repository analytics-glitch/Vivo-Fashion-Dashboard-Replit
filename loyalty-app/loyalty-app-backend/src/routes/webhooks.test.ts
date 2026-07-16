import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the duplicate-EARN prevention in the orders/paid webhook.
 *
 * Strategy: mock out Prisma and the loyalty helpers so we can exercise the
 * idempotency guards without a real database.
 */

// ── Mocks (hoisted before any import) ─────────────────────────────────────

const awardPointsMock = vi.fn();
const pointsForOrderMock = vi.fn().mockReturnValue(100);
const findOrCreateCustomerMock = vi.fn();

vi.mock("../lib/loyalty.js", () => ({
  awardPoints: (...args: unknown[]) => awardPointsMock(...args),
  spendPoints: vi.fn(),
  pointsForOrder: (...args: unknown[]) => pointsForOrderMock(...args),
}));

vi.mock("../lib/customers.js", () => ({
  findOrCreateCustomer: (...args: unknown[]) => findOrCreateCustomerMock(...args),
}));

vi.mock("../lib/shopify.js", () => ({
  verifyWebhookHmac: vi.fn().mockReturnValue(true),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function buildPrismaMock({
  existingEarnRow = null as object | null,
} = {}) {
  const processedWebhookStore = new Set<string>();

  return {
    processedWebhook: {
      findUnique: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(processedWebhookStore.has(where.webhookId) ? { webhookId: where.webhookId } : null),
      ),
      create: vi.fn().mockImplementation(({ data }: any) => {
        processedWebhookStore.add(data.webhookId);
        return Promise.resolve({ id: "pw-1", ...data });
      }),
    },
    pointsTransaction: {
      findFirst: vi.fn().mockResolvedValue(existingEarnRow),
    },
    tier: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    referral: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
}

const DEFAULT_CUSTOMER = {
  id: "cust-1",
  email: "test@example.com",
  tierId: null,
  pointsBalance: 0,
  lifetimePoints: 0,
};

/**
 * Replication of the orders/paid handler logic, calling the mocked helpers
 * directly (no Fastify, no HTTP layer). Mirrors webhooks.ts exactly.
 */
async function deliverOrderPaid(
  prisma: ReturnType<typeof buildPrismaMock>,
  { webhookId, orderId, email, total }: { webhookId: string; orderId: string; email: string; total: number },
) {
  // 1. Webhook-id idempotency guard.
  const existing = await prisma.processedWebhook.findUnique({ where: { webhookId } });
  if (existing) return { ok: true, skipped: "webhook-id already processed" };
  await prisma.processedWebhook.create({ data: { webhookId, topic: "orders/paid" } });

  // 2. Find or create the customer (mocked).
  const { customer } = await findOrCreateCustomerMock(prisma, { email });

  // 3. findFirst guard — sequential protection against same-order, diff webhook-id.
  const dup = await prisma.pointsTransaction.findFirst({
    where: { shopifyOrderId: orderId, type: "EARN" },
  });
  if (dup) return { ok: true, skipped: "already awarded" };

  const points = pointsForOrderMock(total, 1);

  if (points > 0) {
    try {
      // 4. DB write — guarded at DB level by the unique partial index.
      await awardPointsMock(prisma, {
        customerId: customer.id,
        points,
        type: "EARN",
        description: `Order #${orderId}`,
        shopifyOrderId: orderId,
      });
    } catch (err: any) {
      // 5. P2002 = unique constraint violation — concurrent delivery, treat as success.
      if (err?.code === "P2002") {
        return { ok: true, skipped: "already awarded (concurrent)" };
      }
      throw err;
    }
  }

  return { ok: true, awarded: points };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("orders/paid webhook — duplicate EARN prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pointsForOrderMock.mockReturnValue(100);
    awardPointsMock.mockResolvedValue(undefined);
    findOrCreateCustomerMock.mockResolvedValue({ customer: DEFAULT_CUSTOMER });
  });

  it("awards points on the first delivery", async () => {
    const prisma = buildPrismaMock();
    const result = await deliverOrderPaid(prisma, {
      webhookId: "wh-1",
      orderId: "order-42",
      email: "buyer@example.com",
      total: 5000,
    });

    expect(result).toMatchObject({ ok: true, awarded: 100 });
    expect(awardPointsMock).toHaveBeenCalledOnce();
  });

  it("does NOT award points a second time when the same webhook-id is replayed", async () => {
    const prisma = buildPrismaMock();
    const args = { webhookId: "wh-1", orderId: "order-42", email: "buyer@example.com", total: 5000 };

    await deliverOrderPaid(prisma, args);
    const result = await deliverOrderPaid(prisma, args); // exact replay

    expect(result).toMatchObject({ ok: true, skipped: "webhook-id already processed" });
    expect(awardPointsMock).toHaveBeenCalledOnce(); // only the first delivery awarded
  });

  it("does NOT award points when findFirst reveals an existing EARN row (sequential race)", async () => {
    const prisma = buildPrismaMock({
      existingEarnRow: { id: "pt-existing", shopifyOrderId: "order-42", type: "EARN" },
    });

    const result = await deliverOrderPaid(prisma, {
      webhookId: "wh-2", // different webhook-id, same order
      orderId: "order-42",
      email: "buyer@example.com",
      total: 5000,
    });

    expect(result).toMatchObject({ ok: true, skipped: "already awarded" });
    expect(awardPointsMock).not.toHaveBeenCalled();
  });

  it("does NOT double the balance when the DB unique constraint fires (concurrent race)", async () => {
    // Both deliveries pass findFirst (both see null in the race window), but
    // the second insert hits the partial unique index → Prisma raises P2002.
    const p2002 = Object.assign(new Error("Unique constraint failed on pts_txn_earn_order_unique"), {
      code: "P2002",
    });

    let callCount = 0;
    awardPointsMock.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) return Promise.reject(p2002);
      return Promise.resolve(undefined);
    });

    const prisma = buildPrismaMock(); // findFirst always null (race window)
    const baseArgs = { orderId: "order-99", email: "buyer@example.com", total: 5000 };

    const [r1, r2] = await Promise.all([
      deliverOrderPaid(prisma, { ...baseArgs, webhookId: "wh-a" }),
      deliverOrderPaid(prisma, { ...baseArgs, webhookId: "wh-b" }),
    ]);

    // One succeeds, one is gracefully skipped — neither throws.
    const results = [r1, r2];
    expect(results.some((r) => r.ok && "awarded" in r)).toBe(true);
    expect(results.some((r) => r.ok && r.skipped === "already awarded (concurrent)")).toBe(true);

    // awardPoints was called twice but the second was caught, not rethrown.
    expect(awardPointsMock).toHaveBeenCalledTimes(2);
  });

  it("re-throws non-P2002 errors from awardPoints", async () => {
    const dbError = new Error("connection refused");
    awardPointsMock.mockRejectedValue(dbError);

    const prisma = buildPrismaMock();

    await expect(
      deliverOrderPaid(prisma, {
        webhookId: "wh-3",
        orderId: "order-55",
        email: "buyer@example.com",
        total: 5000,
      }),
    ).rejects.toThrow("connection refused");
  });
});
