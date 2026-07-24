-- Phase 2 session 2a-i: foundation migration. Database only — no routes, no
-- services, no business logic. See docs/phase2/SCHEMA-ADDITIONS.md for the
-- plain-English table definitions and docs/phase2/SESSION-2a-i.md for the
-- session handoff.

-- CreateEnum
CREATE TYPE "modifier_pricing" AS ENUM ('free', 'fixed', 'tiered');

-- CreateEnum
CREATE TYPE "course_status" AS ENUM ('pending', 'fired', 'preparing', 'ready', 'served');

-- CreateEnum
CREATE TYPE "split_type" AS ENUM ('equal', 'by_item', 'by_seat');

-- CreateEnum
CREATE TYPE "void_status" AS ENUM ('pending_approval', 'approved', 'rejected', 'auto_approved');

-- CreateEnum
CREATE TYPE "void_stage" AS ENUM ('before_send', 'after_send');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('cash', 'card', 'bank_transfer', 'voucher', 'room_charge', 'other');

-- CreateEnum
CREATE TYPE "stock_mode" AS ENUM ('none', 'count', 'daily_limit');

-- CreateEnum
CREATE TYPE "shift_status" AS ENUM ('open', 'closed');

-- AlterEnum
ALTER TYPE "order_status" ADD VALUE 'merged';

-- AlterTable
ALTER TABLE "modifier_groups" ADD COLUMN     "applies_to_destination" "destination",
ADD COLUMN     "display_style" TEXT NOT NULL DEFAULT 'list',
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pricing_mode" "modifier_pricing" NOT NULL DEFAULT 'fixed';

-- AlterTable
ALTER TABLE "modifier_options" ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stock_tracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tier_prices" JSONB;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "course_fired_at" TIMESTAMPTZ,
ADD COLUMN     "course_number" SMALLINT,
ADD COLUMN     "original_order_item_id" UUID,
ADD COLUMN     "seat_number" SMALLINT,
ADD COLUMN     "split_from_order_id" UUID,
ADD COLUMN     "void_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "amount_due" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amount_paid" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "business_date" DATE,
ADD COLUMN     "current_course_fired" SMALLINT,
ADD COLUMN     "merged_at" TIMESTAMPTZ,
ADD COLUMN     "merged_by_user_id" UUID,
ADD COLUMN     "merged_into_order_id" UUID,
ADD COLUMN     "parent_order_id" UUID,
ADD COLUMN     "shift_id" UUID,
ADD COLUMN     "split_sequence" SMALLINT,
ADD COLUMN     "split_type" "split_type";

-- AlterTable: Phase 2 settings additions first (old columns still present,
-- so the copy step below has both sides available).
ALTER TABLE "restaurant_settings" ADD COLUMN     "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allow_partial_payment" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "auto_fire_first_course" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "business_day_start_hour" SMALLINT NOT NULL DEFAULT 5,
ADD COLUMN     "course_fire_requires_previous_served" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "course_names" JSONB NOT NULL DEFAULT '["Starters","Mains","Desserts"]',
ADD COLUMN     "eightysix_requires_manager" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eightysix_resets_daily" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "merge_requires_manager" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "merge_tables_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "modifier_max_groups_per_item" SMALLINT NOT NULL DEFAULT 10,
ADD COLUMN     "modifier_pricing_mode" "modifier_pricing" NOT NULL DEFAULT 'fixed',
ADD COLUMN     "payment_capture_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "payment_methods_enabled" JSONB NOT NULL DEFAULT '["cash","card"]',
ADD COLUMN     "reports_visible_to_manager" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "require_modifier_validation" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "require_payment_to_close" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "send_by_course" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shift_auto_close_hours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "shifts_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "show_fire_alert_seconds" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "split_bill_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "split_by_item_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "split_equal_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "split_max_ways" SMALLINT NOT NULL DEFAULT 8,
ADD COLUMN     "stock_auto_86_at_zero" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "stock_tracking_mode" "stock_mode" NOT NULL DEFAULT 'none',
ADD COLUMN     "stock_warn_threshold" SMALLINT NOT NULL DEFAULT 5,
ADD COLUMN     "void_alerts_kitchen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "void_approval_role" "user_role" NOT NULL DEFAULT 'manager',
ADD COLUMN     "void_before_send_requires_approval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "void_reason_preset_list" JSONB NOT NULL DEFAULT '["Customer changed mind","Wrong item","Quality issue","Kitchen error","Staff error"]',
ADD COLUMN     "void_reason_required" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "void_requires_approval" BOOLEAN NOT NULL DEFAULT false;

-- Data migration (2a-i section 3): preserve the two Phase 1 flags being
-- retired. Both were unimplemented in Phase 1 — this only carries forward
-- whatever value each venue happened to have.
UPDATE "restaurant_settings" SET
  "merge_tables_enabled" = "allow_order_merge",
  "void_reason_required" = "require_reason_on_void";

-- AlterTable: now drop the two retired columns.
ALTER TABLE "restaurant_settings" DROP COLUMN "allow_order_merge",
DROP COLUMN "require_reason_on_void";

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "name" TEXT,
    "status" "shift_status" NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by_user_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ,
    "closed_by_user_id" UUID,
    "opening_float" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "closing_cash_counted" DECIMAL(10,2),
    "cash_variance" DECIMAL(10,2),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "course_number" SMALLINT NOT NULL,
    "course_name_snapshot" TEXT NOT NULL,
    "status" "course_status" NOT NULL DEFAULT 'pending',
    "fired_at" TIMESTAMPTZ,
    "fired_by_user_id" UUID,
    "first_ready_at" TIMESTAMPTZ,
    "all_served_at" TIMESTAMPTZ,
    "item_count" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_void_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "shift_id" UUID,
    "order_id" UUID NOT NULL,
    "order_number" INTEGER NOT NULL,
    "order_item_id" UUID,
    "item_name_snapshot" TEXT NOT NULL,
    "category_name_snapshot" TEXT NOT NULL,
    "quantity" SMALLINT NOT NULL,
    "unit_price_snapshot" DECIMAL(10,2) NOT NULL,
    "void_value" DECIMAL(10,2) NOT NULL,
    "destination_snapshot" "destination" NOT NULL,
    "stage" "void_stage" NOT NULL,
    "status" "void_status" NOT NULL,
    "reason_code" TEXT,
    "reason_text" TEXT,
    "requested_by_user_id" UUID NOT NULL,
    "requested_by_name" TEXT NOT NULL,
    "approved_by_user_id" UUID,
    "approved_by_name" TEXT,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "rejection_reason" TEXT,
    "kitchen_notified_at" TIMESTAMPTZ,
    "table_label_snapshot" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_void_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_stock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "mode" "stock_mode" NOT NULL,
    "starting_quantity" INTEGER,
    "current_quantity" INTEGER,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "is_86ed" BOOLEAN NOT NULL DEFAULT false,
    "eightysixed_at" TIMESTAMPTZ,
    "eightysixed_by_user_id" UUID,
    "eightysix_reason" TEXT,
    "restored_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "order_item_id" UUID,
    "actor_user_id" UUID,
    "balance_after" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shift_id" UUID,
    "business_date" DATE NOT NULL,
    "method" "payment_method" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "tip_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "received_amount" DECIMAL(10,2),
    "change_amount" DECIMAL(10,2),
    "reference" TEXT,
    "taken_by_user_id" UUID NOT NULL,
    "taken_by_name" TEXT NOT NULL,
    "is_voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_by_user_id" UUID,
    "voided_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "shift_id" UUID,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by_user_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "request_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "order_id" UUID,
    "status" "void_status" NOT NULL DEFAULT 'pending_approval',
    "requested_by_user_id" UUID NOT NULL,
    "required_role" "user_role" NOT NULL,
    "resolved_by_user_id" UUID,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_venue_id_business_date_idx" ON "shifts"("venue_id", "business_date");

-- CreateIndex
CREATE INDEX "order_courses_venue_id_status_fired_at_idx" ON "order_courses"("venue_id", "status", "fired_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_courses_order_id_course_number_key" ON "order_courses"("order_id", "course_number");

-- CreateIndex
CREATE INDEX "restaurant_void_log_venue_id_business_date_idx" ON "restaurant_void_log"("venue_id", "business_date");

-- CreateIndex
CREATE INDEX "restaurant_void_log_venue_id_shift_id_idx" ON "restaurant_void_log"("venue_id", "shift_id");

-- CreateIndex
CREATE INDEX "menu_item_stock_venue_id_business_date_is_86ed_idx" ON "menu_item_stock"("venue_id", "business_date", "is_86ed");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_stock_menu_item_id_business_date_key" ON "menu_item_stock"("menu_item_id", "business_date");

-- CreateIndex
CREATE INDEX "stock_movements_venue_id_menu_item_id_business_date_idx" ON "stock_movements"("venue_id", "menu_item_id", "business_date");

-- CreateIndex
CREATE INDEX "payments_venue_id_business_date_method_idx" ON "payments"("venue_id", "business_date", "method");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "shift_reports_venue_id_period_start_period_end_idx" ON "shift_reports"("venue_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "shift_reports_shift_id_idx" ON "shift_reports"("shift_id");

-- CreateIndex
CREATE INDEX "approval_requests_request_type_subject_id_idx" ON "approval_requests"("request_type", "subject_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merged_into_order_id_fkey" FOREIGN KEY ("merged_into_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merged_by_user_id_fkey" FOREIGN KEY ("merged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_split_from_order_id_fkey" FOREIGN KEY ("split_from_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_original_order_item_id_fkey" FOREIGN KEY ("original_order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_void_id_fkey" FOREIGN KEY ("void_id") REFERENCES "restaurant_void_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opened_by_user_id_fkey" FOREIGN KEY ("opened_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_courses" ADD CONSTRAINT "order_courses_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_courses" ADD CONSTRAINT "order_courses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_courses" ADD CONSTRAINT "order_courses_fired_by_user_id_fkey" FOREIGN KEY ("fired_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_void_log" ADD CONSTRAINT "restaurant_void_log_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_void_log" ADD CONSTRAINT "restaurant_void_log_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_void_log" ADD CONSTRAINT "restaurant_void_log_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_void_log" ADD CONSTRAINT "restaurant_void_log_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_stock" ADD CONSTRAINT "menu_item_stock_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_stock" ADD CONSTRAINT "menu_item_stock_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_stock" ADD CONSTRAINT "menu_item_stock_eightysixed_by_user_id_fkey" FOREIGN KEY ("eightysixed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_taken_by_user_id_fkey" FOREIGN KEY ("taken_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_reports" ADD CONSTRAINT "shift_reports_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_reports" ADD CONSTRAINT "shift_reports_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_reports" ADD CONSTRAINT "shift_reports_generated_by_user_id_fkey" FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Hand-added constraints — Prisma has no declarative support for CHECK
-- constraints or partial unique indexes. See docs/phase2/SCHEMA-ADDITIONS.md.
-- ─────────────────────────────────────────────────────────────────────────

-- modifier_groups: max_select must be >= min_select when set, and a
-- single-select group's max_select must be exactly 1 (or unset).
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_max_select_check"
  CHECK (max_select IS NULL OR max_select >= min_select);
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_single_max_select_check"
  CHECK (type <> 'single' OR max_select IS NULL OR max_select = 1);

-- payments: amount must be positive.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK (amount > 0);

-- restaurant_void_log: fast lookup of the pending-approval queue per venue.
CREATE INDEX "restaurant_void_log_venue_id_status_pending_idx"
  ON "restaurant_void_log"("venue_id", "status") WHERE status = 'pending_approval';

-- shifts: the enforcement mechanism for one open shift per venue — do not
-- rely on application logic alone.
CREATE UNIQUE INDEX "shifts_venue_id_open_key" ON "shifts"("venue_id") WHERE status = 'open';

-- approval_requests: fast lookup of the pending-approval queue per venue.
CREATE INDEX "approval_requests_venue_id_status_pending_idx"
  ON "approval_requests"("venue_id", "status") WHERE status = 'pending_approval';

-- ─────────────────────────────────────────────────────────────────────────
-- 2a-i section 6: relax orders_active_table_key for split-bill child orders.
-- Split bill creates child orders (parent_order_id IS NOT NULL) on the same
-- table as their parent; the Phase 1 index would incorrectly reject them.
-- Children are now excluded from the index entirely — the parent order
-- itself still occupies the slot, and two independent (parentless) orders
-- on the same table are still rejected. See tests/activeOrderIndex.test.ts.
-- ─────────────────────────────────────────────────────────────────────────
DROP INDEX "orders_active_table_key";

CREATE UNIQUE INDEX "orders_active_table_key" ON "orders"("table_id")
  WHERE table_id IS NOT NULL
    AND parent_order_id IS NULL
    AND status IN ('draft', 'open', 'sent', 'partially_served', 'served');
