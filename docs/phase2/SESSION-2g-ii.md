# Session 2g-ii — Shifts

**Status:** Complete. Full suite green (27 files / 565 tests), `tsc --noEmit` clean. No schema changes — `shifts`, `shift_reports`, `restaurant_settings.shifts_enabled`/`shift_auto_close_hours`/`business_day_start_hour`, and the `shifts_venue_id_open_key` partial unique index were all already in place from 2a-i; this session is the first to write real logic against them, plus a data-only backfill migration for `orders.business_date`.

## Implemented

### 1. `src/modules/shifts/businessDate.ts` — `computeBusinessDate(timestamp, timezone, businessDayStartHour)`

A timestamp before the start hour belongs to the previous calendar date, computed in the venue's own timezone via `Intl.DateTimeFormat`. Deliberately a new, separately-named function distinct from `orders/validation.ts`'s own `computeBusinessDate` (governs `ticket_number_reset` only, unrelated) and from `menu/stockService.ts`'s `businessDateFor` (stock's plain calendar-day reset, no start-hour offset — left untouched, out of this session's scope). Imported into `ordersService.ts` under the alias `computeShiftBusinessDate` to avoid any confusion with the other same-named function already in scope there.

### 2. Backfill migration

`prisma/migrations/20260728084332_backfill_order_business_date/` — a schema-diff-free, data-only migration (created via `prisma migrate dev --create-only`, hand-written, applied via `prisma migrate dev`). Backfills every existing `orders.business_date IS NULL` row from `opened_at`, `venues.timezone`, and `restaurant_settings.business_day_start_hour` using `AT TIME ZONE` — the SQL equivalent of `computeBusinessDate`. Idempotent (only touches still-`NULL` rows), safe to re-run.

### 3. Order creation now sets `business_date` and `shift_id`

`ordersService.createOrder`: `business_date` is set **unconditionally** on every new order via `computeShiftBusinessDate` — it's a standalone "what day did this happen" fact, useful for reporting whether or not shift tracking is even on, matching the backfill's own intent. `shift_id` attaches to the currently open shift only when `shifts_enabled=true` **and** a shift happens to be open right now; with neither, order creation still succeeds with `shift_id` null ("never block service because someone forgot to open a shift" — 2g-ii.md section 3).

### 4. `src/modules/shifts/shiftsService.ts`

- `openShift` — 409 `SHIFT_ALREADY_OPEN` via catching the `shifts_venue_id_open_key` partial-unique-index P2002 (mirrors `ordersService.ts`'s own `isTableConflict` pattern exactly). Also sweeps in every still-active order not currently attached to an open shift (see interpretation call below) and reassigns them, logging one `order.shift_reassigned` event per order.
- `closeShift` — 409 `SHIFT_HAS_OPEN_ORDERS` (with `openOrders: {id, orderNumber}[]` on the result for the route to surface as `error.details.open_orders`) unless `force=true`. Computes `cash_variance = closing_cash_counted - (opening_float + cash payments in shift)`, stored exactly as computed (never clamped or suppressed, per the spec's explicit instruction). Writes a `shift_reports` stub row (`is_final=true`, real period, placeholder `payload` — 2h-i fills in the real contents).
- `getCurrentShift` — returns `{shift, flagged}`; `flagged` is `true` once the shift has been open longer than `shift_auto_close_hours`, and is purely informational — nothing auto-closes.
- `listShifts`/`getShift` — standard paginated list (`?from&to` against `business_date`) and single-row read.

### 5. Routes + docs

`src/modules/shifts/routes.ts` (new), mounted at `/api/v1/shifts` (not nested under `/orders` — a shift isn't scoped to one order). `POST /open`/`POST /close` gated `shift.manage`; the three `GET` routes gated `reports.view` (see interpretation call below). Wired into `app.ts`. `docs/API.md` (new "Shifts" section; the payments section's own note about `shift_id`/`business_date` updated to reflect they're real now), `docs/ERRORS.md` (`SHIFT_ALREADY_OPEN`, `SHIFT_HAS_OPEN_ORDERS`). `Shift`/`ShiftReport` added to `venueScope.ts`'s `VENUE_SCOPED_MODELS` — the same pre-existing gap this arc keeps finding on every table's first real usage.

## Interpretation calls — flagged explicitly

- **The force-close sweep is broader than the literal spec wording.** 2g-ii.md section 3 says force-closing "reassigns them to the next shift on open" — read narrowly, that's only about orders left open by *this specific* force-close. This session's `openShift` instead sweeps in **every** still-active order with no open shift attached (`shift_id IS NULL` or pointing at a now-closed shift), which is a strict superset: it also catches orders created while `shifts_enabled` was off, or from any earlier force-close, not just the immediately preceding one. Chosen because it's the more complete, still-correct reading of the underlying intent (every currently-active order should end up attached to *some* shift once one exists) and because the narrower version would leave genuinely orphaned orders behind in exactly the scenario the literal wording doesn't cover.
- **`GET /shifts/current`, `GET /shifts`, `GET /shifts/:id` are gated by `reports.view`.** The session spec names `shift.manage` only for the two `POST` routes and doesn't assign a permission to the three reads at all. `reports.view` is the closest existing fit and matches how `voidsRouter` already gates its own read-only list/get routes the same way.
- **`SHIFT_HAS_OPEN_ORDERS`'s order list travels through `sendDomainError`'s existing (but until now unused) `details` parameter**, via a `closeShift`-specific result type (`CloseShiftResult`, not the generic `ShiftResult<T>`) carrying an optional `openOrders` field alongside the error. No changes to the shared `DomainError`/`err()` shape — this is the first call site to actually pass a `details` argument through.
- **Stock's and payments' own business-date computation were not retrofitted to the new start-hour-aware function**, even though this session's own header ("implement first, everything else depends on it") could be read as inviting that. `menu/stockService.ts`'s `businessDateFor` and `orders/paymentsService.ts`'s use of it are both already-shipped, already-tested (2e, 2g-i) behavior; 2g-ii.md's own scope line names "Shift lifecycle and business-date computation" for *orders/shifts* specifically, and its only explicit backfill instruction is for `orders.business_date`. Retrofitting stock/payments would be a cross-cutting change well outside this session's stated scope and risked regressing two already-green test suites for no requirement that actually asked for it.

## Tests

`tests/shifts.test.ts` (new, 10 tests): `computeBusinessDate`'s boundary at 04:59/05:00 local and across a real DST spring-forward transition (Europe/Tirane, 2026-03-29, three UTC instants straddling the transition with hand-verified expected local times); order creation with no open shift succeeds with `shift_id` null; one open shift enforced (`SHIFT_ALREADY_OPEN` on a second attempt); orders attach `shift_id` to the currently open shift; close with open orders blocked (open-order ids surfaced) then forced, followed by a verification that the next `openShift` sweeps the still-open order into the new shift; cash variance exact/over/short across three full open→pay→close cycles; a long-running shift (backdated `opened_at` past `shift_auto_close_hours`) is flagged by `GET /shifts/current` but never auto-closed; closing writes a `shift_reports` row with `is_final=true` and the correct period.

One test-isolation issue was found and fixed while writing this suite (not a bug in the implementation — the sweep behavior is exactly as designed): earlier tests' orders that were left non-terminal got swept into later tests' shifts, inflating `SHIFT_HAS_OPEN_ORDERS`'s order count unpredictably. Fixed by explicitly cancelling orders once a test is done with them, and by asserting containment rather than exact array equality for the open-orders list.

Full suite: 27 files, 565 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

Per `docs/phase2/README.md`'s numbering (not yet read this session): `docs/phase2/2h-i.md`/`2h-ii.md` exist as the next files. `shift_reports.payload` is still a placeholder (`{generator, note}`) — 2h-i is explicitly named in this session's own spec as the one that "fills in the payload." This session did not touch reporting, exports, or anything beyond the shift lifecycle itself.
