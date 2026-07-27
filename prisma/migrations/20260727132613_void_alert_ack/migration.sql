-- Phase 2, session 2d-ii: void display alerts derive from restaurant_void_log
-- (stage/status/kitchen_notified_at + this ack column) rather than a separate
-- table (see docs/phase2/SESSION-2d-ii.md).
ALTER TABLE "restaurant_void_log" ADD COLUMN "void_alert_acked_at" TIMESTAMPTZ;
