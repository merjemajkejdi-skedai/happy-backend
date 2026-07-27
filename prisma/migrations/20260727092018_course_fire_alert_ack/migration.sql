-- Phase 2, session 2c: fire alerts derive from order_courses.fired_at + this
-- ack column rather than a separate table (see docs/phase2/SESSION-2c.md).
ALTER TABLE "order_courses" ADD COLUMN "fire_alert_acked_at" TIMESTAMPTZ;
