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

All five roles (`waiter`/`kitchen`/`admin`/`manager`/`bar`) are assignable as
of session 2a-ii. A `manager` actor may only create/edit `waiter`/`kitchen`/
`bar` accounts — targeting (or promoting to) `manager`/`admin` returns 403
`INSUFFICIENT_ROLE_AUTHORITY`, enforced in the service layer for both
`POST /users` and both `PATCH` routes below.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/users` | `user.manage` | List staff, filterable by `role`/`is_active`, paginated. |
| GET | `/users/roles` | `user.manage` | Roles the current actor may assign — all five for admin, `waiter`/`kitchen`/`bar` for manager. |
| POST | `/users` | `user.manage` | Create a staff account. |
| GET | `/users/{id}` | `user.manage` | Get a staff account. |
| PATCH | `/users/{id}` | `user.manage` | Update a staff account. An admin can't deactivate their own account. |
| PATCH | `/users/{id}/role` | `user.manage` | Change a user's role only — same underlying logic and manager restriction as the general `PATCH /users/{id}`. |
| DELETE | `/users/{id}` | `user.manage` | Soft-delete. Releases the user's email/PIN for reuse by a future hire. An admin can't delete their own account. |
| POST | `/users/{id}/reset-pin` | `user.manage` | Reset a user's PIN. |
| POST | `/users/{id}/reset-password` | `user.manage` | Reset a user's password — requires the user to have an email on file. |

## Permissions (Phase 2, session 2a-ii)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/permissions` | (any authenticated role) | Resolved permission matrix + display scope for the current user's role and venue — settings-dependent resolution, not the static ceiling. What the frontend gates on. |

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
| GET | `/menu` | (any authenticated role) | Full active menu tree in one call — the endpoint the POS caches at login. Returns `menu_version`/ETag. Each item carries `isOrderable`/`stockRemaining` (Phase 2, session 2e — see below). | — |
| GET | `/menu/categories` | (any authenticated role) | List categories, paginated. | — |
| POST | `/menu/categories` | `menu.write` | Create a category. `default_destination` validated against `venue_type`; `default_course_number` requires `courses_enabled`. | `venue_type`, `courses_enabled` |
| PATCH | `/menu/categories/{id}` | `menu.write` | Update a category. | `venue_type`, `courses_enabled` |
| DELETE | `/menu/categories/{id}` | `menu.write` | Soft-delete — 409 if it has active items. | — |
| GET | `/menu/items` | (any authenticated role) | List items, filterable by `category_id`/`is_available`/`search`, paginated. Each item carries `isOrderable`/`stockRemaining`. | — |
| POST | `/menu/items` | `menu.write` | Create an item — `destination`/`course_number` inherit from the category unless overridden. | `venue_type`, `courses_enabled` |
| GET | `/menu/items/{id}` | (any authenticated role) | Get an item. | — |
| PATCH | `/menu/items/{id}` | `menu.write` | Update an item. | `venue_type`, `courses_enabled` |
| DELETE | `/menu/items/{id}` | `menu.write` | Soft-delete. | — |
| PATCH | `/menu/items/{id}/availability` | `menu.eightysix` (S) | The Phase 1 manual, non-dated "86" toggle (`menu_items.is_available`). | `eightysix_requires_manager` |
| POST | `/menu/items/{id}/86` | `menu.eightysix` (S) | Phase 2, session 2e — the dated, service-level 86 (`menu_item_stock.is_86ed` for today), distinct from the toggle above. `{reason?}`. Creates today's stock row if none exists yet. | `eightysix_requires_manager` |
| POST | `/menu/items/{id}/restore` | `menu.eightysix` (S) | Un-86 for today. Idempotent — a no-op success if not currently 86'd. | `eightysix_requires_manager` |
| PATCH | `/menu/items/{id}/stock` | `menu.stock` | `{starting_quantity}` (create-or-reset today's row, reason `manual_adjust`) or `{delta}` (adjust an existing row, reason `restock` if positive else `manual_adjust`). 422 `ITEM_NOT_STOCK_TRACKED` for `delta` with no existing row. | `stock_tracking_mode` |
| GET | `/menu/items/{id}/modifier-groups` | (any authenticated role) | Resolved groups + options + defaults attached to this item, in attachment sort order. | — |
| POST | `/menu/items/{id}/modifier-groups` | `menu.write` | Replace the full set of modifier groups attached to this item. 422 `MODIFIER_GROUP_LIMIT_EXCEEDED` past `modifier_max_groups_per_item`. | `modifier_max_groups_per_item` |
| GET | `/menu/modifier-groups` | (any authenticated role) | List groups with their options, paginated. `?include_inactive=true` also returns `is_active=false` groups (soft-deleted groups are never returned). | `modifiers_enabled` (informational — not enforced server-side) |
| POST | `/menu/modifier-groups` | `menu.write` | Create a group — `min_select`/`max_select` validated against `type`/`is_required`; `pricing_mode`/`applies_to_destination`/`display_style`/`is_active` accepted (Phase 2). `applies_to_destination` validated against `venue_type` like a category/item destination. | `venue_type` |
| PATCH | `/menu/modifier-groups/{id}` | `menu.write` | Update a group. | `venue_type` |
| DELETE | `/menu/modifier-groups/{id}` | `menu.write` | Soft-delete — 409 `MODIFIER_GROUP_HAS_ATTACHED_ITEMS` if still attached to an active menu item. | — |
| PATCH | `/menu/modifier-groups/{id}/reorder` | `menu.write` | Set `sort_order` positionally from the given `group_ids` array. | — |
| POST | `/menu/modifier-groups/{id}/duplicate` | `menu.write` | Copy a group's config and options into a new group named `"<name> (copy)"`. Does not copy item attachments. | — |
| POST | `/menu/modifier-groups/{id}/options` | `menu.write` | Add an option — `is_default`/`stock_tracked`/`tier_prices` accepted (Phase 2). `tier_prices` only accepted when the group's `pricing_mode='tiered'`. | — |
| PATCH | `/menu/modifier-options/{id}` | `menu.write` | Update an option. | — |
| DELETE | `/menu/modifier-options/{id}` | `menu.write` | Soft-delete. | — |

## Menu — stock (Phase 2, session 2e)

`is_orderable` = `is_active AND is_available AND NOT is_86ed AND (mode='none' OR current_quantity > 0 OR allow_negative_stock)`, computed once in `src/modules/menu/stockService.ts` and applied on every item response — no client recomputes it. `stock_remaining` is `null` when the item has never been stock-tracked (mode `'none'` or no row at all). The order-time decrement is atomic (a single conditional `UPDATE ... WHERE current_quantity >= $qty ... RETURNING`, never a read-then-write) — see `docs/phase2/SESSION-2e.md` for why that matters. Two routes below (`bulk-set` payload shape, `day-open` semantics) had no example/spec text to follow and are flagged there as best-effort.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/menu/stock` | `menu.view` | Stock rows for `?business_date` (default today). No permission was named for this route in the session spec — gated the same as other menu reads. |
| GET | `/menu/stock/movements` | `reports.view` | Paginated `stock_movements`, filterable by `?menu_item_id&from&to`. |
| GET | `/menu/stock/low` | `menu.view` | Today's rows at or below `stock_warn_threshold`. |
| POST | `/menu/stock/bulk-set` | `menu.stock` | `{items: [{menu_item_id, starting_quantity}]}` — best-effort payload shape, see `docs/phase2/SESSION-2e.md`. |
| POST | `/menu/stock/day-open` | `menu.stock` | `{business_date?}`, idempotent. Only carries forward items that have ever had a stock row before, seeded from each one's most recent `starting_quantity` — never invents a quantity for a never-tracked item. `is_86ed` resets unless `eightysix_resets_daily=false`. |

## Orders — core

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/orders` | (any authenticated role) | List orders, filterable by `status`/`table_id`/`service_mode`/`mine`/`date`, paginated. | — |
| POST | `/orders` | `order.create` | Create an order (table or counter mode). `Idempotency-Key` aware. | `require_table_for_order`, `counter_service_enabled` |
| GET | `/orders/{id}` | (any authenticated role) | Full order — items with modifiers, `table_display_label`, `opened_by_name`, totals. `pms_*` omitted unless `pms_enabled`. | — |
| PATCH | `/orders/{id}` | `order.create` | Update `guest_count`/`customer_name`/`notes` only. | — |
| POST | `/orders/{id}/items` | `order.create` | Add an item — snapshots the menu at insert time so later menu edits never touch this order. `price_delta_snapshot` for each modifier is resolved via `resolveModifierPrice` (free/fixed/tiered), never the raw stored `price_delta`. `Idempotency-Key` aware. | `allow_free_text_notes`, `courses_enabled`, `require_modifier_validation` |
| PATCH | `/orders/{id}/items/{itemId}` | `order.create` | Update quantity/notes/modifiers — only while the item is `pending`. | `allow_free_text_notes`, `require_modifier_validation` |
| PATCH | `/orders/{id}/items/{itemId}/modifiers` | `order.create` | Replace an item's modifier selections only — only while `pending`, otherwise 409 `ITEM_ALREADY_SENT`. Revalidates and recomputes totals. | `require_modifier_validation` |
| DELETE | `/orders/{id}/items/{itemId}` | `order.void` | **Phase 2, session 2d-i:** legacy void route, now routed through the same request/approve flow as `POST .../void` below — `reason` maps to `reason_text`. Returns 202 (not cancelled yet) if a request is queued, 200 `{deleted:true}` if resolved immediately. | `void_reason_required`, `void_before_send_requires_approval`, `void_requires_approval` |

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

## Orders — void request/approval (Phase 2, session 2d-i)

Replaces Phase 1's void behavior entirely (including on the legacy `DELETE /orders/:id/items/:itemId` route above). `resolveVoidPolicy` (`src/modules/orders/voidPolicy.ts`) decides `stage` (`before_send` if the item is still `pending`, else `after_send`), `requires_approval` from the matching settings flag, and `auto_approve` from whether the actor's role satisfies `void_approval_role` (only `manager`/`admin` ever can). A manager never queues for themselves when `void_approval_role='manager'` (the default). Every outcome writes `restaurant_void_log` — see `docs/SCHEMA.md`/`docs/phase2/SCHEMA-ADDITIONS.md`.

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| POST | `/orders/{id}/items/{itemId}/void` | `order.void` | Request (or, if no approval is needed, immediately execute) a void. `{reason_code, reason_text}` — at least one required when `void_reason_required`. 202 with the void record if queued for approval, 200 if resolved immediately. `Idempotency-Key` aware. | `void_reason_required`, `void_before_send_requires_approval`, `void_requires_approval`, `void_approval_role` |
| GET | `/voids/pending` | `void.approve` | Manager/admin approval queue — paginated `restaurant_void_log` rows with `status='pending_approval'`. | — |
| POST | `/voids/{id}/approve` | `void.approve` | Cancels the item, sets `void_id`, recomputes order totals, resolves the matching `approval_requests` row. | — |
| POST | `/voids/{id}/reject` | `void.approve` | `{rejection_reason}` — item stays live and untouched; the void log is still resolved (`status='rejected'`) for reporting. | — |
| GET | `/voids` | `reports.view` | All void log rows, filterable by `?from&to` (business_date), `?status`, `?user_id`, paginated. | — |
| GET | `/voids/{id}` | `reports.view` | A single void log row. | — |

## Orders — split equal (Phase 2, session 2f-i)

Requires `split_bill_enabled` AND `split_equal_enabled`, else 403 `SPLIT_MODE_DISABLED`. Items stay on the parent order; each child receives one synthetic line item (`item_name_snapshot: 'Split N of M'`, `menu_item_id: null`, `destination_snapshot: 'none'`) whose price is that child's exact share of the parent's `grand_total` (remainder-to-child-1 rounding — shares always sum exactly). Blocked once `amount_paid > 0` on the order in question (409 `ORDER_ALREADY_PAID`).

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| POST | `/orders/{id}/split` | `order.split` | `{split_type: 'equal', ways}` — `ways` between 2 and `split_max_ways` (422 `SPLIT_WAYS_INVALID` otherwise). Creates `ways` child orders (own `order_number`/`ticket_number`, `parent_order_id`, `split_type='equal'`, `split_sequence` 1..n), each `status='served'` since the synthetic item needs no kitchen/bar prep. One transaction — any failure rolls back all children. Returns the array of created child orders. `Idempotency-Key` aware (covers all three `split_type` modes). | `split_bill_enabled`, `split_equal_enabled` |
| GET | `/orders/{id}/splits` | `order.view_own` | The child orders for a given parent, ordered by `split_sequence`. | — |
| POST | `/orders/{id}/splits/{childId}/merge-back` | `order.split` | Undo — only while the child is unpaid (409 `ORDER_ALREADY_PAID` otherwise). Deletes the child order (its synthetic item cascades), then recomputes the parent (a no-op in practice, since the parent's own items were never touched by the split). | — |

## Orders — split by item / by seat (Phase 2, session 2f-ii)

Requires `split_bill_enabled` AND `split_by_item_enabled`, else 403 `SPLIT_MODE_DISABLED` (`by_seat` shares this flag — it is "a convenience over `by_item`," not a separate setting). Blocked once `amount_paid > 0` (409 `ORDER_ALREADY_PAID`) or the order is `closed`/`cancelled` (409 `ORDER_NOT_MODIFIABLE`). Unlike equal split, real items MOVE to the child (`order_id` reassigned in place) — every snapshot, status, and timestamp is preserved exactly, so a moved item keeps its kitchen state. `split_from_order_id` records the order the item most recently moved out of; `original_order_item_id` is set once, on an item's first-ever move, and never overwritten again. Parent and every child are recomputed from their own items through the normal totals formula (real `tax_rate_snapshot` per item, not the already-taxed-share trick equal split uses) — the sum across parent and children always equals the original parent total. `order_courses` rows are lazily created on a child the moment one of its items carries a course number (the same mechanism `recomputeOrder` already uses everywhere); an empty, never-fired course row left behind on the parent is deleted, but a fired one is kept regardless of its item count.

`POST /orders/:id/split` — same route as equal split, dispatched by `split_type`:

| `split_type` | Body | Description |
|---|---|---|
| `by_item` | `{split_type: 'by_item', allocations: [{order_item_ids: string[], label?}, ...]}` | One child per allocation, 1 to `split_max_ways` of them (422 `SPLIT_WAYS_INVALID` outside that range). Every listed item must belong to this order (422 `SPLIT_ITEM_NOT_IN_ORDER`), appear in at most one allocation (422 `SPLIT_ITEM_DOUBLE_ALLOCATED`), and not be `cancelled` (422 `SPLIT_ITEM_CANCELLED`). Items not listed in any allocation stay on the parent. |
| `by_seat` | `{split_type: 'by_seat'}` | One child per distinct `seat_number` among the order's active items, in ascending seat order; items with no seat stay on the parent. No distinct seats is a no-op success (`[]`). |

`GET /orders/:id/splits` and `POST /orders/:id/splits/:childId/merge-back` are shared with equal split — see the section above. `merge-back` was designed for undoing an *equal* split (it deletes the child and its single synthetic item); running it on a `by_item`/`by_seat` child would delete real order items along with it, which is very likely not what's wanted — treat merge-back as equal-split-only until a future session addresses reversing an item-level split explicitly.

## Orders — merge (Phase 2, session 2f-iii)

Combines two live orders into one. **Not related to split's `merge-back`** (which only undoes an equal split) — this is the reverse direction, combining two independently-opened orders, e.g. two tables that decide to share one bill.

**Direction:** the `:id` route param is always the **TARGET** (the survivor). `source_order_id` is the order being absorbed — it ends as `status='merged'` (not `'cancelled'`, since the food was still served) with `merged_into_order_id`/`merged_at`/`merged_by_user_id` set and its own totals zeroed. Getting this backwards is the likeliest integration bug, so it is called out here explicitly.

Requires `merge_tables_enabled`, else 403 `MERGE_DISABLED`. A waiter additionally requires `merge_requires_manager=false` — enforced both by `resolvePermissions` narrowing `order.merge` away from waiter at the permission layer, and redundantly inside `mergeService` itself (403 `MERGE_REQUIRES_MANAGER`) so the same rule holds for direct service calls, not just HTTP requests. Both orders must be in the same venue, active (not `closed`/`cancelled`/`merged` — 409 `ORDER_NOT_MODIFIABLE`), unpaid (409 `ORDER_ALREADY_PAID`), and neither a split-bill child nor a split-bill parent with live (unresolved) children (409 `MERGE_ORDER_HAS_SPLIT`).

All non-cancelled source items reassign to the target in place (`order_id` only — every snapshot, status, and timestamp preserved, matching `by_item` split's own move semantics). Parent and target are both recomputed through the normal totals formula. Course rows reconcile by `course_number`: item counts roll up automatically through the same mechanism every other course recompute uses; when both sides had already fired the same course number, the **earlier** `fired_at` (and its `fired_by_user_id`) wins, and course `status`/`first_ready_at`/`all_served_at` are re-derived honestly from the now-combined item set rather than left at whatever a freshly-created row would otherwise default to. The source's table (if any) becomes `dirty`; the target's table is untouched unless `target_table_id` is given, in which case the target is transferred there first (reuses `transferOrder` as a genuinely separate, real operation — its own errors, e.g. `TRANSFER_DISABLED`/`TABLE_INACTIVE`/`TABLE_ALREADY_HAS_ACTIVE_ORDER`, propagate as-is and abort the merge before anything else happens).

Merge is **irreversible** in Phase 2 — there is no undo. `GET .../merge-preview` exists for this reason: it runs the identical move/recompute/reconciliation logic inside a database transaction that is always rolled back, so its numbers are guaranteed to match a real `POST .../merge` exactly, never a hand-duplicated estimate.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/orders/{id}/merge-preview` | `order.merge` | Query: `?source_order_id=...&target_table_id=...` (both same as POST). Dry run — no writes. Returns `{target_order_id, source_order_id, item_count, grand_total, courses: [{course_number, item_count, status, fired_at}]}`. |
| POST | `/orders/{id}/merge` | `order.merge` | `{source_order_id, target_table_id?}`. Returns `{target, source}`, both full serialized orders. `Idempotency-Key` aware. |

Events: `order.merged` appended to the target, `order.absorbed` appended to the source — never a single event trying to describe both sides at once, since `order_events.order_id` can only ever point to one order.

## Orders — payments (Phase 2, session 2g-i)

A cash-drawer log, not a payment processor — no gateway, no card data, no PCI scope. `method` must be in `payment_methods_enabled` (JSON array, default `["cash","card"]`), else 422 `PAYMENT_METHOD_DISABLED`. `amount` is always exactly what this payment contributes to `orders.amount_paid` — never server-capped. For every method except `cash`, `amount` may not exceed `amount_due` (422 `PAYMENT_EXCEEDS_DUE`); cash is the one tender allowed to exceed it ("overpayment"), and when `received_amount` is also given, `change_amount = received_amount - amount` (`received_amount` is rejected outside `cash`). `allow_partial_payment=false` requires a single payment to fully settle the current `amount_due` (422 `PARTIAL_PAYMENT_NOT_ALLOWED`). `orders.amount_paid`/`amount_due` are recomputed after every payment create/void — `amount_due` clamps at 0 rather than going negative on a cash overpayment. `shift_id` is copied straight from the order (as of session 2g-ii below, real — `orders.shift_id` is set to the venue's open shift at order-creation time, or stays `null` if none is open); `payments.business_date` is computed independently via the venue's timezone (the same `businessDateFor` helper session 2e's stock module already uses — a plain calendar-day reset, unrelated to 2g-ii's start-hour-aware business date below), since `payments.business_date` is `NOT NULL` and needs a value even when `orders.business_date` predates 2g-ii's backfill or the order predates shift tracking entirely. `taken_by_name` is snapshotted at creation so the record survives the user being deleted later. `room_charge` is a tender label only — it never writes to any `pms_*` column. Payments are blocked on a `closed`/`cancelled`/`merged` order (409 `ORDER_NOT_MODIFIABLE`).

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/orders/{id}/payments` | `order.payment` | `{method, amount, tip_amount?, reference?, received_amount?}`. `Idempotency-Key` aware. |
| GET | `/orders/{id}/payments` | `order.view_own` | All payments on this order (voided ones included, `is_voided` distinguishes them), oldest first. |
| DELETE | `/orders/{id}/payments/{pid}` | `order.payment_void` (manager+) | `{reason}`. Sets `is_voided`/`voided_reason`/`voided_by_user_id` and recomputes the order — the row is never deleted. |

`POST /orders/:id/close` (existing route) gains one more gate when `require_payment_to_close=true`: 409 `ORDER_NOT_SETTLED` while `amount_due > 0`. Checked last, after the existing pending-void (`ORDER_HAS_PENDING_VOID`, 2d-i) and unserved-items (`ORDER_HAS_UNSERVED_ITEMS`) gates, so an order failing more than one of these always reports the same blocking condition first, deterministically.

Split children (2f-i/2f-ii) carry independent payments — paying a child never touches the parent's `amount_paid`/`amount_due`, and paying the parent (`amount_paid > 0`) blocks further splitting via the existing `ORDER_ALREADY_PAID` guard.

## Shifts (Phase 2, session 2g-ii)

Mounted at `/api/v1/shifts`, not nested under `/orders` — a shift isn't scoped to one order.

**Business date** (`src/modules/shifts/businessDate.ts`, `computeBusinessDate(timestamp, timezone, business_day_start_hour)`): a timestamp before `business_day_start_hour` (default 5) belongs to the **previous** calendar date in the venue's own timezone — a 02:00 order counts as the prior day's business. This is the one function `orders.business_date` and `shifts.business_date` are computed from as of this session; it is distinct from `menu/stockService.ts`'s `businessDateFor` (stock's own plain calendar-day reset, no start-hour offset, left untouched — out of this session's scope) and from `orders/validation.ts`'s own `computeBusinessDate` (an unrelated function, same name, governs `ticket_number_reset` only). Existing `orders.business_date` rows were backfilled from `opened_at` in this session's migration; every order from here on gets it set unconditionally at creation, whether or not shift tracking or a currently-open shift exists.

One open shift per venue, enforced by the partial unique index from 2a-i (`shifts_venue_id_open_key`) — a second `POST /shifts/open` while one is already open returns 409 `SHIFT_ALREADY_OPEN`. New orders attach `shift_id` to the currently open shift only when `shifts_enabled=true` **and** a shift happens to be open; with neither, order creation still succeeds with `shift_id` null (never block service for a forgotten shift).

`POST /shifts/close` blocked by 409 `SHIFT_HAS_OPEN_ORDERS` (body `error.details.open_orders: [{id, order_number}]`) while any non-terminal order is still attached to this shift, unless `?force=true`. Forcing does **not** immediately reassign those orders — they keep pointing at the now-closed shift until the *next* `POST /shifts/open`, which sweeps in every still-active order not attached to an open shift (this literally includes the force-closed shift's leftover orders, but also any order that was never attached to a shift at all, e.g. opened while `shifts_enabled` was off) and reassigns them to the new shift, logging one `order.shift_reassigned` event per order. `cash_variance = closing_cash_counted - (opening_float + cash payments in the shift)` — negative means short, stored exactly as computed, never suppressed or clamped. Closing also writes a `shift_reports` row (`is_final=true`, `period_start`/`period_end` = the shift's open/close timestamps, `payload` the full report computed by session 2h-i's `computeReport` — see the Reports section below).

`GET /shifts/current` never auto-closes a long-running shift — it only sets `flagged: true` once the shift has been open longer than `shift_auto_close_hours` (default 24), so a manager notices without losing cash reconciliation to a silent auto-close.

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/shifts/open` | `shift.manage` | `{name?, opening_float?}`. |
| POST | `/shifts/close` | `shift.manage` | `{closing_cash_counted?, notes?}`, query `?force=true`. |
| GET | `/shifts/current` | `reports.view` | `{shift, flagged}` — `shift` is `null` if none is open. |
| GET | `/shifts` | `reports.view` | `?from&to` (business_date range), paginated. |
| GET | `/shifts/:id` | `reports.view` | A single shift. |

The three `GET` routes aren't assigned a permission by the session spec (only the two `POST` routes name `shift.manage`) — gated with `reports.view` as the closest existing fit, matching how `voidsRouter` already gates its own read-only list/get routes.

## Reports (Phase 2, session 2h-i)

Mounted at `/api/v1/reports`. One function, `computeReport(venueId, periodStart, periodEnd, shiftId?)` (`src/modules/reports/reportService.ts`), computes the entire payload shape defined in `docs/phase2/REPORT-PAYLOAD.md`; every route below is a straight projection of it — none run their own query set. `shiftId` is a documented extension beyond the session spec's literal 3-arg signature: two shifts can share one business date, so business-date filtering alone can't narrow to a single shift the way `shift_id` (a real column on `orders`/`payments`/`restaurant_void_log` since 2g-i/2g-ii) can.

**Scope resolution.** Every route except `/shift/:id` accepts either `?shift_id=` (exact shift) or `?from&to` (business dates, `YYYY-MM-DD`, both default to the venue's current business date when omitted — a bare request reports on "today"). `?from&to` are converted to real instants via `businessDateWindowStart` (`src/modules/shifts/businessDate.ts`) — the inverse of `computeBusinessDate`: the actual moment `business_day_start_hour` local time begins on that calendar date, correctly across a DST transition.

**Revenue exclusion (equal split).** Equal-split children are excluded wholesale from `revenue`/`orders`-average/`covers` figures — the parent's own totals were never touched by an equal split, so including a child's share alongside the parent's full total would double it. `by_item`/`by_seat` children stay in; their items genuinely moved, so parent + children sum to the original with no overlap. `top_items`/`destinations` apply the item-level half of this same rule instead (`menu_item_id IS NULL` is exactly the equal-split synthetic item marker) — items live on exactly one order regardless of split type, so no double-count risk there either way. `payments`/`unsettled_value` are **not** filtered this way — a payment or an owed balance on a split child is real money tied to that specific check, not a duplicate of the parent's.

**Attribution.** Waiter figures (orders, covers, sales, voids, tips) all follow the order's `opened_by_user_id` — voids (who requested it) and payments (who took it) each have their own separate dimension elsewhere (`voids.by_user`), but a waiter's *own* breakdown always means "activity on tables this waiter opened."

**Snapshot discipline.** Every figure derives from snapshot columns (`item_name_snapshot`, `unit_price_snapshot`, `line_total`, `void_value`, …) — never a join to `menu_items`, `menu_categories`, or `modifier_options`. A menu price change today cannot change a prior period's numbers, stored or freshly recomputed.

**Materialization.** A `shift_reports` row with `is_final=true` is served exactly as stored, never recomputed — `GET /reports/shift/:id` checks for one first and only falls back to a live (unstored) `computeReport` call for a still-open shift with no final report yet. `POST /reports/generate` always computes fresh and writes a new final row.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/reports/shift/{id}` | `reports.view` | The stored final report if one exists, else a live preview. |
| GET | `/reports/range` | `reports.view` | `?from&to&group_by=day\|shift\|waiter`. No `group_by`: one report for the whole range. `waiter`: `report.waiters` for the range. `day`/`shift`: an array of `{business_date, report}` / `{shift_id, report}`, one `computeReport` call per bucket. |
| GET | `/reports/sales` | `reports.view` | `{revenue, orders, covers}` for the resolved scope. |
| GET | `/reports/waiters` | `reports.view` | `report.waiters` for the resolved scope. |
| GET | `/reports/voids` | `reports.view` | `report.voids` for the resolved scope. |
| GET | `/reports/items` | `reports.view` | `?limit&sort=quantity\|revenue` (default 20, `revenue`) — re-sorts `report.top_items`. |
| GET | `/reports/payments` | `reports.view` | `report.payments` for the resolved scope. |
| POST | `/reports/generate` | `reports.view` | Same scope resolution as the GET routes, via query `shift_id` or `from`/`to`. Materializes into `shift_reports` (`is_final=true`). Returns `{shift_report_id, report}`. |

## Orders — course firing (Phase 2, session 2c)

Every route below requires `send_by_course=true` AND `venue_type` in (`happy_restaurant`, `happy_hybrid`) — 403 `COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE` otherwise (venue type checked first).

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/orders/{id}/courses` | `order.create` | Course state (status, fired_at, item_count, first_ready_at, all_served_at) for every course that's had an item assigned. | `send_by_course` |
| POST | `/orders/{id}/courses/{n}/fire` | `order.fire` | Send that course's pending items (reuses the same send logic as `POST /orders/:id/send`, including `destination:'none'` skipping straight to `served`). No-op success on an empty or already-fired course. `Idempotency-Key` aware. | `send_by_course`, `course_fire_requires_previous_served` |
| POST | `/orders/{id}/courses/{n}/hold` | `order.fire` | Un-fires a course — reverts its `sent` items back to `pending` — only while nothing in it has reached `preparing`/`ready`/`served`. 409 `COURSE_ALREADY_STARTED` otherwise. No-op success if the course was never fired. | `send_by_course` |
| POST | `/orders/{id}/courses/reorder` | `order.fire` | `{course_numbers: number[]}` — a full permutation of this order's existing course numbers; array position becomes the new course number. **Best-effort implementation — spec gave no payload example for this route; see `docs/phase2/SESSION-2c.md`.** | `send_by_course` |
| PATCH | `/orders/{id}/items/{itemId}/course` | `order.create` | Move an item to a different course — only while `pending` (409 `ITEM_ALREADY_SENT` otherwise). | `send_by_course`, `courses_enabled` |

`POST /orders/:id/send` (existing Phase 1 route) also gains one behavior: when `auto_fire_first_course=true` and this is the order's very first send, it fires course 1 rather than sending every pending item across every course.

## Displays — fire alerts (Phase 2, session 2c)

Same "backend composes the headline" rule as the rest of the displays module — see the response shape in `docs/phase2/SESSION-2c.md`. `GET /displays/kitchen` and `GET /displays/bar` additively gain a `fire_alerts` array (always present, empty when nothing applies — no availability gate on those two pre-existing routes). The two routes below are new and standalone, and DO carry the course-firing availability gate.

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/displays/kitchen/fire-alerts` | `display.view` | Alerts fired within the last `show_fire_alert_seconds` and not yet acknowledged. | `send_by_course`, `show_fire_alert_seconds` |
| POST | `/displays/fire-alerts/{id}/ack` | `display.bump` | Acknowledge (dismiss) an alert. `{id}` is the underlying `order_courses.id`. | — |

## Displays — void alerts (Phase 2, session 2d-ii)

Same envelope pattern as fire alerts (shared `id`/`type`/`headline`/`acknowledged` fields, `type: 'void'` here) — see `docs/phase2/SESSION-2d-ii.md`. Emitted only for a void that reached `stage='after_send'` and `status` `approved`/`auto_approved` — a void still `pending_approval` never shows here, so a kitchen never stops cooking something that might not end up voided. `GET /displays/kitchen`/`/bar` additively gain a `void_alerts` array, filtered to that destination only (a voided bar item never appears on the kitchen display). `GET /displays/void-alerts` below has no destination segment in its path and returns both destinations together as one feed. No availability gate beyond `void_alerts_kitchen` (there's no separate `*_bar` flag — it gates both destinations).

| Method | Path | Permission | Description | Gating flag(s) |
|---|---|---|---|---|
| GET | `/displays/void-alerts` | `display.view` | All unacknowledged after-send void alerts, kitchen and bar combined. | `void_alerts_kitchen` |
| POST | `/displays/void-alerts/{id}/ack` | `display.bump` | Acknowledge (dismiss) an alert. `{id}` is the underlying `restaurant_void_log.id`. Idempotent. | — |

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

Phase 2, session 2h-ii additionally wires the same mechanism onto every Phase 2 route named in `docs/phase2/2h-ii.md` section 2: `POST /orders/:id/split`, `POST /orders/:id/merge`, `POST /orders/:id/payments`, `POST /orders/:id/courses/:n/fire`, `POST /orders/:id/items/:itemId/void`.
