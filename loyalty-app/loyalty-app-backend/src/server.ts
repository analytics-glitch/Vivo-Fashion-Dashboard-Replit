import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`🚀 Vivo Loyalty API on ${env.API_BASE_URL}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received — shutting down`);
    await app.close();
    process.exit(0);
  });
}
