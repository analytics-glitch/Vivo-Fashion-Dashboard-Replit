import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { env } from "../config/env.js";

// The build marker of the currently-deployed frontend (manifest hash in
// index.html) — used to tell whether a user's app is up to date.
function currentBuildMarker(): string | null {
  try {
    const html = readFileSync(resolve(process.cwd(), env.FRONTEND_DIST, "index.html"), "utf8");
    return html.match(/manifest-([^.]+)\.js/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // "currently active" = seen in last 5 min

const RewardBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  pointsCost: z.number().int().min(1),
  type: z.enum(["PERCENT_DISCOUNT", "FIXED_DISCOUNT", "FREE_SHIPPING", "FREE_PRODUCT"]),
  value: z.number().min(0),
  imageUrl: z.string().url().nullable().optional(),
  stock: z.number().int().min(0).nullable().optional(),
  minTierId: z.string().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

const RewardPatchSchema = RewardBodySchema.partial();

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requireAdmin);

  app.get("/overview", async () => {
    const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS);
    const build = currentBuildMarker();

    const [totalSignups, activeNow, installedCount, loginsAgg, customers] = await Promise.all([
      app.prisma.customer.count(),
      app.prisma.customer.count({ where: { lastSeenAt: { gte: activeSince } } }),
      app.prisma.customer.count({ where: { pwaInstalled: true } }),
      app.prisma.customer.aggregate({ _sum: { loginCount: true } }),
      app.prisma.customer.findMany({
        orderBy: [{ lastLoginAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: 500,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          loginCount: true,
          lastLoginAt: true,
          lastSeenAt: true,
          createdAt: true,
          pwaInstalled: true,
          appVersion: true,
        },
      }),
    ]);

    const users = customers.map((c) => ({
      ...c,
      online: c.lastSeenAt ? c.lastSeenAt >= activeSince : false,
      // true = latest, false = old, null = unknown (never reported)
      appUpToDate: c.appVersion && build ? c.appVersion === build : null,
    }));

    return {
      build,
      activeWindowMinutes: ACTIVE_WINDOW_MS / 60000,
      stats: {
        totalSignups,
        activeNow,
        installedCount,
        totalLogins: loginsAgg._sum.loginCount ?? 0,
      },
      users,
    };
  });

  // ── Rewards management ────────────────────────────────────────────────────

  // List all rewards (including inactive).
  app.get("/rewards", async () => {
    const rewards = await app.prisma.reward.findMany({
      orderBy: [{ sortOrder: "asc" }, { pointsCost: "asc" }],
    });
    return { rewards };
  });

  // Create a new reward.
  app.post("/rewards", async (req, reply) => {
    const body = RewardBodySchema.parse(req.body);
    const reward = await app.prisma.reward.create({
      data: {
        title: body.title,
        description: body.description,
        pointsCost: body.pointsCost,
        type: body.type,
        value: body.value,
        imageUrl: body.imageUrl ?? null,
        stock: body.stock ?? null,
        minTierId: body.minTierId ?? null,
        sortOrder: body.sortOrder ?? 0,
        active: body.active ?? true,
      },
    });
    return reply.status(201).send({ reward });
  });

  // Update an existing reward (partial — any subset of fields).
  app.patch("/rewards/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = RewardPatchSchema.parse(req.body);

    const existing = await app.prisma.reward.findUnique({ where: { id } });
    if (!existing) return reply.notFound("Reward not found.");

    const reward = await app.prisma.reward.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.pointsCost !== undefined && { pointsCost: body.pointsCost }),
        ...(body.type !== undefined && { type: body.type }),
        ...(body.value !== undefined && { value: body.value }),
        ...("imageUrl" in body && { imageUrl: body.imageUrl ?? null }),
        ...("stock" in body && { stock: body.stock ?? null }),
        ...("minTierId" in body && { minTierId: body.minTierId ?? null }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.active !== undefined && { active: body.active }),
      },
    });
    return { reward };
  });

  // Delete a reward (only if it has no redemptions attached).
  app.delete("/rewards/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const existing = await app.prisma.reward.findUnique({
      where: { id },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!existing) return reply.notFound("Reward not found.");

    if (existing._count.redemptions > 0) {
      return reply.badRequest(
        "This reward has existing redemptions and cannot be deleted. Disable it instead.",
      );
    }

    await app.prisma.reward.delete({ where: { id } });
    return { ok: true };
  });
}
