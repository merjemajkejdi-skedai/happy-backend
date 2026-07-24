# Phase 2 Session 2a-i — Foundation Migration

**Scope**: Database only. No routes, no services, no business logic (with one
narrow, necessary exception — see "Deviations from database-only scope"
below).

## What was implemented

1. **8 new enums** in `prisma/schema.prisma`: `modifier_pricing`,
   `course_status`, `split_type`, `void_status`, `void_stage`,
   `payment_method`, `stock_mode`, `shift_status`. Added `'merged'` to the
   existing `order_status` enum.
2. **`restaurant_settings`** extended with all Phase 2 columns across the 8
   spec'd groups (modifiers/courses/split/merge/voids/stock/payments/shifts),
   all defaulted so every existing venue's Phase 1 behavior is unchanged.
   `allow_order_merge` → `merge_tables_enabled` and `require_reason_on_void`
   → `void_reason_required` migrated with a data-copy `UPDATE` before the old
   columns were dropped.
3. **Existing tables extended**: `modifier_groups` (+ `pricing_mode`,
   `applies_to_destination`, `display_style`, `is_active`, + 2 hand-added
   `CHECK` constraints), `modifier_options` (+ `is_default`, `stock_tracked`,
   `tier_prices`), `order_items` (+ `course_number`, `course_fired_at`,
   `seat_number`, `split_from_order_id`, `original_order_item_id`,
   `void_id`), `orders` (+ `parent_order_id`, `split_type`,
   `split_sequence`, `merged_into_order_id`, `merged_at`,
   `merged_by_user_id`, `shift_id`, `business_date`, `amount_paid`,
   `amount_due`, `current_course_fired`).
4. **8 new tables**: `shifts`, `order_courses`, `restaurant_void_log`,
   `menu_item_stock`, `stock_movements`, `payments`, `shift_reports`,
   `approval_requests` — full definitions in
   [`SCHEMA-ADDITIONS.md`](./SCHEMA-ADDITIONS.md). The two FKs deferred
   during step 3 (`orders.shift_id`, `order_items.void_id`) are wired now
   that their target tables exist.
5. **Relaxed `orders_active_table_key`** to exclude split-bill child orders
   (`parent_order_id IS NOT NULL`). Both required tests written *before* the
   migration existed (TESTS FIRST): `tests/activeOrderIndex.test.ts`.
6. **Seed data** extended: per-venue Phase 2 settings differentiation (see
   table in `SCHEMA-ADDITIONS.md`), a `manager` and `bar` user added to
   every venue (PINs `4444`/`5555`), one `open` shift per venue for today.
7. Migration file:
   `prisma/migrations/20260724132532_phase2_foundation/migration.sql`
   (hand-finalized from a `prisma migrate diff` base — this environment
   can't run `prisma migrate dev` interactively, so the diff was generated
   non-interactively, then hand-edited to insert the settings data-copy
   `UPDATE` and append all hand-added `CHECK`/partial-index SQL, then
   applied with `prisma migrate deploy`).

## Deviations from database-only scope (and why)

The prompt's own premise that `require_reason_on_void` was "unimplemented"
(section 3) was **wrong** — it's read live by
`orderItemsService.voidItem` (`src/modules/orders/orderItemsService.ts:322`)
and asserted on by a real Phase 1 test. Dropping the column without fixing
that read site would have broken `ts-node` compilation (the dev server
wouldn't boot) and silently broken void-reason enforcement at runtime under
`vitest` (esbuild doesn't type-check). Since "the full Phase 1 test suite is
still green" is this session's own explicit DONE WHEN bar, I made the
minimal, mechanical fix required to keep that true:

- `src/modules/orders/orderItemsService.ts:322` — renamed the one read from
  `settings.requireReasonOnVoid` to `settings.voidReasonRequired`. Same
  field, same semantics, 1:1 rename. No new business logic.
- `src/modules/settings/service.ts` — removed `allowOrderMerge` and
  `requireReasonOnVoid` from `EDITABLE_FIELDS` (the PATCH whitelist), since
  those columns no longer exist. **Did not** add any of the ~35 new Phase 2
  settings fields to that whitelist — exposing them via `PATCH /settings` is
  genuine route/service work for whichever session implements the feature
  each belongs to, not this one. (I drafted that addition once, then
  reverted it on reflection — worth knowing so the next session doesn't
  assume it was considered and rejected for a substantive reason; it just
  wasn't this session's job.)
- `tests/orders.test.ts`, `tests/orderLifecycle.test.ts` — removed the two
  fixture lines referencing the dropped Phase 1 column names (these were
  setup-only, not assertions; no test behavior changed).
- `prisma/seed.ts`'s `upsertUser` helper — fixed a **pre-existing** bug
  (not introduced this session): its "find existing user" lookup didn't
  filter `deletedAt: null`, so venues with accumulated soft-deleted
  duplicate rows (happy-hybrid had ~25, dated across five days of earlier
  sessions) could match a stale deleted row and fail updating its email to
  one the real active row already held. This is exactly what blocked
  seeding `manager`/`bar` on happy-hybrid. Full detail in
  `SCHEMA-ADDITIONS.md`'s seed section.
- Cleaned up one piece of stale dev-DB debris unrelated to Phase 2: a
  leftover `draft` order occupying `happy-resto`'s table 1 from a much
  earlier session, which blocked the pre-existing (and, it turns out, never
  previously executed — its file's `beforeAll` was broken until the fix
  above) `orderLifecycle.test.ts` "Send-by-course on happy-restaurant" test.
  Cancelled via the real `POST /orders/:id/cancel` route (so it went through
  the real audit log, not a raw SQL edit) and freed the table via
  `PATCH /tables/:id/status`.

Everything else stayed strictly schema/migration/seed — no route, no new
service logic, nothing implementing any of the new columns' actual behavior.

## What was deferred and why

- **Everything behavioral.** No route reads `send_by_course`, no service
  computes `void_value`, no endpoint creates a `payment` row, etc. — that's
  the explicit job of later Phase 2 sessions (2a-ii onward per the naming
  convention implied by the prompt).
- **`PATCH /settings` whitelist** doesn't expose any of the ~35 new settings
  fields yet — see "Deviations" above.
- **`src/shared/openapi.ts`** (hand-authored OpenAPI 3.1 spec) still
  documents the two removed field names (`allowOrderMerge` line ~100,
  `requireReasonOnVoid` line ~111). `tests/openapiSpec.test.ts` doesn't
  check field names against the live Prisma model, so nothing failed, but
  the spec is now stale. Whichever session next touches the settings route
  contract should fix this alongside actually wiring up the new fields.
- **manager/bar roles**: users exist in every venue now, but
  `ALLOWED_ROLES` in `src/modules/users/service.ts` still rejects creating
  them via the API, and `src/shared/permissions.ts` still gives both roles
  empty permission sets. Seed data only — no permission/route wiring this
  session (that's "2a-ii" per this session's own header comments in the
  seed script, following the naming convention implied by "2a-i").

## Tests — final state

`npx vitest run`: **13 files / 200 tests, all passing.**

New this session: `tests/activeOrderIndex.test.ts` (2 tests, both required by
the prompt, both passing) — uses a dedicated disposable venue
(`test-active-order-index-fixture`), never the shared seed venues, with a
fresh table per test to avoid cross-test collisions on the partial index
being tested.

Fixed this session (pre-existing test fixtures broken by the column
removal, now passing again): `tests/orders.test.ts`, `tests/orderLifecycle.test.ts`.

## Exact starting point for the next session

- Migration `20260724132532_phase2_foundation` is applied to the local dev
  DB. `npx prisma generate` has been run — the client at
  `src/generated/prisma` reflects the full Phase 2 schema.
- `docs/SCHEMA.md` (Phase 1) is unchanged/still authoritative for
  everything it already documented except the two renamed settings fields —
  cross-reference `SCHEMA-ADDITIONS.md` for those two.
- All new columns are present and defaulted but **inert** — safe for a
  route/service session to start consuming immediately without any further
  schema work, except:
  - `restaurant_void_log`'s `order_id`/`order_item_id` and
    `stock_movements.order_item_id` are deliberately **not** foreign keys —
    don't add `@relation` to them later without re-reading why (survives
    deletion; see `SCHEMA-ADDITIONS.md`).
  - `approval_requests.subject_id` is deliberately **not** a foreign key
    (polymorphic) — same caution.
- If a future session needs to expose new settings fields via
  `PATCH /settings`, extend `EDITABLE_FIELDS` in
  `src/modules/settings/service.ts` then.
- `src/shared/openapi.ts` needs `allowOrderMerge`/`requireReasonOnVoid`
  removed (or renamed) whenever the settings route contract is next touched.
