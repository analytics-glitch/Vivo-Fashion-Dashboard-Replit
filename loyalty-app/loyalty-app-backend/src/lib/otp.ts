import { createHash, randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function generateCode(length = env.OTP_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString();
  return code;
}

export async function createOtp(prisma: PrismaClient, email: string) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

  // Invalidate any outstanding codes for this email.
  await prisma.otpCode.updateMany({
    where: { email, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.otpCode.create({
    data: { email, codeHash: hashCode(code), expiresAt },
  });

  return { code, expiresAt };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "not_found" | "too_many_attempts" | "mismatch" };

export async function verifyOtp(
  prisma: PrismaClient,
  email: string,
  code: string,
): Promise<VerifyResult> {
  const record = await prisma.otpCode.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return { ok: false, reason: "not_found" };
  if (record.expiresAt < new Date()) return { ok: false, reason: "expired" };
  if (record.attempts >= env.OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (record.codeHash !== hashCode(code)) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "mismatch" };
  }

  await prisma.otpCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });
  return { ok: true };
}
