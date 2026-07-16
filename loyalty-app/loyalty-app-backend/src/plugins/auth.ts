import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SessionUser {
  sub: string; // customer id
  email: string;
  role: "CUSTOMER" | "ADMIN";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    setSession: (reply: FastifyReply, user: SessionUser) => void;
    clearSession: (reply: FastifyReply) => void;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  const { config } = app;

  await app.register(fastifyCookie);

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    cookie: {
      cookieName: config.SESSION_COOKIE,
      signed: false,
    },
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });

  app.decorate("setSession", (reply: FastifyReply, user: SessionUser) => {
    const token = app.jwt.sign(user);
    const maxAge = 60 * 60 * 24 * 30; // 30 days
    reply.setCookie(config.SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: "lax",
      path: config.BASE_PATH || "/",
      maxAge,
    });
  });

  app.decorate("clearSession", (reply: FastifyReply) => {
    reply.clearCookie(config.SESSION_COOKIE, { path: config.BASE_PATH || "/" });
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.unauthorized("You must be signed in.");
    }
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.unauthorized("You must be signed in.");
    }
    if (req.user.role !== "ADMIN") {
      return reply.forbidden("Admin access required.");
    }
  });
});
