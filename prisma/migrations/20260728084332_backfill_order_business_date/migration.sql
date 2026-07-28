-- Phase 2, session 2g-ii, section 1: backfill orders.business_date for
-- existing rows using each order's opened_at, converted to the venue's own
-- timezone and business_day_start_hour. A timestamp before the start hour
-- belongs to the previous calendar date — matches
-- src/modules/shifts/businessDate.ts's computeBusinessDate exactly, just
-- expressed in SQL for a one-time bulk update rather than a per-row app
-- round-trip. Only touches rows that are still NULL, so it is safe to
-- re-run.
UPDATE "orders" o
SET "business_date" = (
  CASE
    WHEN EXTRACT(HOUR FROM (o."opened_at" AT TIME ZONE v."timezone")) < rs."business_day_start_hour"
      THEN ((o."opened_at" AT TIME ZONE v."timezone")::date - INTERVAL '1 day')::date
    ELSE (o."opened_at" AT TIME ZONE v."timezone")::date
  END
)
FROM "venues" v, "restaurant_settings" rs
WHERE o."venue_id" = v."id"
  AND rs."venue_id" = v."id"
  AND o."business_date" IS NULL;
