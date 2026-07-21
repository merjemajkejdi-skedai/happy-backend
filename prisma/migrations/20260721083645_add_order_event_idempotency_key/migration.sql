-- AlterTable
ALTER TABLE "order_events" ADD COLUMN     "idempotency_key" TEXT;

-- Idempotency-Key replay support for POST /orders/:id/send — hand-added,
-- Prisma has no declarative partial-unique support. See docs/SCHEMA.md.
CREATE UNIQUE INDEX "order_events_order_id_idempotency_key_key" ON "order_events"("order_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
