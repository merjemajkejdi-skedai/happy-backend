# Session 2c — Course Firing

**Status:** Complete. Full suite green (19 files / 477 tests), `tsc --noEmit` clean.

## Implemented

### 1. Found and fixed: `OrderCourse` missing from `VENUE_SCOPED_MODELS`

`src/middleware/venueScope.ts` — `OrderCourse` has its own `venue_id` column (confirmed in `prisma/schema.prisma`) but was never added to the guard set when the table was created in session 2a-i. This session is the first code to query it directly by venue, so the gap was found immediately (the guard's own `findMany`/`updateMany` checks caught two missing-`venueId` bugs in my own draft code during testing — see "Errors" below) and fixed as part of this session rather than filed separately, since leaving it unscoped while writing the first real queries against it would have shipped a real cross-tenant gap.

### 2. Migration

New column `order_courses.fire_alert_acked_at timestamptz null` — additive, migration `20260727092018_course_fire_alert_ack`. Fire alerts derive from `fired_at` + this column rather than a separate alerts table (no table was specified for alerts, and `order_courses` already has everything needed). Documented in `docs/phase2/SCHEMA-ADDITIONS.md`'s `order_courses` section as a 2c addendum, not folded into 2a-i's original table listing.

### 3. Course-state derivation (`src/modules/orders/statusMachine.ts`)

Two new pure functions alongside `deriveOrderStatus`:
- `deriveCourseStatus(currentStatus, activeItems)` — a course only progresses past `pending` once explicitly fired; once fired, rolls forward toward `preparing`/`ready`/`served` as its items progress, same "single place this is decided" pattern as order status.
- `courseNameFromSettings(courseNames, courseNumber)` — 1-indexed lookup into the `course_names` JSON array, falls back to `"Course N"` rather than throwing if the array is short.

### 4. `recomputeOrder` now also rolls up courses (`src/modules/orders/ordersService.ts`)

`recomputeCourses` runs on every `recomputeOrder` call (i.e. after every item status change, order-wide) — lazily creates an `order_courses` row the first time an item carries a given `course_number` (not `course_number_snapshot` — see below), and maintains `item_count`/`first_ready_at`/`all_served_at`/`status` for every course number present among the order's active items. This is the single hook that makes `all_served_at` correct for the `course_fire_requires_previous_served` gate without needing course-specific logic scattered across `serveItem`/`serveItems`/`bumpItems`/etc.

### 5. `order_items.course_number` activated (`src/modules/orders/orderItemsService.ts`)

`addItem` now sets `courseNumber: courseNumberSnapshot` at creation. This field existed in the schema since 2a-i but no code ever populated it before this session — it's the live "fire target," independently movable later via `PATCH .../items/:itemId/course`, always distinct from `course_number_snapshot` (the frozen menu-time default, per the schema's own comment).

### 6. `src/modules/orders/coursesService.ts` + `coursesRoutes.ts` (new)

`listCourses`, `fireCourse`, `holdCourse`, `reorderCourses`, `moveItemCourse`. All share `checkCoursesAvailable` (venue-type checked before the setting, per spec). `fireCourse` reuses `sendItemsCore` from `lifecycleService.ts` for the actual item transitions — not reimplemented — then layers the course-row bookkeeping (`status`/`fired_at`/`fired_by_user_id`, `orders.current_course_fired`) on top. Re-firing an already-fired course, and holding an already-pending one, are both idempotent no-op successes (not specified either way; chosen over erroring since neither has any state to fix).

### 7. `auto_fire_first_course` (`src/modules/orders/lifecycleService.ts`)

`sendItems` now checks: is this a plain "send everything" call (no `course_number`/`item_ids`), is it the order's first-ever send, and is `auto_fire_first_course` + `send_by_course` both on for a non-`happy_bar` venue? If so, it fires course 1 instead of every pending item, using the same fire-bookkeeping steps as `coursesService.fireCourse`'s course-1 case, **inlined rather than imported** — `coursesService.ts` already imports `sendItemsCore` from `lifecycleService.ts`, so importing `fireCourse` back would create a circular dependency. The ~15 lines of duplicated bookkeeping are flagged in a code comment explaining why. Existing Phase 1 fixtures never set `send_by_course=true`, so this is unreachable in every prior test and carries zero regression risk.

### 8. Fire alerts (`src/modules/displays/serializers.ts` + `service.ts` + `routes.ts`)

`buildFireAlert` composes `headline` and `table_label` server-side (client never builds them), per the exact example JSON in the spec. `getEmbeddedFireAlerts` (unconditional, used inside the existing `GET /displays/kitchen`/`/bar` — naturally empty for a venue that can never fire a course) vs. `getFireAlerts` (gated, for the new standalone `GET /displays/kitchen/fire-alerts`) — both share the same `buildFireAlerts` query, just one skips the availability check since it's an additive field on an already-ungated route. New `POST /displays/fire-alerts/:id/ack` sets `fire_alert_acked_at`.

### 9. Docs

`docs/API.md` (new course-firing + fire-alert sections, including the note about `POST /orders/:id/send`'s new auto-fire behavior), `docs/ERRORS.md` (3 new codes + clarified what `MODIFIER_SELECTION_INVALID`'s neighbor `ITEM_ALREADY_SENT` now also covers for course moves), `docs/phase2/SCHEMA-ADDITIONS.md` (2c addendum to the `order_courses` section).

## Interpretation calls — flagged explicitly

- **`hold` semantics.** `CourseStatus` has no `held` value, so "only if nothing started" was interpreted as *un-firing*: revert `fired` → `pending`, its `sent` items back to `pending`, blocked (409 `COURSE_ALREADY_STARTED`, a new code — not named in the spec's short error list, but the rule needs some rejection code) once anything in the course has reached `preparing`/`ready`/`served`.
- **`reorder` payload — low confidence.** The spec gives no payload example for `POST /orders/:id/courses/reorder` (unlike the fully-specified fire-alert JSON), and it's absent from 2c.md's own test list and "Done when" criteria. Implemented as `{course_numbers: number[]}` — a full permutation of the order's existing course numbers, array position becomes the new number — clearly commented in both the code and `docs/API.md` as best-effort. **Untested** (no test in `tests/courseFiring.test.ts` covers it) — revisit if the real intended shape differs.
- **Fire alerts are venue-wide, not destination-split.** A course can contain both kitchen and bar items; the same alert (same `item_count`, the whole course) is surfaced identically on both `GET /displays/kitchen` and `/bar` for a `happy_hybrid` venue, rather than trying to split "kitchen's share" vs "bar's share" of one course. The spec's "bar display shows fire alerts only on happy_hybrid" line falls out of this naturally — `happy_bar` can never fire a course at all, so its bar display's `fire_alerts` is always `[]`.
- **Empty/already-fired course fire is a no-op success**; already-pending course hold is likewise a no-op success. Neither is specified either way; picked over erroring since there's no actual invalid state in either case.
- **No row for the previous course** (nothing was ever assigned to it) is treated as vacuously "served" for the `course_fire_requires_previous_served` gate — there's nothing to wait on.

## Errors and fixes (this session)

- **Two `venueId`-missing bugs caught by the venue-scope guard itself**, both in the same shape: `tx.orderItem.updateMany({ where: { id: { in: [...] } }, ... })` inside `coursesService.fireCourse` and the mirrored inline block in `lifecycleService.sendItems`'s auto-fire path — both fixed by adding `venueId` to the `where`. Found immediately by `tests/courseFiring.test.ts` throwing `venueScope violation: OrderItem.updateMany ran without a venue_id filter` on first run, which is exactly the guard doing its job (see item 1 above for why it wasn't catching `OrderCourse` calls in this same code — it was, and does now).
- **Test fixture missing `requireTableForOrder: false`** — every `createOrder` call in `tests/courseFiring.test.ts` failed with `TABLE_REQUIRED_FOR_ORDER` until this was added to the fixture's settings (schema default is `true`); same omission existed in the `happy_bar` fixture too.
- **`destroyVenue` test-teardown helper didn't delete `areas`/`restaurant_table` rows** — the "headline correct" test is the only one that creates a table, and cleanup failed with a RESTRICT foreign-key violation on `venues` until the teardown helper was extended to delete those first.
- **My own test bug**: the counter-order headline test originally added "Main Dish" to course 1, then asserted the headline said "MAINS" — but the course *name* comes from `settings.course_names[course_number]`, not the menu item's name; course 1 is "Starters" regardless of which item is in it. Fixed by moving that item to course 2.

## Tests

`tests/courseFiring.test.ts` (new, 18 tests) — availability gate (both venue-type and setting-off branches), fire moves only that course, `destination='none'` skip-to-served, empty-course no-op, re-fire idempotency, `course_name_snapshot` survives a rename, move-item-between-courses (allowed pending / blocked after fire), previous-served gate on/off, hold (reverts fired-but-untouched / blocked once started), `auto_fire_first_course` on/off, fire-alert headline for both table and counter orders, alert expiry (via a direct `fired_at` backdate rather than a real sleep), ack removing an alert from the feed, embedded `fire_alerts` staying empty for a `happy_bar` venue.

Full suite: 19 files, 477 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

2d-i (per `docs/phase2/2d-i.md`, not yet read this session). This session did not touch split-bill, merge, payments, or shifts — `order_courses`/course-firing is now a complete, tested surface but everything downstream of it (kitchen display grouping by course, if the frontend needs updating) is out of this backend session's scope.
