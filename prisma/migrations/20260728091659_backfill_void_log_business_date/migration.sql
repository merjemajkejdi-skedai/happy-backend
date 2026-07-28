-- Phase 2, session 2h-i: restaurant_void_log.business_date was, until this
-- session's voidService.ts fix, computed via orders/validation.ts's
-- ticket_number_reset-based computeBusinessDate — the wrong concept, and
-- outright broken (pinned to the 1970-01-01 sentinel) for any venue with
-- ticket_number_reset='never'. Existing rows are backfilled here from their
-- own order's already-correct (and, for pre-2g-ii orders, already
-- backfilled) business_date — simpler and more consistent than
-- recomputing independently from a timestamp, and exactly matches what
-- voidService.ts now stores for new rows going forward.
UPDATE "restaurant_void_log" vl
SET "business_date" = o."business_date"
FROM "orders" o
WHERE vl."order_id" = o."id"
  AND o."business_date" IS NOT NULL
  AND vl."business_date" IS DISTINCT FROM o."business_date";
