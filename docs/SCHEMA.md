# Schema — Phase 1

Source of truth is [`prisma/schema.prisma`](../prisma/schema.prisma). Migrations
live in `prisma/migrations/`; the applied SQL for the initial migration is
[`20260720110115_init/migration.sql`](../prisma/migrations/20260720110115_init/migration.sql).

This document is a plain-English map of the schema and a list of the
constraints that aren't visible just by reading the Prisma models, because
Prisma has no declarative syntax for them (partial unique indexes, `CHECK`
constraints) — those are hand-appended SQL at the bottom of the migration
file, called out with comments there and cross-referenced below.

No routes or business logic exist yet. This is schema only.

## Conventions

- Every table has `id uuid primary key default gen_random_uuid()` unless the
  table lists an explicit composite primary key instead (`menu_item_modifier_groups`,
  `ticket_counters` — pure join/counter tables, no surrogate key).
- Every table has `created_at` / `updated_at timestamptz not null default now()`,
  except the two composite-PK tables above and `order_events` (append-only,
  no `updated_at` by design).
- Tables marked **soft-deletable** below also have `deleted_at timestamptz null`.
  Soft-deleted rows are never physically removed; queries are expected to
  filter `deleted_at IS NULL` themselves (Prisma doesn't do this automatically).
- All money columns are `numeric(10,2)`; percentages are `numeric(5,2)`.
- Foreign keys to `venues` default to `ON DELETE RESTRICT` (Prisma's default
  when no `onDelete` is specified) — a venue can't be hard-deleted while it
  still has staff, tables, menu items, or orders. In practice, soft-delete
  the venue (`deleted_at`) instead of trying to hard-delete it.

## Tables

### Auth & identity

| Table | Purpose |
|---|---|
| `venues` | One row per POS venue. Soft-deletable. Identity + branding fields only (name, slug, type, currency, timezone, locale, contact info) — no feature flags. `pms_*` columns exist for a future PMS integration but nothing reads them in Phase 1. |
| `restaurant_settings` | 1:1 with `venues`. **Every configurable behavior lives here** — login method, table/counter-service config, course/modifier toggles, kitchen/bar display config, void/send rules, and the `whatsapp_enabled` / `ai_enabled` / `pms_enabled` bolt-on flags (all default `false`). `extra jsonb` is an escape hatch that no business logic is allowed to read in Phase 1. |
| `users` | Staff accounts, soft-deletable. Login is PIN-based, email-based, or both — see the `users_login_credential_check` constraint below. `pin_lookup` is meant to hold an HMAC of the PIN (never the plaintext PIN or a directly-queryable hash) so a login attempt can find the candidate row before doing the real password/PIN verification. |
| `refresh_tokens` | One row per issued refresh token, referenced by its SHA-256 hash (`token_hash`), never the raw token. `revoked_at` supports early invalidation. |

### Floor plan

| Table | Purpose |
|---|---|
| `areas` | Named zones within a venue (e.g. "Terrace", "Bar", "Dining room"), soft-deletable. `default_destination` lets an area imply kitchen/bar routing for its tables. |
| `tables` | Physical tables, soft-deletable, optionally assigned to an `area`. Identified by `table_number` and/or `table_name` — see the CHECK constraint below. |

### Menu

| Table | Purpose |
|---|---|
| `menu_categories` | Soft-deletable. `default_destination` (kitchen/bar/none) and `default_course_number` are the fallback every item in the category inherits unless overridden. |
| `menu_items` | Soft-deletable. `is_active` (exists in the system) vs `is_available` (the "86" toggle — temporarily out of stock, doesn't require re-creating the item) are distinct on purpose. `sku` is optionally unique per venue. |
| `modifier_groups` / `modifier_options` | Soft-deletable. A group is `single` or `multiple` select, with `min_select`/`max_select` bounds; options carry a `price_delta`. |
| `menu_item_modifier_groups` | Join table, composite PK `(menu_item_id, group_id)`. `overrides_required` lets a specific item override a group's own `is_required` flag. No soft-delete, no timestamps — pure link row. |

### Orders

| Table | Purpose |
|---|---|
| `orders` | One row per check. `service_mode` (`table` or `counter`) determines whether `table_id` or `ticket_number` is required — enforced at the DB level, see below. Only one active order per table at a time is also DB-enforced. Totals (`subtotal`, `tax_total`, `service_charge_total`, `grand_total`) are computed server-side once routes exist; `discount_total` stays `0` in Phase 1. Not soft-deletable — cancellation is a `status` transition (`cancelled`) with `cancelled_at`/`cancel_reason`, not a delete. |
| `order_items` | Everything about the menu item is **snapshotted at insert** (`item_name_snapshot`, `category_name_snapshot`, `unit_price_snapshot`, `destination_snapshot`, `tax_rate_snapshot`) so later menu edits never retroactively change a placed order. `menu_item_id` is kept only as a soft reference (`ON DELETE SET NULL`). |
| `order_item_modifiers` | Same snapshot pattern for modifiers applied to a line item (`group_name_snapshot`, `option_name_snapshot`, `price_delta_snapshot`). |
| `order_events` | **Append-only audit log.** One row per order state change; no `updated_at`, and application code must never `UPDATE`/`DELETE` a row here. `venue_id` is intentionally a plain column with no foreign key (unlike every other `venue_id` in this schema, which is a real FK) — it's denormalized purely for query convenience on an audit table that's expected to outlive some of its relations. |
| `ticket_counters` | Composite PK `(venue_id, business_date)`. Tracks the last-issued order number and counter-service ticket number per venue per day, so numbering can reset daily without a race-prone `MAX()` query. |

## Enums

`venue_type`, `user_role` (`manager`/`bar` defined but unused by any route in Phase 1), `login_method`, `table_naming`, `service_mode`, `destination`, `table_status`, `order_status`, `order_item_status`, `modifier_type` — see `prisma/schema.prisma` for the exact value lists. All are native Postgres enum types (not `text` + `CHECK`).

## Extensions

- `pgcrypto` — for `gen_random_uuid()` default values.
- `citext` — `users.email` is case-insensitive by type, not by convention (no `LOWER()` calls needed anywhere it's compared).

## Non-obvious constraints (hand-added, not visible in the Prisma schema)

Prisma has no declarative support for `CHECK` constraints or partial unique
indexes as of this version, so these are appended as raw SQL at the bottom
of the migration file rather than expressed in `schema.prisma`. If the
schema is ever regenerated from scratch (`prisma migrate dev`), this block
must be re-added by hand — it will not survive a fresh `prisma db pull` or
schema-drift resolution.

- **`users_login_credential_check`** — `(email IS NOT NULL AND password_hash IS NOT NULL) OR pin_hash IS NOT NULL`. A user needs either a full email+password pair or a PIN; a bare PIN with no email is fine (typical waiter account), but a bare email with no password is not.
- **`users_venue_id_email_key`**, **`users_venue_id_pin_lookup_key`** — partial unique indexes, `WHERE email IS NOT NULL` / `WHERE pin_lookup IS NOT NULL`. A plain Postgres `UNIQUE(venue_id, email)` would already tolerate multiple `NULL` emails (Postgres treats `NULL <> NULL` in unique constraints), so the `WHERE` clause here is about intent/documentation as much as behavior — but it's written explicitly to match spec.
- **`tables_identifier_check`** — `table_number IS NOT NULL OR table_name IS NOT NULL`. A table must be identifiable by number, name, or both.
- **`tables_venue_id_table_number_key`**, **`tables_venue_id_table_name_key`** — partial unique indexes, each `WHERE ... IS NOT NULL AND deleted_at IS NULL`. Unlike the `users` case above, this one *does* change behavior: a soft-deleted table (`deleted_at` set) frees up its number/name for reuse by a new table, while two *active* tables can never share a number or a name. Verified directly: two soft-deleted rows with `table_number = 5` coexist fine; a second *active* row with `table_number = 5` is rejected.
- **`areas_venue_id_name_key`**, **`menu_categories_venue_id_name_key`** — same pattern, `WHERE deleted_at IS NULL`: unique active name per venue, soft-deleted rows don't collide.
- **`menu_items_price_check`** — `price >= 0`.
- **`order_items_quantity_check`** — `quantity > 0`.
- **`orders_service_mode_check`** — `(service_mode = 'table' AND table_id IS NOT NULL) OR (service_mode = 'counter' AND ticket_number IS NOT NULL)`. A table-service order must reference a table; a counter-service order must have a ticket number. One or the other, never neither, never a mismatch.
- **`orders_active_table_key`** — partial unique index on `orders(table_id)`, `WHERE table_id IS NOT NULL AND status IN ('draft', 'open', 'sent', 'partially_served', 'served')`. This is the DB-level guarantee that a table can have at most one *active* order at a time — once an order reaches `closed` or `cancelled`, the table frees up and a new order can be opened against it. Without the `status IN (...)` filter this would incorrectly block re-opening a table after a previous order closed.
- **`orders_venue_id_idempotency_key_key`**, **`order_items_order_id_idempotency_key_key`** — partial unique indexes, `WHERE idempotency_key IS NOT NULL`, added in the orders-core migration. Back the `Idempotency-Key` header on `POST /orders` (scoped per venue) and `POST /orders/:id/items` (scoped per order): a retried request with the same key hits this constraint, which the route layer catches and turns into "return the original resource" instead of a duplicate.

## What's deliberately not enforced yet

- No trigger keeps `orders.subtotal`/`grand_total` in sync with its `order_items` — that's business logic for the routes layer, not the schema.
- No trigger auto-updates `updated_at` on raw SQL writes; Prisma's `@updatedAt` only fires when a write goes through Prisma Client.
- `restaurant_settings.extra` and the `pms_*` / `whatsapp_config` / `ai_config` JSON columns are unstructured on purpose — Phase 1 doesn't validate their shape because nothing reads them yet.
