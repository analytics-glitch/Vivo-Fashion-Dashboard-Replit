-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image" TEXT,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WishlistItem_customerId_createdAt_idx" ON "WishlistItem"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_customerId_handle_key" ON "WishlistItem"("customerId", "handle");

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
