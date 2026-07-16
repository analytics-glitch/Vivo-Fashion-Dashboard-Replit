import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env, type Env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Env;
  }
}

export default fp(async function configPlugin(app: FastifyInstance) {
  app.decorate("config", env);
});
