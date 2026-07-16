import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { verifyWebhookHmac } from "../lib/shopify.js";
import { awardPoints, spendPoints, pointsForOrder } from "../lib/loyalty.js";
import { findOrCreateCustomer } from "../lib/customers.js";

/**
 * Shopify webhooks. Registered with a raw-body parser so we can verify the
 * HMAC signature over the exact bytes Shopify sent.
 */
export default async function webhookRoutes(app: FastifyInstance) {
  // Capture the raw body for this plugin scope only.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      try {
        const raw = body as Buffer;
        (_req as any).rawBody = raw;
        done(null, raw.length ? JSON.parse(raw.toString("utf8")) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.addHook("preHandler", async (req, reply) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    const hmac = req.headers["x-shopify-hmac-sha256"] as string | undefined;
    if (!raw || !verifyWebhookHmac(raw, hmac)) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }
  });

  // Idempotency guard.
  async function alreadyProcessed(webhookId: string | undefined, topic: string) {
    if (!webhookId) return false;
    const existing = await app.prisma.processedWebhook.findUnique({ where: { webhookId } });
    if (existing) return true;
    await app.prisma.processedWebhook.create({ data: { webhookId, topic } });
    return false;
  }

  // orders/paid → award points, complete pending referral.
  app.post("/orders-paid", async (req, reply) => {
    const webhookId = req.headers["x-shopify-webhook-id"] as string | undefined;
    if (await alreadyProcessed(webhookId, "orders/paid")) return reply.send({ ok: true });

    const order = req.body as any;
    const email: string | undefined = order?.email || order?.customer?.email;
    if (!email) return reply.send({ ok: true, skipped: "no email" });

    const { customer } = await findOrCreateCustomer(app.prisma, {
      email,
      firstName: order?.customer?.first_name,
      lastName: order?.customer?.last_name,
    });

    // Don't double-award the same order.
    const dup = await app.prisma.pointsTransaction.findFirst({
      where: { shopifyOrderId: String(order.id), type: "EARN" },
    });
    if (dup) return reply.send({ ok: true, skipped: "already awarded" });

    const total = Number(order.total_price ?? order.current_total_price ?? 0);
    const tier = customer.tierId
      ? await app.prisma.tier.findUnique({ where: { id: customer.tierId } })
      : null;
    const points = pointsForOrder(total, tier?.multiplier ?? 1);

    if (points > 0) {
      try {
        await awardPoints(app.prisma, {
          customerId: customer.id,
          points,
          type: "EARN",
          description: `Order ${order.name ?? order.id}`,
          shopifyOrderId: String(order.id),
        });
      } catch (err: any) {
        // P2002 = unique constraint violation on the partial index
        // pts_txn_earn_order_unique — a concurrent delivery already awarded
        // points for this order; treat as idempotent success.
        if (err?.code === "P2002") {
          return reply.send({ ok: true, skipped: "already awarded (concurrent)" });
        }
        throw err;
      }
    }

    // Complete a pending referral (first qualifying order by the referee).
    await completeReferral(app, customer.id, customer.email);

    return reply.send({ ok: true, awarded: points });
  });

  // refunds/create or orders/cancelled → claw back proportional earned points.
  app.post("/refunds-create", async (req, reply) => {
    const webhookId = req.headers["x-shopify-webhook-id"] as string | undefined;
    if (await alreadyProcessed(webhookId, "refunds/create")) return reply.send({ ok: true });

    const refund = req.body as any;
    const orderId = String(refund.order_id);
    const earn = await app.prisma.pointsTransaction.findFirst({
      where: { shopifyOrderId: orderId, type: "EARN" },
      include: { customer: true },
    });
    if (!earn) return reply.send({ ok: true, skipped: "no earning" });

    const refundAmount = (refund.transactions ?? []).reduce(
      (sum: number, t: any) => sum + Number(t.amount ?? 0),
      0,
    );
    if (refundAmount <= 0) return reply.send({ ok: true });

    // Proportional claw-back capped at what was earned.
    const clawback = Math.min(earn.points, pointsForOrder(refundAmount, 1));
    if (clawback > 0) {
      await spendPoints(app.prisma, {
        customerId: earn.customerId,
        points: clawback,
        type: "REFUND",
        description: `Refund on order ${orderId}`,
        shopifyOrderId: orderId,
        allowNegative: true,
      });
    }
    return reply.send({ ok: true, clawedBack: clawback });
  });
}

async function completeReferral(app: FastifyInstance, refereeId: string, refereeEmail: string) {
  const referral = await app.prisma.referral.findFirst({
    where: {
      status: "PENDING",
      OR: [{ refereeId }, { refereeEmail: refereeEmail.toLowerCase() }],
    },
  });
  if (!referral) return;

  await app.prisma.referral.update({
    where: { id: referral.id },
    data: { status: "COMPLETED", completedAt: new Date(), refereeId },
  });

  if (env.REFERRAL_REFERRER_POINTS > 0) {
    await awardPoints(app.prisma, {
      customerId: referral.referrerId,
      points: env.REFERRAL_REFERRER_POINTS,
      type: "REFERRAL",
      description: "Referral reward — your friend made a purchase 🎉",
      referralId: referral.id,
    });
  }
}
