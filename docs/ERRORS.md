# Error codes

Every error response uses the same envelope:

```json
{ "error": { "code": "SOME_CODE", "message": "human-readable text", "details": { "...": "optional" } } }
```

**The client switches on `code`, never on `message`** — message text is free
to change without breaking anything; `code` is the contract. The full list of
codes is exported as `ERROR_CODES` / the `ErrorCode` type in
[`src/shared/errorCodes.ts`](../src/shared/errorCodes.ts); every place in the
codebase that raises a domain error (`lib/domainError.ts`'s `err()`, or
`sendDomainError()` directly) type-checks its `code` argument against that
list, so a typo or an undocumented code is a compile error, not a runtime
surprise for the client.

## Generic (any route)

| Code | Status | Fires when |
|---|---|---|
| `VALIDATION_ERROR` | 400 (via `sendError`) or 422 (via `sendDomainError` for a business-rule check) | Request shape/basic input is invalid, or a business-rule validation failed. |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired access token, invalid login credentials, or a locked account. |
| `FORBIDDEN` | 403 | Authenticated, but the caller's role lacks the required permission (`requirePermission`). |
| `NOT_FOUND` | 404 | The requested resource doesn't exist (or isn't visible to this venue). |
| `CONFLICT` | 409 | Generic conflict fallback (most 409s use a more specific domain code below). |
| `INTERNAL_ERROR` | 500 | Unhandled exception — see the error handler in `src/app.ts`. |
| `RATE_LIMIT_EXCEEDED` | 429 | More than 10 login attempts in 60s for the same `(venue_slug, ip)` pair. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | A request with the same `Idempotency-Key` (scoped to venue+user+route) is already being processed. |

## Auth (`/auth/*`)

Login failures use only the generic codes above: `NOT_FOUND` (venue doesn't
exist), `VALIDATION_ERROR` (wrong login method for this venue — e.g. PIN
login at an email-only venue), `UNAUTHORIZED` (locked account, or invalid
credentials — the same code either way, so a client can't distinguish
"wrong password" from "account exists" by code alone).

## Settings (`PATCH /settings`)

| Code | Status | Fires when |
|---|---|---|
| `COURSES_NOT_ALLOWED_FOR_BAR` | 422 | `courses_enabled=true` submitted for a `happy_bar` venue. |
| `COUNTER_SERVICE_REQUIRED` | 422 | `tables_enabled=false` without `counter_service_enabled=true` — a venue must support at least one service mode. |
| `TABLE_REQUIRED_FOR_ORDER` | 422 | `counter_service_enabled=false` without `require_table_for_order=true`. |
| `PIN_LENGTH_OUT_OF_RANGE` | 422 | `pin_length` outside 4-8. |

## Users (`/users/*`)

| Code | Status | Fires when |
|---|---|---|
| `CREDENTIALS_REQUIRED` | 422 | Neither email+password nor a PIN provided (create), or an update would leave the user with no login method at all. |
| `EMAIL_ALREADY_IN_USE` | 409 | That email is already used by another active user at this venue. |
| `PIN_ALREADY_IN_USE` | 409 | That PIN is already used by another active user at this venue. |
| `DUPLICATE_CREDENTIAL` | 409 | Race-condition backstop for the two codes above (the unique-constraint violation didn't specify which field). |
| `CANNOT_MODIFY_SELF` | 422 | An admin tried to deactivate or delete their own account. |
| `EMAIL_REQUIRED_FOR_PASSWORD` | 422 | `POST /users/:id/reset-password` on a user with no email on file. |
| `INSUFFICIENT_ROLE_AUTHORITY` | 403 | A manager tried to create/edit a user whose current or target role is `manager` or `admin` — managers may only manage `waiter`/`kitchen`/`bar`. Session 2a-ii. |

Session 2a-ii activated all five roles (`waiter`/`kitchen`/`admin`/`manager`/`bar`) — `ROLE_NOT_AVAILABLE_IN_PHASE_1` no longer exists; any string that isn't a real `UserRole` value now fails generic `VALIDATION_ERROR` instead.

## Areas (`/areas/*`)

| Code | Status | Fires when |
|---|---|---|
| `AREA_HAS_ACTIVE_TABLES` | 409 | Deleting an area that still has active tables, without a `?reassign_to=` target. |
| `INVALID_REASSIGN_TARGET` | 422 | `reassign_to` is the same area being deleted, or doesn't exist. |

## Tables (`/tables/*`)

| Code | Status | Fires when |
|---|---|---|
| `TABLE_NUMBER_REQUIRED` / `TABLE_NAME_REQUIRED` / `TABLE_IDENTIFIER_REQUIRED` | 422 | Missing the identifier the venue's `table_naming_mode` requires. |
| `TABLE_NAME_NOT_ALLOWED` / `TABLE_NUMBER_NOT_ALLOWED` | 422 | Supplied the identifier the naming mode forbids. |
| `TABLE_IDENTIFIER_ALREADY_IN_USE` / `TABLE_NUMBER_ALREADY_IN_USE` / `TABLE_NAME_ALREADY_IN_USE` | 409 | That number/name is already used by another active table. |
| `TABLE_HAS_ACTIVE_ORDER` | 409 | Deleting a table that currently has an active order. |
| `TABLE_INACTIVE` | 422 | Referencing a table (order create/transfer) that's marked inactive. |
| `INVALID_RANGE` | 422 | Bulk-create `from` > `to`. |
| `RANGE_TOO_LARGE` | 422 | Bulk-create range exceeds 500 tables. |

## Menu (`/menu/*`)

| Code | Status | Fires when |
|---|---|---|
| `CATEGORY_HAS_ACTIVE_ITEMS` | 409 | Deleting a category that still has active menu items. |
| `SKU_ALREADY_IN_USE` | 409 | That SKU is already used by another active item at this venue. |
| `INVALID_MAX_SELECT` / `INVALID_MIN_SELECT` | 422 | Modifier group `min_select`/`max_select` violate the rules for its `type`/`is_required`. |
| `DESTINATION_NOT_AVAILABLE` | 422 | `destination` isn't valid for the venue's type (`bar` at a `happy_restaurant`, `kitchen` at a `happy_bar`) — applies to a modifier group's `applies_to_destination` too. |
| `COURSES_DISABLED` | 422 | A non-null `course_number` submitted while `courses_enabled` is false. |
| `INVALID_TIER_PRICES` | 422 | A modifier option's `tier_prices` submitted while the group's `pricing_mode` isn't `tiered`, or malformed (keys must be positive-integer strings, values numbers >= 0). Phase 2, session 2b-i. |
| `MODIFIER_GROUP_LIMIT_EXCEEDED` | 422 | `POST /menu/items/:id/modifier-groups` would attach more than `modifier_max_groups_per_item` groups to one item. Phase 2, session 2b-i. |
| `MODIFIER_GROUP_HAS_ATTACHED_ITEMS` | 409 | Deleting a modifier group that's still attached to an active menu item. Phase 2, session 2b-i. |

## Orders — core (`/orders`, `/orders/:id/items`)

| Code | Status | Fires when |
|---|---|---|
| `TABLE_REQUIRED_FOR_ORDER` | 422 | `service_mode: 'counter'` at a venue with `require_table_for_order=true`. |
| `COUNTER_SERVICE_DISABLED` | 422 | `service_mode: 'counter'` at a venue with `counter_service_enabled=false`. |
| `TABLE_ID_REQUIRED` / `TABLE_ID_NOT_ALLOWED` | 422 | `table_id` missing for table mode, or present for counter mode. |
| `TABLE_ALREADY_HAS_ACTIVE_ORDER` | 409 | The target table already has an active order (DB partial-unique-index enforced). |
| `ORDER_NOT_MODIFIABLE` | 409 | Adding an item to an order whose status is `served`/`closed`/`cancelled`. |
| `MENU_ITEM_UNAVAILABLE` | 422 | The menu item is 86'd (`is_available=false`) or no longer exists. |
| `MODIFIER_SELECTION_INVALID` | 422 | A submitted modifier option id doesn't resolve to a real, active option at this venue. Fires regardless of `require_modifier_validation` — this is referential integrity, not a business rule. |
| `MODIFIER_GROUP_REQUIRED` | 422 | An attached group with `is_required=true` has zero selections. Phase 2, session 2b-ii. Gated by `require_modifier_validation`. |
| `MODIFIER_MIN_NOT_MET` | 422 | A group has 1+ selections but fewer than its `min_select`. Phase 2, session 2b-ii. Gated by `require_modifier_validation`. |
| `MODIFIER_MAX_EXCEEDED` | 422 | A group's selection count exceeds its `max_select` (or, for `type='single'`, more than one selection). Phase 2, session 2b-ii. Gated by `require_modifier_validation`. |
| `MODIFIER_OPTION_NOT_IN_GROUP` | 422 | A selected option's group isn't attached to this item. Phase 2, session 2b-ii. Gated by `require_modifier_validation`. |
| `MODIFIER_DUPLICATE_SELECTION` | 422 | The same modifier option id appears more than once in one request. Phase 2, session 2b-ii. Gated by `require_modifier_validation`. |
| `MODIFIER_DESTINATION_MISMATCH` | 422 | A selected option's group has an `applies_to_destination` that doesn't match this item's destination. Phase 2, session 2b-ii. Gated by `require_modifier_validation`. |
| `NOTES_NOT_ALLOWED` | 422 | `notes` submitted while `allow_free_text_notes=false`. |
| `ITEM_ALREADY_SENT` | 409 | `PATCH .../items/:itemId` on an item whose status is no longer `pending`. |
| `ITEM_ALREADY_CANCELLED` | 409 | Voiding an item that's already cancelled. |
| `VOID_REASON_REQUIRED` | 422 | Voiding without a reason while `void_reason_required=true`. |

`VOID_AFTER_SEND_NOT_ALLOWED` (Phase 1) no longer fires — session 2d-i replaced the flat `allow_item_void_after_send` block with the request/approve/reject flow below, where an after-send void is never flatly rejected, only queued for approval or auto-approved. The code stays in `ErrorCode` for wire-compatibility with anything that still matches on it, but nothing in this codebase emits it anymore.

## Orders — void request/approval (`/orders/:id/items/:itemId/void`, `/voids/*`) — Phase 2, session 2d-i

Replaces Phase 1's void behavior entirely, including on the legacy `DELETE /orders/:id/items/:itemId` route, which now routes through the same flow. See `resolveVoidPolicy` in `src/modules/orders/voidPolicy.ts` for the before_send/after_send + approval-required + auto-approve decision, and `docs/phase2/SESSION-2d-i.md` for the full design.

| Code | Status | Fires when |
|---|---|---|
| `VOID_REASON_REQUIRED` | 422 | (see above — same code, same meaning, now checked by the new flow) |
| `ITEM_ALREADY_CANCELLED` | 409 | (see above — unchanged) |
| `VOID_ALREADY_PENDING` | 409 | A second void request is submitted for an item that already has one awaiting approval. |
| `VOID_ALREADY_RESOLVED` | 409 | `POST /voids/:id/approve` or `/reject` on a void request that isn't `pending_approval` anymore. |
| `ORDER_HAS_PENDING_VOID` | 409 | `POST /orders/:id/close` while any of its items has a void request awaiting approval. |

## Orders — lifecycle (`/orders/:id/send`, `/transfer`, `/serve`, `/close`, `/cancel`)

| Code | Status | Fires when |
|---|---|---|
| `NO_PENDING_ITEMS` | 422 | `POST /orders/:id/send` resolves to an empty eligible-item set. |
| `TRANSFER_DISABLED` | 403 | `POST /orders/:id/transfer` at a venue with `allow_table_transfer=false`. |
| `NO_READY_ITEMS` | 422 | `POST /orders/:id/serve` resolves to an empty eligible-item set. |
| `INVALID_STATUS_TRANSITION` | 409 | An item/order status change isn't a valid transition (see the state machine in `src/modules/orders/statusMachine.ts`) — includes closing/cancelling an already-closed/cancelled order, and single-item serve/recall on an item not in the required source status. |
| `ORDER_HAS_UNSERVED_ITEMS` | 409 | `POST /orders/:id/close` while any non-cancelled item isn't `served`. |
| `CANCEL_REASON_REQUIRED` | 422 | `POST /orders/:id/cancel` without a `reason`. |
| `CANCEL_AFTER_SEND_NOT_ALLOWED` | 403 | A non-admin cancelling an order after anything has been sent (`first_sent_at` is set). |

## Orders — course firing (`/orders/:id/courses/*`, `/orders/:id/items/:itemId/course`)

| Code | Status | Fires when |
|---|---|---|
| `COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE` | 403 | Any course-firing route on a `happy_bar` venue, or on a venue with `send_by_course=false`. Venue type is checked first, so a `happy_bar` venue always gets the venue-type message even if `send_by_course` also happens to be false there. Phase 2, session 2c. |
| `PREVIOUS_COURSE_NOT_SERVED` | 409 | `POST /orders/:id/courses/:n/fire` for `n > 1` while `course_fire_requires_previous_served=true` and course `n-1` doesn't have `all_served_at` set. A course with no items ever assigned is treated as vacuously served. Phase 2, session 2c. |
| `COURSE_ALREADY_STARTED` | 409 | `POST /orders/:id/courses/:n/hold` when the course has an item already `preparing`/`ready`/`served` — hold only undoes a fire that kitchen/bar hasn't touched yet. Phase 2, session 2c. |

`ITEM_ALREADY_SENT` is reused (not a new code) for `PATCH /orders/:id/items/:itemId/course` on a non-`pending` item — moving between courses is only allowed while pending, same meaning as the existing item-edit lock.

## Displays (`/displays/*`)

| Code | Status | Fires when |
|---|---|---|
| `DISPLAY_DISABLED` | 403 | `GET /displays/kitchen` or `/bar` at a venue with the corresponding `*_display_enabled` flag off. |
| `INVALID_STATUS_TRANSITION` | 409 | `PATCH /displays/items/:itemId/status` requests a transition outside `sent→preparing`, `sent→ready`, `preparing→ready`; or `POST /displays/items/:itemId/recall` on an item that isn't `ready`; or a bulk `POST /displays/bump` targets an item (by explicit `order_item_ids`) that isn't `sent`/`preparing`. |
| `NO_ITEMS_TO_BUMP` | 422 | `POST /displays/bump` with `order_id` resolves to no eligible (`sent`/`preparing`) items. |
