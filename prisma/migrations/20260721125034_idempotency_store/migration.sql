/*
  Warnings:

  - You are about to drop the column `idempotency_key` on the `order_events` table. All the data in the column will be lost.
  - You are about to drop the column `idempotency_key` on the `order_items` table. All the data in the column will be lost.
  - You are about to drop the column `idempotency_key` on the `orders` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed');

-- AlterTable
ALTER TABLE "order_events" DROP COLUMN "idempotency_key";

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "idempotency_key";

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "idempotency_key";

-- CreateTable
CREATE TABLE "idempotency_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'in_progress',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "idempotency_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_requests_venue_id_user_id_route_idempotency_key_key" ON "idempotency_requests"("venue_id", "user_id", "route", "idempotency_key");

-- AddForeignKey
ALTER TABLE "idempotency_requests" ADD CONSTRAINT "idempotency_requests_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_requests" ADD CONSTRAINT "idempotency_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
