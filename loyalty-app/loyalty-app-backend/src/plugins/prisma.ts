import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    dbReady: boolean;
  }
}

const CONNECT_ATTEMPTS = 3;
const CONNECT_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(prisma: PrismaClient, log: FastifyInstance["log"]): Promise<boolean> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      await prisma.$connect();
      return true;
    } catch (err) {
      const delay = CONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      if (attempt < CONNECT_ATTEMPTS) {
        log.warn(
          { err, attempt, nextRetryMs: delay },
          `prismaPlugin: DB connect failed (attempt ${attempt}/${CONNECT_ATTEMPTS}), retrying in ${delay}ms`,
        );
        await sleep(delay);
      } else {
        log.error(
          { err },
          `prismaPlugin: DB connect failed after ${CONNECT_ATTEMPTS} attempts — starting in degraded mode (DB-dependent routes will return 503)`,
        );
      }
    }
  }
  return false;
}

export default fp(async function prismaPlugin(app: FastifyInstance) {
  const prisma = new PrismaClient({
    log: app.config.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  const connected = await connectWithRetry(prisma, app.log);

  app.decorate("prisma", prisma);
  app.decorate("dbReady", connected);

  if (!connected) {
    const apiPrefix = `${app.config.BASE_PATH}/api`;
    app.addHook("onRequest", async (req, reply) => {
      const url = req.url.split("?")[0];
      if (url.startsWith(apiPrefix)) {
        return reply.status(503).send({
          error: "ServiceUnavailable",
          message: "Database is temporarily unreachable. Please try again shortly.",
        });
      }
    });
  }

  app.addHook("onClose", async (instance) => {
    await instance.prisma.$disconnect();
  });
});
