import type { PrismaClient, PointsType, Customer, Tier } from "@prisma/client";
import { env } from "../config/env.js";

/**
 * Core loyalty engine. All point mutations flow through `awardPoints` /
 * `spendPoints` so the ledger (PointsTransaction) stays the source of truth
 * and the denormalised balance on Customer is always kept in sync.
 */

export interface AwardInput {
  customerId: string;
  points: number; // absolute magnitude (always positive)
  type: PointsType;
  description: string;
  shopifyOrderId?: string;
  redemptionId?: string;
  referralId?: string;
  /** Override expiry; defaults to POINTS_EXPIRY_MONTHS for EARN types. */
  expiresAt?: Date | null;
}

function defaultExpiry(type: PointsType): Date | null {
  const months = env.POINTS_EXPIRY_MONTHS;
  if (!months || months <= 0) return null;
  // Only earned-style credits expire.
  if (["EARN", "SIGNUP", "BIRTHDAY", "REFERRAL", "STREAK"].includes(type)) {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return d;
  }
  return null;
}

/** Credit points and recompute tier. Returns the updated customer. */
export async function awardPoints(prisma: PrismaClient, input: AwardInput): Promise<Customer> {
  const points = Math.abs(Math.round(input.points));
  if (points === 0) {
    return prisma.customer.findUniqueOrThrow({ where: { id: input.customerId } });
  }

  return prisma.$transaction(async (tx) => {
    await tx.pointsTransaction.create({
      data: {
        customerId: input.customerId,
        type: input.type,
        points,
        description: input.description,
        shopifyOrderId: input.shopifyOrderId,
        redemptionId: input.redemptionId,
        referralId: input.referralId,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : defaultExpiry(input.type),
      },
    });

    const updated = await tx.customer.update({
      where: { id: input.customerId },
      data: {
        pointsBalance: { increment: points },
        lifetimePoints: { increment: points },
        lastActivityAt: new Date(),
      },
    });

    return recomputeTier(tx as unknown as PrismaClient, updated);
  });
}

/** Debit points (spend / expire / refund). Guards against negative balance for REDEEM. */
export async function spendPoints(
  prisma: PrismaClient,
  input: Omit<AwardInput, "expiresAt"> & { allowNegative?: boolean },
): Promise<Customer> {
  const points = Math.abs(Math.round(input.points));

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
    if (!input.allowNegative && customer.pointsBalance < points) {
      throw new Error("INSUFFICIENT_POINTS");
    }

    await tx.pointsTransaction.create({
      data: {
        customerId: input.customerId,
        type: input.type,
        points: -points,
        description: input.description,
        shopifyOrderId: input.shopifyOrderId,
        redemptionId: input.redemptionId,
        referralId: input.referralId,
      },
    });

    // Lifetime points are not reduced by spends (they measure loyalty, not balance),
    // but refunds/expiry of *earned* points do reduce lifetime.
    const reducesLifetime = input.type === "REFUND" || input.type === "EXPIRE";

    const updated = await tx.customer.update({
      where: { id: input.customerId },
      data: {
        pointsBalance: { decrement: points },
        ...(reducesLifetime ? { lifetimePoints: { decrement: points } } : {}),
        lastActivityAt: new Date(),
      },
    });

    return recomputeTier(tx as unknown as PrismaClient, updated);
  });
}

/** Recompute a customer's tier based on lifetime points. */
export async function recomputeTier(prisma: PrismaClient, customer: Customer): Promise<Customer> {
  const tiers = await prisma.tier.findMany({ orderBy: { minPoints: "asc" } });
  if (tiers.length === 0) return customer;

  let target: Tier | undefined;
  for (const t of tiers) {
    if (customer.lifetimePoints >= t.minPoints) target = t;
  }
  if (!target || target.id === customer.tierId) return customer;

  return prisma.customer.update({
    where: { id: customer.id },
    data: { tierId: target.id, updatedAt: new Date() },
  });
}

/** Points earned for an order total, applying the customer's tier multiplier. */
export function pointsForOrder(orderTotal: number, tierMultiplier: number): number {
  const base = orderTotal * env.POINTS_PER_CURRENCY;
  return Math.max(0, Math.round(base * tierMultiplier));
}

/** Progress info toward the next tier, for UI. */
export async function tierProgress(prisma: PrismaClient, customer: Customer) {
  const tiers = await prisma.tier.findMany({ orderBy: { minPoints: "asc" } });
  const current = customer.tierId ? tiers.find((t) => t.id === customer.tierId) : tiers[0];
  const next = tiers.find((t) => t.minPoints > (current?.minPoints ?? 0));

  const currentMin = current?.minPoints ?? 0;
  const span = next ? next.minPoints - currentMin : 0;
  const gained = customer.lifetimePoints - currentMin;
  const progress = next && span > 0 ? Math.min(1, Math.max(0, gained / span)) : 1;

  return {
    current: current ?? null,
    next: next ?? null,
    pointsToNext: next ? Math.max(0, next.minPoints - customer.lifetimePoints) : 0,
    progress,
    allTiers: tiers,
  };
}
