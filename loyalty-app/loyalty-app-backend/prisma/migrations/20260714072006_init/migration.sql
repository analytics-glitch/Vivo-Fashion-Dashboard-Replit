-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PointsType" AS ENUM ('EARN', 'REDEEM', 'SIGNUP', 'BIRTHDAY', 'REFERRAL', 'STREAK', 'ADJUST', 'EXPIRE', 'REFUND');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'FREE_SHIPPING', 'FREE_PRODUCT');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('ISSUED', 'USED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "phone" TEXT,
    "birthday" TIMESTAMP(3),
    "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
    "googleId" TEXT,
    "shopifyCustomerId" TEXT,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "lifetimePoints" INTEGER NOT NULL DEFAULT 0,
    "tierId" TEXT,
    "streakCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3),
    "lastBirthdayGrant" INTEGER,
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "minPoints" INTEGER NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "icon" TEXT,
    "perks" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsTransaction" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "PointsType" NOT NULL,
    "points" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "redemptionId" TEXT,
    "referralId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "type" "RewardType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stock" INTEGER,
    "minTierId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "pointsSpent" INTEGER NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'ISSUED',
    "discountCode" TEXT,
    "shopifyPriceRuleId" TEXT,
    "shopifyDiscountId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeEmail" TEXT NOT NULL,
    "refereeId" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_googleId_key" ON "Customer"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shopifyCustomerId_key" ON "Customer"("shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_referralCode_key" ON "Customer"("referralCode");

-- CreateIndex
CREATE INDEX "Customer_tierId_idx" ON "Customer"("tierId");

-- CreateIndex
CREATE INDEX "Customer_referredById_idx" ON "Customer"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "Tier_name_key" ON "Tier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Tier_slug_key" ON "Tier"("slug");

-- CreateIndex
CREATE INDEX "Tier_minPoints_idx" ON "Tier"("minPoints");

-- CreateIndex
CREATE INDEX "PointsTransaction_customerId_createdAt_idx" ON "PointsTransaction"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "PointsTransaction_shopifyOrderId_idx" ON "PointsTransaction"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "PointsTransaction_type_idx" ON "PointsTransaction"("type");

-- CreateIndex
CREATE INDEX "Reward_active_idx" ON "Reward"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_discountCode_key" ON "Redemption"("discountCode");

-- CreateIndex
CREATE INDEX "Redemption_customerId_createdAt_idx" ON "Redemption"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Referral_refereeEmail_idx" ON "Referral"("refereeEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referrerId_refereeEmail_key" ON "Referral"("referrerId", "refereeEmail");

-- CreateIndex
CREATE INDEX "OtpCode_email_createdAt_idx" ON "OtpCode"("email", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_webhookId_key" ON "ProcessedWebhook"("webhookId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
