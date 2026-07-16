import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { awardPoints } from "../lib/loyalty.js";
import { serializeCustomer } from "../lib/customers.js";

export default async function loyaltyRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // Full profile + tier progress.
  app.get("/profile", async (req, reply) => {
    const customer = await app.prisma.customer.findUnique({ where: { id: req.user.sub } });
    if (!customer) return reply.unauthorized();
    return { user: await serializeCustomer(app.prisma, customer) };
  });

  // Update editable profile fields.
  app.patch("/profile", async (req, reply) => {
    const body = z
      .object({
        firstName: z.string().max(80).optional(),
        lastName: z.string().max(80).optional(),
        phone: z.string().max(40).optional(),
        birthday: z.string().datetime().optional().or(z.string().date().optional()),
      })
      .parse(req.body);

    const customer = await app.prisma.customer.update({
      where: { id: req.user.sub },
      data: {
        ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
        ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.birthday !== undefined ? { birthday: new Date(body.birthday) } : {}),
      },
    });
    return { user: await serializeCustomer(app.prisma, customer) };
  });

  // Points ledger (paginated).
  app.get("/points/history", async (req, reply) => {
    const q = z
      .object({ cursor: z.string().optional(), limit: z.coerce.number().min(1).max(50).default(20) })
      .parse(req.query);

    const items = await app.prisma.pointsTransaction.findMany({
      where: { customerId: req.user.sub },
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > q.limit;
    const page = hasMore ? items.slice(0, q.limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    };
  });

  // Claim the birthday bonus (once per calendar year, on/after birthday).
  app.post("/bonus/birthday", async (req, reply) => {
    const customer = await app.prisma.customer.findUnique({ where: { id: req.user.sub } });
    if (!customer) return reply.unauthorized();
    if (!customer.birthday) return reply.badRequest("Add your birthday to your profile first.");

    const now = new Date();
    const year = now.getFullYear();
    if (customer.lastBirthdayGrant === year) {
      return reply.badRequest("You've already claimed this year's birthday bonus.");
    }
    const bday = new Date(customer.birthday);
    const isBirthdayWindow =
      now.getMonth() === bday.getMonth() && Math.abs(now.getDate() - bday.getDate()) <= 7;
    if (!isBirthdayWindow) {
      return reply.badRequest("Your birthday bonus unlocks during your birthday week.");
    }

    await app.prisma.customer.update({
      where: { id: customer.id },
      data: { lastBirthdayGrant: year },
    });
    const updated = await awardPoints(app.prisma, {
      customerId: customer.id,
      points: env.BIRTHDAY_BONUS_POINTS,
      type: "BIRTHDAY",
      description: "🎂 Happy birthday bonus",
    });
    return { user: await serializeCustomer(app.prisma, updated), awarded: env.BIRTHDAY_BONUS_POINTS };
  });
}
