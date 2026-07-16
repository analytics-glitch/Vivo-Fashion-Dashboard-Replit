import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { customAlphabet } from "nanoid";
import { spendPoints } from "../lib/loyalty.js";
import { createDiscountCode } from "../lib/shopify.js";
import { serializeCustomer } from "../lib/customers.js";

const codeSuffix = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

export default async function rewardsRoutes(app: FastifyInstance) {
  // Public catalogue (no auth needed to browse).
  app.get("/", async () => {
    const rewards = await app.prisma.reward.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { pointsCost: "asc" }],
    });
    return { rewards };
  });

  // Authenticated section.
  app.register(async (secured) => {
    secured.addHook("onRequest", secured.authenticate);

    // My redemptions.
    secured.get("/redemptions", async (req) => {
      const redemptions = await secured.prisma.redemption.findMany({
        where: { customerId: req.user.sub },
        orderBy: { createdAt: "desc" },
        include: { reward: true },
      });
      return { redemptions };
    });

    // Redeem a reward → generate a Shopify discount code.
    secured.post("/:rewardId/redeem", async (req, reply) => {
      const { rewardId } = z.object({ rewardId: z.string() }).parse(req.params);

      const reward = await secured.prisma.reward.findUnique({ where: { id: rewardId } });
      if (!reward || !reward.active) return reply.notFound("Reward not available.");

      const customer = await secured.prisma.customer.findUnique({ where: { id: req.user.sub } });
      if (!customer) return reply.unauthorized();

      if (customer.pointsBalance < reward.pointsCost) {
        return reply.badRequest("You don't have enough points for this reward yet.");
      }
      if (reward.stock !== null && reward.stock <= 0) {
        return reply.badRequest("This reward is out of stock.");
      }
      if (reward.minTierId && customer.tierId !== reward.minTierId) {
        // simple gate: exact tier or higher by lifetime points
        const minTier = await secured.prisma.tier.findUnique({ where: { id: reward.minTierId } });
        if (minTier && customer.lifetimePoints < minTier.minPoints) {
          return reply.badRequest(`This reward is for ${minTier.name} members and above.`);
        }
      }

      // Generate a unique discount code.
      const code = `VIVO-${codeSuffix()}`;
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 60); // 60 days

      let discount;
      try {
        discount = await createDiscountCode({
          code,
          type: reward.type,
          value: reward.value,
          customerEmail: customer.email,
          expiresAt,
        });
      } catch (err) {
        req.log.error({ err }, "Failed to create Shopify discount");
        return reply.internalServerError("Couldn't generate your reward code. Please try again.");
      }

      // Persist redemption + spend points atomically-ish.
      const redemption = await secured.prisma.redemption.create({
        data: {
          customerId: customer.id,
          rewardId: reward.id,
          pointsSpent: reward.pointsCost,
          discountCode: discount.code,
          shopifyPriceRuleId: discount.priceRuleId,
          shopifyDiscountId: discount.discountId,
          expiresAt,
          status: "ISSUED",
        },
      });

      if (reward.stock !== null) {
        await secured.prisma.reward.update({
          where: { id: reward.id },
          data: { stock: { decrement: 1 } },
        });
      }

      const updated = await spendPoints(secured.prisma, {
        customerId: customer.id,
        points: reward.pointsCost,
        type: "REDEEM",
        description: `Redeemed: ${reward.title}`,
        redemptionId: redemption.id,
      });

      return {
        redemption: { ...redemption, reward },
        user: await serializeCustomer(secured.prisma, updated),
      };
    });
  });
}
