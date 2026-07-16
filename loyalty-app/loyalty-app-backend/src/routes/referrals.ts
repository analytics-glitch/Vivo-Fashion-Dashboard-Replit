import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { sendMail } from "../lib/email.js";

export default async function referralRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // My referral overview.
  app.get("/", async (req) => {
    const customer = await app.prisma.customer.findUniqueOrThrow({ where: { id: req.user.sub } });
    const referrals = await app.prisma.referral.findMany({
      where: { referrerId: customer.id },
      orderBy: { createdAt: "desc" },
    });
    const completed = referrals.filter((r) => r.status === "COMPLETED").length;

    const link = `${env.WEB_BASE_URL}${env.BASE_PATH}/login?ref=${customer.referralCode}`;
    return {
      referralCode: customer.referralCode,
      shareUrl: link,
      rewardPoints: env.REFERRAL_REFERRER_POINTS,
      friendPoints: env.REFERRAL_REFEREE_POINTS,
      stats: {
        invited: referrals.length,
        completed,
        pointsEarned: completed * env.REFERRAL_REFERRER_POINTS,
      },
      referrals,
    };
  });

  // Invite a friend by email.
  app.post("/invite", async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const refereeEmail = email.toLowerCase().trim();

    const customer = await app.prisma.customer.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (refereeEmail === customer.email) {
      return reply.badRequest("You can't refer yourself 🙂");
    }
    const existing = await app.prisma.customer.findUnique({ where: { email: refereeEmail } });
    if (existing) return reply.badRequest("That person is already a member.");

    await app.prisma.referral.upsert({
      where: { referrerId_refereeEmail: { referrerId: customer.id, refereeEmail } },
      update: {},
      create: { referrerId: customer.id, refereeEmail },
    });

    const link = `${env.WEB_BASE_URL}${env.BASE_PATH}/login?ref=${customer.referralCode}`;
    const name = customer.firstName ?? "A friend";
    await sendMail({
      to: refereeEmail,
      subject: `${name} invited you to Vivo Loyalty 🎁`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:24px">
          <h2>You've been invited to Vivo Loyalty</h2>
          <p>${name} thinks you'll love it. Sign up with their link and you'll both earn bonus points.</p>
          <p>You get <b>${env.REFERRAL_REFEREE_POINTS} points</b> just for joining.</p>
          <p><a href="${link}" style="display:inline-block;background:#fe6a02;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Join & claim points</a></p>
        </div>`,
    });

    return { ok: true };
  });
}
