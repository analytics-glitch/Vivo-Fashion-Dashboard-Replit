import { customAlphabet } from "nanoid";
import type { PrismaClient, Customer } from "@prisma/client";
import { env } from "../config/env.js";
import { awardPoints, recomputeTier, tierProgress } from "./loyalty.js";
import { findCustomerByEmail } from "./shopify.js";
import { sendMail, welcomeEmail } from "./email.js";

const refCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

interface FindOrCreateArgs {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string | null;
  googleId?: string | null;
  emailVerified?: boolean;
  /** Referral code of the person who invited this customer. */
  referralCodeUsed?: string | null;
}

/**
 * Finds an existing customer by email (or googleId) or creates a new one.
 * On creation: links Shopify customer, grants signup bonus, handles referral,
 * sends a welcome email.
 */
export async function findOrCreateCustomer(
  prisma: PrismaClient,
  args: FindOrCreateArgs,
): Promise<{ customer: Customer; created: boolean }> {
  const email = args.email.toLowerCase().trim();

  let customer = await prisma.customer.findUnique({ where: { email } });

  const isAdmin = env.ADMIN_EMAILS.includes(email);

  if (customer) {
    // Backfill identity fields on subsequent logins.
    const data: Record<string, unknown> = {};
    if (args.googleId && !customer.googleId) data.googleId = args.googleId;
    if (args.firstName && !customer.firstName) data.firstName = args.firstName;
    if (args.lastName && !customer.lastName) data.lastName = args.lastName;
    if (args.avatarUrl && !customer.avatarUrl) data.avatarUrl = args.avatarUrl;
    if (args.emailVerified && !customer.emailVerified) data.emailVerified = true;
    // Backfill Shopify customer link on subsequent logins.
    if (!customer.shopifyCustomerId) {
      try {
        const sc = await findCustomerByEmail(customer.email);
        if (sc && sc.email && sc.email.toLowerCase() === customer.email.toLowerCase()) {
          data.shopifyCustomerId = String(sc.id);
        }
      } catch { /* non-fatal: leave unlinked, retry next login */ }
    }
    // Keep admin role in sync with ADMIN_EMAILS.
    if (isAdmin && customer.role !== "ADMIN") data.role = "ADMIN";
    if (!isAdmin && customer.role === "ADMIN") data.role = "CUSTOMER";
    if (Object.keys(data).length) {
      customer = await prisma.customer.update({ where: { id: customer.id }, data });
    }
    return { customer, created: false };
  }

  // Resolve referrer (if any) before creating.
  let referredById: string | null = null;
  if (args.referralCodeUsed) {
    const referrer = await prisma.customer.findUnique({
      where: { referralCode: args.referralCodeUsed.toUpperCase() },
    });
    if (referrer) referredById = referrer.id;
  }

  // Link Shopify customer by email if available.
  let shopifyCustomerId: string | null = null;
  let sFirst = args.firstName ?? null;
  let sLast = args.lastName ?? null;
  try {
    const sc = await findCustomerByEmail(email);
    if (sc) {
      shopifyCustomerId = String(sc.id);
      sFirst = sFirst ?? sc.first_name;
      sLast = sLast ?? sc.last_name;
    }
  } catch {
    // Shopify not configured / unreachable — proceed without linkage.
  }

  // Ensure a unique referral code.
  let code = refCode();
  while (await prisma.customer.findUnique({ where: { referralCode: code } })) code = refCode();

  customer = await prisma.customer.create({
    data: {
      email,
      firstName: sFirst,
      lastName: sLast,
      avatarUrl: args.avatarUrl ?? null,
      googleId: args.googleId ?? null,
      emailVerified: args.emailVerified ?? false,
      shopifyCustomerId,
      referralCode: code,
      referredById,
      role: isAdmin ? "ADMIN" : "CUSTOMER",
    },
  });

  // Signup bonus.
  if (env.SIGNUP_BONUS_POINTS > 0) {
    customer = await awardPoints(prisma, {
      customerId: customer.id,
      points: env.SIGNUP_BONUS_POINTS,
      type: "SIGNUP",
      description: "Welcome bonus",
    });
  } else {
    customer = await recomputeTier(prisma, customer);
  }

  // Referral: mark referral record + reward referee immediately; referrer is
  // rewarded when the referee completes a qualifying order (webhook).
  if (referredById) {
    await prisma.referral.upsert({
      where: { referrerId_refereeEmail: { referrerId: referredById, refereeEmail: email } },
      update: { refereeId: customer.id },
      create: { referrerId: referredById, refereeEmail: email, refereeId: customer.id },
    });
    if (env.REFERRAL_REFEREE_POINTS > 0) {
      customer = await awardPoints(prisma, {
        customerId: customer.id,
        points: env.REFERRAL_REFEREE_POINTS,
        type: "REFERRAL",
        description: "Referral welcome bonus",
      });
    }
  }

  // Welcome email (fire and forget).
  sendMail({
    to: email,
    subject: "Welcome to Vivo Loyalty 🎉",
    html: welcomeEmail(customer.firstName, customer.pointsBalance),
  }).catch(() => {});

  return { customer, created: true };
}

/** Record a successful login (count + timestamps) for the admin dashboard. */
export async function recordLogin(prisma: PrismaClient, customerId: string) {
  await prisma.customer
    .update({
      where: { id: customerId },
      data: { loginCount: { increment: 1 }, lastLoginAt: new Date(), lastSeenAt: new Date() },
    })
    .catch(() => {});
}

/** Serialise a customer for the API (safe public shape + tier progress). */
export async function serializeCustomer(prisma: PrismaClient, customer: Customer) {
  const progress = await tierProgress(prisma, customer);
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    avatarUrl: customer.avatarUrl,
    phone: customer.phone,
    birthday: customer.birthday,
    role: customer.role,
    emailVerified: customer.emailVerified,
    pointsBalance: customer.pointsBalance,
    lifetimePoints: customer.lifetimePoints,
    streakCount: customer.streakCount,
    referralCode: customer.referralCode,
    shopifyLinked: Boolean(customer.shopifyCustomerId),
    tier: progress.current,
    nextTier: progress.next,
    pointsToNext: progress.pointsToNext,
    tierProgress: progress.progress,
    tiers: progress.allTiers,
    createdAt: customer.createdAt,
  };
}
