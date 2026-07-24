# Phase 2 Schema Additions

Source of truth is [`prisma/schema.prisma`](../../prisma/schema.prisma). The
foundation migration is
[`20260724132532_phase2_foundation/migration.sql`](../../prisma/migrations/20260724132532_phase2_foundation/migration.sql).
This document is the plain-English companion to that migration — written as
it was implemented in session **2a-i**, so later Phase 2 sessions have it
without re-deriving from source. Database only this session: no routes, no
services, no business logic read any of this yet (except the two mechanical
fixes noted in "Fallout fixed this session" below, which were required to
keep the Phase 1 suite green).

## New enums

| Enum | Values |
|---|---|
| `modifier_pricing` | `free`, `fixed`, `tiered` |
| `course_status` | `pending`, `fired`, `preparing`, `ready`, `served` |
| `split_type` | `equal`, `by_item`, `by_seat` |
| `void_status` | `pending_approval`, `approved`, `rejected`, `auto_approved` |
| `void_stage` | `before_send`, `after_send` |
| `payment_method` | `cash`, `card`, `bank_transfer`, `voucher`, `room_charge`, `other` |
| `stock_mode` | `none`, `count`, `daily_limit` |
| `shift_status` | `open`, `closed` |

`order_status` gained one new value: `merged`.

## `restaurant_settings` — new columns

All defaulted; Phase 1 behavior is unchanged for every venue until a later
session actually reads these. Grouped exactly as specified:

- **Modifiers**: `modifier_pricing_mode` (`modifier_pricing`, default `fixed`), `modifier_max_groups_per_item` (smallint, default 10), `require_modifier_validation` (boolean, default true).
- **Courses**: `send_by_course`, `course_names` (jsonb, default `["Starters","Mains","Desserts"]`), `auto_fire_first_course` (default true), `course_fire_requires_previous_served` (default false), `show_fire_alert_seconds` (default 30).
- **Split**: `split_bill_enabled`, `split_equal_enabled` (default true), `split_by_item_enabled` (default true), `split_max_ways` (smallint, default 8).
- **Merge**: `merge_tables_enabled`, `merge_requires_manager` (default true).
- **Voids**: `void_requires_approval`, `void_approval_role` (`user_role`, default `manager`), `void_before_send_requires_approval`, `void_reason_required` (default true — see "Two inert Phase 1 flags retired" below), `void_reason_preset_list` (jsonb, default 5 presets), `void_alerts_kitchen` (default true).
- **Stock**: `stock_tracking_mode` (`stock_mode`, default `none`), `stock_auto_86_at_zero` (default true), `stock_warn_threshold` (smallint, default 5), `allow_negative_stock` (default false), `eightysix_requires_manager` (default false), `eightysix_resets_daily` (default true).
- **Payments**: `payment_capture_enabled` (default true), `payment_methods_enabled` (jsonb, default `["cash","card"]`), `require_payment_to_close` (default false), `allow_partial_payment` (default true).
- **Shifts**: `shifts_enabled` (default true), `shift_auto_close_hours` (default 24), `business_day_start_hour` (smallint, default 5), `reports_visible_to_manager` (default true).

None of these are exposed via `PATCH /settings` yet (`EDITABLE_FIELDS` in
`src/modules/settings/service.ts` intentionally not extended this session —
that's route/service work for whichever session actually implements the
feature each group belongs to).

### Two inert Phase 1 flags retired

`allow_order_merge` → `merge_tables_enabled` and `require_reason_on_void` →
`void_reason_required`. Existing per-venue values were copied forward via an
`UPDATE` between the `ADD COLUMN`/`DROP COLUMN` steps in the migration, then
the old columns were dropped. These are the *only* Phase 1 settings columns
removed.

**Correction to this session's own premise**: the migration's driving spec
said both flags "were unimplemented." `allow_order_merge` was — no route or
service read it. `require_reason_on_void` was **not** —
`orderItemsService.voidItem` (`src/modules/orders/orderItemsService.ts:322`)
reads it directly to decide whether a void reason is required, and a live
Phase 1 test (`tests/orders.test.ts`, "Void rules with the flag on and off")
asserts on that exact behavior. Dropping the column without updating the
read site broke `voidItem` at compile time (`ts-node` failed to boot the
server) and silently broke it at runtime under `vitest` (esbuild doesn't
type-check, so the stale property access just evaluated to `undefined`,
turning "reason required" into "reason never required"). Fixed by renaming
the one read site to `settings.voidReasonRequired` — a mechanical 1:1
rename, not new business logic — since leaving it broken would have failed
this session's own "full Phase 1 test suite is still green" requirement.
**Nothing else in `require_reason_on_void`'s old behavior changed.**

`src/shared/openapi.ts` (hand-authored OpenAPI spec) still documents both
old field names (`allowOrderMerge` at line ~100, `requireReasonOnVoid` at
line ~111) — stale now, but `tests/openapiSpec.test.ts` doesn't check field
names against the live Prisma model, so nothing failed. Left as-is; flagging
for whichever session next touches the settings route contract to fix.

## Extended existing tables

**`modifier_groups`**: `+ pricing_mode` (`modifier_pricing`, default `fixed`), `+ applies_to_destination` (`destination`, nullable), `+ display_style` (text, default `'list'`), `+ is_active` (boolean, default true — didn't exist before). Two hand-added `CHECK` constraints (Prisma has no declarative support): `max_select IS NULL OR max_select >= min_select`, and `type <> 'single' OR max_select IS NULL OR max_select = 1`.

**`modifier_options`**: `+ is_default` (boolean, default false), `+ stock_tracked` (boolean, default false), `+ tier_prices` (jsonb, nullable).

**`order_items`**: `+ course_number` (smallint, nullable — the waiter's *assigned fire target*, distinct from the pre-existing `course_number_snapshot` which records what the menu said at add-time; **both are kept, never merge them**), `+ course_fired_at`, `+ seat_number`, `+ split_from_order_id` (FK → `orders`, nullable), `+ original_order_item_id` (self-FK, nullable), `+ void_id` (FK → `restaurant_void_log`, nullable — wired this session, see Creation order below).

**`orders`**: `+ parent_order_id` (self-FK, nullable — the split-bill parent/child link), `+ split_type` (`split_type`, nullable), `+ split_sequence` (smallint, nullable), `+ merged_into_order_id` (self-FK, nullable), `+ merged_at`, `+ merged_by_user_id` (FK → `users`), `+ shift_id` (FK → `shifts`, nullable — wired this session), `+ business_date` (date, nullable), `+ amount_paid` / `+ amount_due` (numeric(10,2), default 0), `+ current_course_fired` (smallint, nullable).

## New tables

None soft-deletable. All have `id uuid PK DEFAULT gen_random_uuid()` and
`created_at`/`updated_at timestamptz NOT NULL DEFAULT now()` unless noted.
Creation order in the migration: `shifts` first (referenced by
`restaurant_void_log` and `payments`), then the rest.

### `shifts`
One row per staff shift. `venue_id`, `business_date`, `name` (nullable),
`status` (`shift_status`, default `open`), `opened_at`/`opened_by_user_id`,
`closed_at`/`closed_by_user_id` (nullable), `opening_float` (numeric(10,2),
default 0), `closing_cash_counted`/`cash_variance` (nullable), `notes`.
**Partial unique index `shifts_venue_id_open_key` on `(venue_id) WHERE
status = 'open'`** is the DB-level enforcement of one open shift per venue —
do not rely on application logic alone for this.

### `order_courses`
Fire state per course per order — its own table because "which courses have
fired" can't be inferred from item timestamps when a course has zero items.
`venue_id`, `order_id` (FK → `orders`, `ON DELETE CASCADE`), `course_number`,
`course_name_snapshot` (copied from `settings.course_names` at row creation
— renaming courses later must not rewrite history), `status`
(`course_status`, default `pending`), `fired_at`/`fired_by_user_id`
(nullable), `first_ready_at`/`all_served_at` (nullable), `item_count`
(smallint, default 0). `UNIQUE(order_id, course_number)`. Index
`(venue_id, status, fired_at)`.

### `restaurant_void_log`
Standalone reporting table. `order_id` and `order_item_id` are **plain
denormalized columns with no foreign key** (same convention as
`order_events.venue_id`) — deliberately, so this table survives deletion of
either, and names/values are snapshotted for the same reason. Columns:
`venue_id`, `business_date`, `shift_id` (FK → `shifts`, nullable),
`order_id` (no FK), `order_number`, `order_item_id` (no FK),
`item_name_snapshot`, `category_name_snapshot`, `quantity`,
`unit_price_snapshot`, `void_value` (= `quantity * (unit_price_snapshot +
modifiers_total)`, computed by whichever service writes this row — not a
generated column), `destination_snapshot`, `stage` (`void_stage`), `status`
(`void_status`), `reason_code`/`reason_text` (nullable),
`requested_by_user_id`/`requested_by_name`,
`approved_by_user_id`/`approved_by_name` (nullable), `requested_at`,
`resolved_at` (nullable), `rejection_reason` (nullable),
`kitchen_notified_at` (nullable), `table_label_snapshot` (nullable). Indexes:
`(venue_id, business_date)`, `(venue_id, shift_id)`, and a hand-added
**partial** index `(venue_id, status) WHERE status = 'pending_approval'` for
fast pending-queue lookups.

### `menu_item_stock`
Separate from `menu_items` so per-order stock churn doesn't write to the
menu table. `menu_items.is_available` (Phase 1) stays the manual, non-dated
switch; `is_86ed` here is the dated, service-level switch — **both are
consulted, never conflated**. Columns: `venue_id`, `menu_item_id` (FK →
`menu_items`, `ON DELETE CASCADE`), `business_date`, `mode` (`stock_mode`),
`starting_quantity`/`current_quantity` (int, nullable),
`reserved_quantity` (default 0), `is_86ed` (default false),
`eightysixed_at`/`eightysixed_by_user_id`/`eightysix_reason` (nullable),
`restored_at` (nullable). `UNIQUE(menu_item_id, business_date)`. Index
`(venue_id, business_date, is_86ed)`.

### `stock_movements`
Append-only — **no `updated_at`**, rows are never modified (same convention
as `order_events`). Columns: `venue_id`, `menu_item_id` (FK →
`menu_items`), `business_date`, `delta` (int), `reason` (text — one of
`'order'`, `'void'`, `'manual_adjust'`, `'restock'`, `'day_open'`),
`order_item_id` (nullable, **no FK** — plain reference), `actor_user_id`
(FK → `users`, nullable), `balance_after` (int), `created_at`. Index
`(venue_id, menu_item_id, business_date)`.

### `payments`
Capture only — no processing, no gateway, no card data. `reference` holds a
voucher code, last-4 digits, or free text; **never** a full card number.
Columns: `venue_id`, `order_id` (FK → `orders`), `shift_id` (FK → `shifts`,
nullable), `business_date`, `method` (`payment_method`), `amount`
(numeric(10,2), hand-added `CHECK (amount > 0)`), `tip_amount` (default 0),
`received_amount`/`change_amount` (nullable), `reference` (nullable),
`taken_by_user_id`/`taken_by_name`, `is_voided` (default false),
`voided_by_user_id`/`voided_reason` (nullable). Indexes:
`(venue_id, business_date, method)`, `(order_id)`.

### `shift_reports`
Materialized snapshot so a closed shift's numbers never drift once
generated. `payload` (jsonb) holds the full computed report — **session
2h-i defines its structure; this session only created the column.** Columns:
`venue_id`, `shift_id` (FK → `shifts`, nullable), `period_start`/
`period_end` (timestamptz), `generated_at`/`generated_by_user_id`,
`payload` (jsonb, no default), `is_final` (default false). Indexes:
`(venue_id, period_start, period_end)`, `(shift_id)`.

### `approval_requests`
Generic by design — void approval is the only Phase 2 consumer; discount and
comp approvals land in Phase 3 without a schema change. `request_type` is
`'void'` in Phase 2; `subject_id` points at `restaurant_void_log.id` but is
**not a foreign key** (genuinely polymorphic across future `request_type`
values). Reuses `void_status` rather than defining a parallel enum. Columns:
`venue_id`, `request_type` (text), `subject_id` (uuid, no FK), `order_id`
(FK → `orders`, nullable), `status` (`void_status`, default
`pending_approval`), `requested_by_user_id`, `required_role` (`user_role`),
`resolved_by_user_id` (nullable), `requested_at`, `resolved_at` (nullable),
`expires_at` (nullable), `payload` (jsonb, default `{}`). Indexes:
`(request_type, subject_id)`, and a hand-added **partial** index
`(venue_id, status) WHERE status = 'pending_approval'`.

## Creation order / deferred FKs, now wired

Per the spec: `shifts` was created before `restaurant_void_log` and
`payments`, which reference it. The two FKs that section 4's column
additions deferred are now wired, since their target tables exist as of
this same session:
- `orders.shift_id` → `shifts.id` (`ON DELETE SET NULL`)
- `order_items.void_id` → `restaurant_void_log.id` (`ON DELETE SET NULL`)

## Relaxed the one-active-order-per-table index (section 6)

Split bill will create child orders (`parent_order_id IS NOT NULL`) on the
same table as their parent. The Phase 1 partial unique index
`orders_active_table_key` didn't know about this and would have rejected
every child order. Dropped and recreated to add `AND parent_order_id IS
NULL` to the `WHERE` clause:

```sql
CREATE UNIQUE INDEX "orders_active_table_key" ON "orders"("table_id")
  WHERE table_id IS NOT NULL
    AND parent_order_id IS NULL
    AND status IN ('draft', 'open', 'sent', 'partially_served', 'served');
```

Net effect: the **parent** order still occupies the index slot (it has
`parent_order_id IS NULL`), so two independent (parentless) orders on the
same table are still rejected exactly as in Phase 1. **Child** orders are
excluded from the index entirely, so any number of them can coexist with
each other and with their parent on the same table. Both halves of this are
covered by `tests/activeOrderIndex.test.ts` (written before the migration,
per this session's TESTS FIRST rule) — test (a) two independent orders still
conflict; test (b) a parent plus multiple children do not, and a second
independent order still does even with children present.

## Seed data (section 7)

Each venue now differs on the new settings groups so every group has at
least one non-default venue to test against:

| | happy-resto | happy-bar | happy-hybrid |
|---|---|---|---|
| `send_by_course` | true | false | true |
| `split_bill_enabled` | true | true | true |
| `split_equal_enabled` | true (default) | true | true |
| `split_by_item_enabled` | true (default) | **false** | true |
| `merge_tables_enabled` | false (default) | false (default) | **true** |
| `void_requires_approval` | true | false | false (default) |
| `stock_tracking_mode` | `count` | `none` (default) | `daily_limit` |

Every venue now also has a `manager` and a `bar` user (PINs `4444`/`5555`,
email `{role}@{slug}.test`, same `Passw0rd!` password as every other seeded
user) — creating them is data only; their permissions/routes activate in a
later Phase 2 session (2a-ii per the naming convention). One `open` shift
per venue, business date = today, opened by that venue's manager, named
`"Seed Shift"`. The seed script is idempotent — rerunning finds the
existing open shift via `findFirst({ status: 'open' })` rather than trying
to create a second one (which the partial unique index would reject anyway).

**Unrelated pre-existing bug fixed in `upsertUser`** (`prisma/seed.ts`):
the "find existing user to update" lookup didn't filter `deletedAt: null`,
so on a venue with accumulated soft-deleted duplicate rows (happy-hybrid had
~25, dated across five days of earlier sessions) it could non-deterministically
match a stale deleted row instead of the active one, then fail updating that
stale row's email to a value the *real* active row already held
(`P2002` on `(venue_id, email)`). This is exactly what happened seeding
`manager`/`bar` on happy-hybrid this session. Fixed by adding `deletedAt:
null` to the lookup, matching correct upsert semantics. Not a Phase 2
regression — the accumulated debris predates this session; the debris rows
themselves were left in place (harmless, already soft-deleted, not worth the
cleanup risk of touching historical rows for a cosmetic fix).
