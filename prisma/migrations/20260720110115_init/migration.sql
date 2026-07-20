-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "venue_type" AS ENUM ('happy_restaurant', 'happy_bar', 'happy_hybrid');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('waiter', 'kitchen', 'admin', 'manager', 'bar');

-- CreateEnum
CREATE TYPE "login_method" AS ENUM ('pin', 'email', 'both');

-- CreateEnum
CREATE TYPE "table_naming" AS ENUM ('number', 'name', 'both');

-- CreateEnum
CREATE TYPE "service_mode" AS ENUM ('table', 'counter');

-- CreateEnum
CREATE TYPE "destination" AS ENUM ('kitchen', 'bar', 'none');

-- CreateEnum
CREATE TYPE "table_status" AS ENUM ('free', 'occupied', 'reserved', 'dirty');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('draft', 'open', 'sent', 'partially_served', 'served', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "order_item_status" AS ENUM ('pending', 'sent', 'preparing', 'ready', 'served', 'cancelled');

-- CreateEnum
CREATE TYPE "modifier_type" AS ENUM ('single', 'multiple');

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "venue_type" "venue_type" NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Tirane',
    "currency" CHAR(3) NOT NULL DEFAULT 'ALL',
    "locale" TEXT NOT NULL DEFAULT 'sq-AL',
    "address" TEXT,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "pms_provider" TEXT,
    "pms_property_id" TEXT,
    "pms_config" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "login_method" "login_method" NOT NULL DEFAULT 'pin',
    "pin_length" SMALLINT NOT NULL DEFAULT 4,
    "session_timeout_minutes" INTEGER NOT NULL DEFAULT 720,
    "require_pin_on_reopen" BOOLEAN NOT NULL DEFAULT false,
    "table_naming_mode" "table_naming" NOT NULL DEFAULT 'number',
    "tables_enabled" BOOLEAN NOT NULL DEFAULT true,
    "counter_service_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ticket_number_prefix" TEXT NOT NULL DEFAULT '',
    "ticket_number_reset" TEXT NOT NULL DEFAULT 'daily',
    "require_table_for_order" BOOLEAN NOT NULL DEFAULT true,
    "allow_table_transfer" BOOLEAN NOT NULL DEFAULT true,
    "allow_order_merge" BOOLEAN NOT NULL DEFAULT false,
    "courses_enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_course_count" SMALLINT NOT NULL DEFAULT 3,
    "modifiers_enabled" BOOLEAN NOT NULL DEFAULT true,
    "allow_free_text_notes" BOOLEAN NOT NULL DEFAULT true,
    "kitchen_display_enabled" BOOLEAN NOT NULL DEFAULT true,
    "bar_display_enabled" BOOLEAN NOT NULL DEFAULT false,
    "kitchen_printer_enabled" BOOLEAN NOT NULL DEFAULT false,
    "bar_printer_enabled" BOOLEAN NOT NULL DEFAULT false,
    "display_auto_refresh_seconds" INTEGER NOT NULL DEFAULT 10,
    "display_show_elapsed_time" BOOLEAN NOT NULL DEFAULT true,
    "display_warn_after_minutes" INTEGER NOT NULL DEFAULT 15,
    "allow_item_void_after_send" BOOLEAN NOT NULL DEFAULT false,
    "require_reason_on_void" BOOLEAN NOT NULL DEFAULT true,
    "auto_send_on_add" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_config" JSONB,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ai_config" JSONB,
    "pms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "pms_room_charge_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate_percent" DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    "service_charge_percent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" CITEXT,
    "password_hash" TEXT,
    "pin_hash" TEXT,
    "pin_lookup" TEXT,
    "role" "user_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_label" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "default_destination" "destination",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "area_id" UUID,
    "table_number" INTEGER,
    "table_name" TEXT,
    "seats" SMALLINT NOT NULL DEFAULT 2,
    "status" "table_status" NOT NULL DEFAULT 'free',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_destination" "destination" NOT NULL DEFAULT 'kitchen',
    "default_course_number" SMALLINT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "color_hex" CHAR(7),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "destination" "destination" NOT NULL,
    "course_number" SMALLINT,
    "sku" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "prep_minutes" SMALLINT,
    "tax_rate_percent" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "modifier_type" NOT NULL DEFAULT 'single',
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "min_select" SMALLINT NOT NULL DEFAULT 0,
    "max_select" SMALLINT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_modifier_groups" (
    "menu_item_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "overrides_required" BOOLEAN,

    CONSTRAINT "menu_item_modifier_groups_pkey" PRIMARY KEY ("menu_item_id","group_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "order_number" INTEGER NOT NULL,
    "service_mode" "service_mode" NOT NULL,
    "table_id" UUID,
    "ticket_number" TEXT,
    "guest_count" SMALLINT,
    "customer_name" TEXT,
    "status" "order_status" NOT NULL DEFAULT 'draft',
    "opened_by_user_id" UUID NOT NULL,
    "closed_by_user_id" UUID,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_sent_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "service_charge_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "pms_folio_id" TEXT,
    "pms_room_number" TEXT,
    "pms_posted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "menu_item_id" UUID,
    "item_name_snapshot" TEXT NOT NULL,
    "category_name_snapshot" TEXT NOT NULL,
    "unit_price_snapshot" DECIMAL(10,2) NOT NULL,
    "destination_snapshot" "destination" NOT NULL,
    "course_number_snapshot" SMALLINT,
    "tax_rate_snapshot" DECIMAL(5,2) NOT NULL,
    "quantity" SMALLINT NOT NULL,
    "modifiers_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(10,2) NOT NULL,
    "status" "order_item_status" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "added_by_user_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ,
    "preparing_at" TIMESTAMPTZ,
    "ready_at" TIMESTAMPTZ,
    "served_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" TEXT,
    "void_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_item_id" UUID NOT NULL,
    "modifier_option_id" UUID,
    "group_name_snapshot" TEXT NOT NULL,
    "option_name_snapshot" TEXT NOT NULL,
    "price_delta_snapshot" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID,
    "event_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_counters" (
    "venue_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "last_ticket_number" INTEGER NOT NULL DEFAULT 0,
    "last_order_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("venue_id","business_date")
);

-- CreateIndex
CREATE UNIQUE INDEX "venues_slug_key" ON "venues"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_settings_venue_id_key" ON "restaurant_settings"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_venue_id_sku_key" ON "menu_items"("venue_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "orders_venue_id_order_number_key" ON "orders"("venue_id", "order_number");

-- CreateIndex
CREATE INDEX "order_items_venue_id_destination_snapshot_status_idx" ON "order_items"("venue_id", "destination_snapshot", "status");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_sent_at_idx" ON "order_items"("sent_at");

-- AddForeignKey
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_opened_by_user_id_fkey" FOREIGN KEY ("opened_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_void_by_user_id_fkey" FOREIGN KEY ("void_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_modifier_option_id_fkey" FOREIGN KEY ("modifier_option_id") REFERENCES "modifier_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added constraints — Prisma has no declarative support for CHECK
-- constraints or partial unique indexes. See docs/SCHEMA.md.

-- users: must have either (email + password) or a PIN to log in with
ALTER TABLE "users" ADD CONSTRAINT "users_login_credential_check"
  CHECK ((email IS NOT NULL AND password_hash IS NOT NULL) OR pin_hash IS NOT NULL);

CREATE UNIQUE INDEX "users_venue_id_email_key" ON "users"("venue_id", "email") WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX "users_venue_id_pin_lookup_key" ON "users"("venue_id", "pin_lookup") WHERE "pin_lookup" IS NOT NULL;

-- areas: unique active name per venue (soft-deleted rows don't collide)
CREATE UNIQUE INDEX "areas_venue_id_name_key" ON "areas"("venue_id", "name") WHERE "deleted_at" IS NULL;

-- tables: must be identified by number and/or name; unique active number/name per venue
ALTER TABLE "tables" ADD CONSTRAINT "tables_identifier_check"
  CHECK (table_number IS NOT NULL OR table_name IS NOT NULL);

CREATE UNIQUE INDEX "tables_venue_id_table_number_key" ON "tables"("venue_id", "table_number") WHERE "table_number" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "tables_venue_id_table_name_key" ON "tables"("venue_id", "table_name") WHERE "table_name" IS NOT NULL AND "deleted_at" IS NULL;

-- menu_categories: unique active name per venue
CREATE UNIQUE INDEX "menu_categories_venue_id_name_key" ON "menu_categories"("venue_id", "name") WHERE "deleted_at" IS NULL;

-- menu_items: price can never be negative
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_price_check" CHECK (price >= 0);

-- order_items: quantity must be positive
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK (quantity > 0);

-- orders: service_mode dictates which of table_id/ticket_number is required,
-- and only one active order per table at a time (DB-level enforcement)
ALTER TABLE "orders" ADD CONSTRAINT "orders_service_mode_check"
  CHECK (
    (service_mode = 'table' AND table_id IS NOT NULL)
    OR (service_mode = 'counter' AND ticket_number IS NOT NULL)
  );

CREATE UNIQUE INDEX "orders_active_table_key" ON "orders"("table_id")
  WHERE table_id IS NOT NULL
    AND status IN ('draft', 'open', 'sent', 'partially_served', 'served');
