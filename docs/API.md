# API route table

Base path: `/api/v1`. Every route requires a Bearer access token (`authenticate` + `venueScope`) except the five on the public allowlist below — see `tests/routeSecurity.test.ts`, which walks the live Express app and fails if a future route is added without one or the other. Full machine-readable contract: `GET /api/v1/openapi.json` (also snapshotted at [`docs/openapi.json`](openapi.json)). Error codes: [`docs/ERRORS.md`](ERRORS.md). Schema: [`docs/SCHEMA.md`](SCHEMA.md).

## Public (no token required)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check. |
| POST | `/auth/login/pin` | Log in with `venue_slug` + `pin`. Rate-limited: 10/min per `(venue_slug, ip)`. |
| POST | `/auth/login/email` | Log in with `venue_slug` + `email` + `password`. Rate-limited: 10/min per `(venue_slug, ip)`. |
| POST | `/auth/refresh` | Rotate an access/refresh token pair. Reuse of an already-rotated refresh token revokes the whole session chain. |
| GET | `/auth/venue-config?slug=` | Public venue lookup (`login_method`/`locale`/`currency` only) — what a client needs before it has credentials. |
| GET | `/openapi.json` | This API's OpenAPI 3.1 document. |

## Auth

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/auth/logout` | (any authenticated user) | Revoke a refresh token. Requires a valid access token, unlike `/refresh`. |
| GET | `/auth/me` | (any authenticated user) | Current user + venue + settings. |

## Venue

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/venue` | (any authenticated role) | Venue identity fields. `pms_*` omitted unless `pms_enabled`. | — |
| PATCH | `/venue` | `venue.write` | Update name/timezone/currency/locale/address/phone/is_active — `venue_type` isn't editable. | — |

## Settings

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/settings` | (any authenticated role) | Full `restaurant_settings` row. `whatsapp_config`/`ai_config`/`pms_room_charge_enabled` omitted unless their flag is on. |
| PATCH | `/settings` | `settings.write` | Update any subset of settings, validated against the merged current+patch state (e.g. `happy_bar` venues can never have `courses_enabled=true`). |

## Users

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/users` | `user.manage` | List staff, filterable by `role`/`is_active`, paginated. |
| POST | `/users` | `user.manage` | Create a staff account — `role` restricted to `waiter`/`kitchen`/`admin` in Phase 1. |
| GET | `/users/{id}` | `user.manage` | Get a staff account. |
| PATCH | `/users/{id}` | `user.manage` | Update a staff account. An admin can't deactivate their own account. |
| DELETE | `/users/{id}` | `user.manage` | Soft-delete. Releases the user's email/PIN for reuse by a future hire. An admin can't delete their own account. |
| POST | `/users/{id}/reset-pin` | `user.manage` | Reset a user's PIN. |
| POST | `/users/{id}/reset-password` | `user.manage` | Reset a user's password — requires the user to have an email on file. |

## Areas

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/areas` | (any authenticated role) | List areas, paginated. |
| POST | `/areas` | `table.write` | Create an area. |
| PATCH | `/areas/{id}` | `table.write` | Update an area. |
| DELETE | `/areas/{id}` | `table.write` | Soft-delete — pass `?reassign_to=<area_id>` if it has active tables. |

## Tables

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/tables` | (any authenticated role) | List tables, filterable by `area_id`/`status`, paginated. Includes `display_label` and the active order summary. |
| POST | `/tables` | `table.write` | Create a table — identifier requirement depends on `table_naming_mode`. |
| POST | `/tables/bulk` | `table.write` | Bulk-create a numeric range (max 500). |
| GET | `/tables/{id}` | (any authenticated role) | Get a table. |
| PATCH | `/tables/{id}` | `table.write` | Update a table. |
| DELETE | `/tables/{id}` | `table.write` | Soft-delete — blocked if it has an active order. |
| PATCH | `/tables/{id}/status` | `table.status` | Set a table's status directly (e.g. mark clean after bussing). |

## Menu

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/menu` | (any authenticated role) | Full active menu tree in one call — the endpoint the POS caches at login. Returns `menu_version`/ETag. | — |
| GET | `/menu/categories` | (any authenticated role) | List categories, paginated. | — |
| POST | `/menu/categories` | `menu.write` | Create a category. `default_destination` validated against `venue_type`; `default_course_number` requires `courses_enabled`. | `venue_type`, `courses_enabled` |
| PATCH | `/menu/categories/{id}` | `menu.write` | Update a category. | `venue_type`, `courses_enabled` |
| DELETE | `/menu/categories/{id}` | `menu.write` | Soft-delete — 409 if it has active items. | — |
| GET | `/menu/items` | (any authenticated role) | List items, filterable by `category_id`/`is_available`/`search`, paginated. | — |
| POST | `/menu/items` | `menu.write` | Create an item — `destination`/`course_number` inherit from the category unless overridden. | `venue_type`, `courses_enabled` |
| GET | `/menu/items/{id}` | (any authenticated role) | Get an item. | — |
| PATCH | `/menu/items/{id}` | `menu.write` | Update an item. | `venue_type`, `courses_enabled` |
| DELETE | `/menu/items/{id}` | `menu.write` | Soft-delete. | — |
| PATCH | `/menu/items/{id}/availability` | `menu.availability` (waiter, kitchen, admin) | The "86" toggle. | — |
| POST | `/menu/items/{id}/modifier-groups` | `menu.write` | Replace the full set of modifier groups attached to this item. | — |
| GET | `/menu/modifier-groups` | (any authenticated role) | List groups with their options, paginated. | `modifiers_enabled` (informational — not enforced server-side in Phase 1) |
| POST | `/menu/modifier-groups` | `menu.write` | Create a group — `min_select`/`max_select` validated against `type`/`is_required`. | — |
| PATCH | `/menu/modifier-groups/{id}` | `menu.write` | Update a group. | — |
| DELETE | `/menu/modifier-groups/{id}` | `menu.write` | Soft-delete. | — |
| POST | `/menu/modifier-groups/{id}/options` | `menu.write` | Add an option. | — |
| PATCH | `/menu/modifier-options/{id}` | `menu.write` | Update an option. | — |
| DELETE | `/menu/modifier-options/{id}` | `menu.write` | Soft-delete. | — |

## Orders — core

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/orders` | (any authenticated role) | List orders, filterable by `status`/`table_id`/`service_mode`/`mine`/`date`, paginated. | — |
| POST | `/orders` | `order.create` | Create an order (table or counter mode). `Idempotency-Key` aware. | `require_table_for_order`, `counter_service_enabled` |
| GET | `/orders/{id}` | (any authenticated role) | Full order — items with modifiers, `table_display_label`, `opened_by_name`, totals. `pms_*` omitted unless `pms_enabled`. | — |
| PATCH | `/orders/{id}` | `order.create` | Update `guest_count`/`customer_name`/`notes` only. | — |
| POST | `/orders/{id}/items` | `order.create` | Add an item — snapshots the menu at insert time so later menu edits never touch this order. `Idempotency-Key` aware. | `allow_free_text_notes`, `courses_enabled` |
| PATCH | `/orders/{id}/items/{itemId}` | `order.create` | Update quantity/notes/modifiers — only while the item is `pending`. | `allow_free_text_notes` |
| DELETE | `/orders/{id}/items/{itemId}` | `order.create` (+ `order.void_after_send` once sent) | Void an item — any waiter while pending; admin-only once sent, and only if `allow_item_void_after_send`. | `allow_item_void_after_send`, `require_reason_on_void` |

## Orders — lifecycle

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| PATCH | `/orders/{id}/items/{itemId}/serve` | `order.serve` | Mark one `ready` item `served`. | — |
| POST | `/orders/{id}/send` | `order.send` | Send pending items to kitchen/bar — by course, by `item_ids`, or all. `destination: 'none'` items skip straight to `served`. `Idempotency-Key` aware. | `courses_enabled` |
| POST | `/orders/{id}/transfer` | `order.transfer` | Move an order to a different table (counter orders too — sets `service_mode: 'table'`, keeps `ticket_number`). | `allow_table_transfer` |
| POST | `/orders/{id}/serve` | `order.serve` | Bulk-serve ready items — defaults to all ready items on the order. | — |
| POST | `/orders/{id}/close` | `order.close` | Close an order — blocked while any non-cancelled item is unserved. No payment handling in Phase 1. | — |
| POST | `/orders/{id}/cancel` | `order.create` (+ `order.cancel_sent` once anything sent) | Cancel an order and all its items. A waiter may only before the first send; admin-only after. `reason` mandatory. | — |
| GET | `/orders/{id}/events` | `order.events.read` (admin) | Paginated audit trail, newest first, actor names resolved. | — |

## Displays

Phase 1 is polling-only — no WebSockets/SSE. Response shape is locked (snake_case, unlike the rest of this API) so a future push-transport swap needs zero client changes.

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/displays/kitchen` | `display.view` | Kitchen tickets — `sent`/`preparing` items (+`ready` with `?include_ready=true`), filterable by `course_number`. | `kitchen_display_enabled` |
| GET | `/displays/bar` | `display.view` | Same, for `destination: 'bar'` items. | `bar_display_enabled` |
| GET | `/displays/recall` | `display.bump` | Items marked `ready` in the last 30 minutes, not yet served — for un-bumping a mistake. | — |
| PATCH | `/displays/items/{itemId}/status` | `display.bump` | Single valid-transition bump: `sent→preparing`, `sent→ready`, `preparing→ready`. | — |
| POST | `/displays/bump` | `display.bump` | Bulk transition to `ready` in one transaction. Explicit `order_item_ids` is all-or-nothing; `order_id` auto-resolves whatever's currently eligible. | — |
| POST | `/displays/items/{itemId}/recall` | `display.bump` | `ready → preparing`, clears `ready_at`. Rejects an already-served item. | — |

## Rate limiting

`POST /auth/login/pin` and `POST /auth/login/email` only: 10 requests/minute per `(venue_slug, ip)` pair (`429 RATE_LIMIT_EXCEEDED`). Independent of, and in addition to, the per-user `failed_login_count`/`locked_until` lockout.

## Idempotency

`POST /orders`, `POST /orders/:id/items`, and `POST /orders/:id/send` accept an `Idempotency-Key` header, scoped to `(venue_id, user_id, route, key)`. A replay within 24h of the original request returns the exact original response (status + body) without re-running the business logic; a concurrent duplicate gets `409 IDEMPOTENCY_IN_PROGRESS`. See `src/lib/idempotency.ts`.
