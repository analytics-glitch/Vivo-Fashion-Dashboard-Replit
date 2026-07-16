-- AddUniquePartialIndex
-- Prevents double-awarding points when Shopify resends an orders/paid webhook
-- with a different webhook-id but the same order id. A partial unique index
-- covers only EARN rows so refunds (REFUND type) on the same order remain
-- unrestricted.
CREATE UNIQUE INDEX "pts_txn_earn_order_unique"
  ON "PointsTransaction" ("shopifyOrderId")
  WHERE type = 'EARN';
