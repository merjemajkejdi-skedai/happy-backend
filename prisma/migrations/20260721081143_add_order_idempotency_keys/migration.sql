-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "idempotency_key" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "idempotency_key" TEXT;

-- Idempotency-Key replay support: same key + same venue (or, for items, same
-- key + same order) returns the original resource instead of creating a
-- duplicate. Partial (NULL-safe) so requests without the header are
-- unaffected — hand-added, Prisma has no declarative partial-unique support.
CREATE UNIQUE INDEX "orders_venue_id_idempotency_key_key" ON "orders"("venue_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX "order_items_order_id_idempotency_key_key" ON "order_items"("order_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
