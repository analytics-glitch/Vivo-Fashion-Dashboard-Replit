import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import configPlugin from "./plugins/config.js";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import { env, isProd } from "./config/env.js";

import authRoutes from "./routes/auth.js";
import loyaltyRoutes from "./routes/loyalty.js";
import rewardsRoutes from "./routes/rewards.js";
import referralRoutes from "./routes/referrals.js";
import shopifyRoutes from "./routes/shopify.js";
import shopRoutes from "./routes/shop.js";
import adminRoutes from "./routes/admin.js";
import webhookRoutes from "./routes/webhooks.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProd
      ? true
      : { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } },
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1MB
  });

  // Core
  await app.register(configPlugin);
  await app.register(sensible);
  await app.register(prismaPlugin);
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  // CORS: reflect the request origin so the PWA works from any Replit preview
  // domain (worf / spock / replit.app) without requiring WEB_BASE_URL to be set.
  // When WEB_BASE_URL is set we scope to that origin only (production lockdown).
  await app.register(cors, {
    origin: env.WEB_BASE_URL ? [env.WEB_BASE_URL] : true,
    credentials: true,
  });
  await app.register(authPlugin);

  // Uniform error shape (esp. Zod validation errors).
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "Invalid request.",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const err = error as { statusCode?: number; name?: string; message?: string };
    if (err.statusCode) {
      return reply.status(err.statusCode).send({
        error: err.name,
        message: err.message,
      });
    }
    reply.log.error(error);
    return reply.status(500).send({ error: "InternalServerError", message: "Something went wrong." });
  });

  // Health check.
  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

  // Base-path health check (the shared proxy only routes /loyalty-app/*).
  app.get(`${env.BASE_PATH}/health`, async () => ({ status: "ok", ts: new Date().toISOString() }));

  // Exact base-path hit (no trailing slash): the Replit production orchestrator
  // probes GET /loyalty-app as the liveness check. Without this route Fastify
  // falls through to a 404/500 → orchestrator restarts the whole api-server
  // group → main API offline → 502 cascade for every surface.
  app.get(`${env.BASE_PATH}`, async () => ({ status: "ok", ts: new Date().toISOString() }));

  // API routes — served under the /loyalty-app base path behind the shared proxy.
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(loyaltyRoutes, { prefix: "/loyalty" });
      await api.register(rewardsRoutes, { prefix: "/rewards" });
      await api.register(referralRoutes, { prefix: "/referrals" });
      await api.register(shopifyRoutes, { prefix: "/shopify" });
      await api.register(shopRoutes, { prefix: "/shop" });
      await api.register(adminRoutes, { prefix: "/admin" });
    },
    { prefix: `${env.BASE_PATH}/api` },
  );

  // Webhooks (separate — raw body + no CORS/auth).
  await app.register(webhookRoutes, { prefix: `${env.BASE_PATH}/webhooks/shopify` });

  // Single-origin hosting: serve the built SPA and fall back to index.html
  // for client-side routes. API + webhooks are registered above, so they win.
  if (env.SERVE_FRONTEND) {
    const dist = resolve(process.cwd(), env.FRONTEND_DIST);
    if (!existsSync(resolve(dist, "index.html"))) {
      app.log.warn(
        `SERVE_FRONTEND is on but no build found at ${dist}. Run "npm run build" in the-loyalty-app.`,
      );
    }
    await app.register(fastifyStatic, {
      root: dist,
      prefix: `${env.BASE_PATH}/`,
      // wildcard:true serves files dynamically from disk at request time, so a
      // frontend rebuild (new chunk hashes) is picked up WITHOUT a backend
      // restart. wildcard:false globs once at startup → new chunks 404.
      wildcard: true,
      setHeaders: (res, path) => {
        // Never cache the SW script or the SPA shell → updates apply promptly.
        if (path.endsWith("sw.js") || path.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (path.includes("/assets/")) {
          // Content-hashed build assets are immutable.
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });

    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split("?")[0];
      // Real API/webhook 404s stay JSON.
      if (url.startsWith(`${env.BASE_PATH}/api`) || url.startsWith(`${env.BASE_PATH}/webhooks`)) {
        return reply.status(404).send({ error: "NotFound", message: "Route not found." });
      }
      // Missing static assets → real 404 (never serve HTML in place of JS/CSS,
      // which would break module parsing on a stale-chunk request).
      if (url.startsWith(`${env.BASE_PATH}/assets/`) || /\.[a-z0-9]+$/i.test(url)) {
        return reply.status(404).send({ error: "NotFound" });
      }
      // Client routes → SPA shell.
      return reply.sendFile("index.html");
    });
    app.log.info(`🖥️  Serving frontend from ${dist}`);
  }

  return app;
}
