-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "appVersion" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "loginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pwaInstalled" BOOLEAN NOT NULL DEFAULT false;
