import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
}
