import type { FastifyInstance } from "fastify";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { env, googleEnabled } from "../config/env.js";
import { createOtp, verifyOtp } from "../lib/otp.js";
import { sendMail, otpEmail } from "../lib/email.js";
import { findOrCreateCustomer, serializeCustomer, recordLogin } from "../lib/customers.js";
import type { SessionUser } from "../plugins/auth.js";

const googleClient = new OAuth2Client(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI,
);

// Encode small bits of state (referral code, return path) through OAuth.
function encodeState(obj: Record<string, string | undefined>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function decodeState(state?: string): Record<string, string> {
  try {
    return state ? JSON.parse(Buffer.from(state, "base64url").toString()) : {};
  } catch {
    return {};
  }
}

export default async function authRoutes(app: FastifyInstance) {
  // ── Current user ───────────────────────────────────────────
  app.get("/me", { onRequest: [app.authenticate] }, async (req, reply) => {
    const customer = await app.prisma.customer.findUnique({ where: { id: req.user.sub } });
    if (!customer) {
      app.clearSession(reply);
      return reply.unauthorized("Session no longer valid.");
    }
    return { user: await serializeCustomer(app.prisma, customer) };
  });

  app.post("/logout", async (_req, reply) => {
    app.clearSession(reply);
    return { ok: true };
  });

  // Client heartbeat → powers "currently active" + install/version telemetry.
  app.post("/heartbeat", { onRequest: [app.authenticate] }, async (req) => {
    const body = z
      .object({ installed: z.boolean().optional(), version: z.string().max(64).optional() })
      .parse(req.body ?? {});
    await app.prisma.customer
      .update({
        where: { id: req.user.sub },
        data: {
          lastSeenAt: new Date(),
          ...(body.installed !== undefined ? { pwaInstalled: body.installed } : {}),
          ...(body.version ? { appVersion: body.version } : {}),
        },
      })
      .catch(() => {});
    return { ok: true };
  });

  app.get("/status", async () => ({
    google: googleEnabled,
    otp: true,
  }));

  // ── Google OAuth (redirect flow) ───────────────────────────
  app.get("/google", async (req, reply) => {
    if (!googleEnabled) return reply.notImplemented("Google sign-in is not configured.");
    const q = req.query as Record<string, string>;
    const url = googleClient.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state: encodeState({ ref: q.ref, next: q.next }),
      prompt: "select_account",
    });
    return reply.redirect(url);
  });

  app.get("/google/callback", async (req, reply) => {
    if (!googleEnabled) return reply.notImplemented("Google sign-in is not configured.");
    const q = req.query as Record<string, string>;
    if (q.error || !q.code) {
      return reply.redirect(`${env.WEB_BASE_URL}${env.BASE_PATH}/login?error=google`);
    }
    const state = decodeState(q.state);

    try {
      const { tokens } = await googleClient.getToken(q.code);
      const ticket = await googleClient.verifyIdToken({
        idToken: tokens.id_token!,
        audience: env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error("No email from Google");

      const { customer } = await findOrCreateCustomer(app.prisma, {
        email: payload.email,
        firstName: payload.given_name,
        lastName: payload.family_name,
        avatarUrl: payload.picture,
        googleId: payload.sub,
        emailVerified: payload.email_verified ?? true,
        referralCodeUsed: state.ref,
      });

      app.setSession(reply, sessionOf(customer));
      await recordLogin(app.prisma, customer.id);
      const next = state.next && state.next.startsWith("/") ? state.next : "/dashboard";
      return reply.redirect(`${env.WEB_BASE_URL}${env.BASE_PATH}${next}`);
    } catch (err) {
      req.log.error({ err }, "Google OAuth failed");
      return reply.redirect(`${env.WEB_BASE_URL}${env.BASE_PATH}/login?error=google`);
    }
  });

  // ── Google One-Tap / ID token (SPA-side sign-in) ───────────
  app.post("/google/token", async (req, reply) => {
    if (!googleEnabled) return reply.notImplemented("Google sign-in is not configured.");
    const body = z
      .object({ credential: z.string(), referralCode: z.string().optional() })
      .parse(req.body);
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: body.credential,
        audience: env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error("No email");
      const { customer } = await findOrCreateCustomer(app.prisma, {
        email: payload.email,
        firstName: payload.given_name,
        lastName: payload.family_name,
        avatarUrl: payload.picture,
        googleId: payload.sub,
        emailVerified: true,
        referralCodeUsed: body.referralCode,
      });
      app.setSession(reply, sessionOf(customer));
      await recordLogin(app.prisma, customer.id);
      return { user: await serializeCustomer(app.prisma, customer) };
    } catch (err) {
      req.log.error({ err }, "Google token verify failed");
      return reply.unauthorized("Invalid Google credential.");
    }
  });

  // ── Email OTP ──────────────────────────────────────────────
  app.post(
    "/otp/request",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = z
        .object({ email: z.string().email(), referralCode: z.string().optional() })
        .parse(req.body);
      const normalized = body.email.toLowerCase().trim();
      const { code } = await createOtp(app.prisma, normalized);
      // One-tap magic link → opens the SPA which auto-verifies (client POST,
      // so email link-scanners doing a GET can't consume the single-use code).
      const magicLink = `${env.WEB_BASE_URL}${env.BASE_PATH}/login?email=${encodeURIComponent(
        normalized,
      )}&code=${code}${body.referralCode ? `&ref=${encodeURIComponent(body.referralCode)}` : ""}`;
      await sendMail({
        to: normalized,
        subject: `Your Vivo Loyalty sign-in code: ${code}`,
        html: otpEmail(code, env.OTP_TTL_MINUTES, magicLink),
        text: `Your Vivo Loyalty sign-in code is ${code}. It expires in ${env.OTP_TTL_MINUTES} minutes. Or sign in instantly: ${magicLink}`,
      });
      return { ok: true, ttlMinutes: env.OTP_TTL_MINUTES };
    },
  );

  app.post(
    "/otp/verify",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const body = z
        .object({
          email: z.string().email(),
          code: z.string().min(4).max(8),
          referralCode: z.string().optional(),
        })
        .parse(req.body);
      const normalized = body.email.toLowerCase().trim();

      const result = await verifyOtp(app.prisma, normalized, body.code);
      if (!result.ok) {
        const messages: Record<string, string> = {
          expired: "That code has expired. Request a new one.",
          not_found: "No active code. Request a new one.",
          too_many_attempts: "Too many attempts. Request a new code.",
          mismatch: "That code is incorrect.",
        };
        return reply.badRequest(messages[result.reason]);
      }

      const { customer } = await findOrCreateCustomer(app.prisma, {
        email: normalized,
        emailVerified: true,
        referralCodeUsed: body.referralCode,
      });
      app.setSession(reply, sessionOf(customer));
      await recordLogin(app.prisma, customer.id);
      return { user: await serializeCustomer(app.prisma, customer) };
    },
  );
}

function sessionOf(c: { id: string; email: string; role: "CUSTOMER" | "ADMIN" }): SessionUser {
  return { sub: c.id, email: c.email, role: c.role };
}
