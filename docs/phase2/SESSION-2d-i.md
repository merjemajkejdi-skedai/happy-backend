# Session 2d-i — Void Log & Approval Flow

**Status:** Complete. Full suite green (20 files / 485 tests), `tsc --noEmit` clean.

## Implemented

### 1. `resolveVoidPolicy` (`src/modules/orders/voidPolicy.ts`, new)

The one pure decision function per section 1: `stage` (`before_send` if the item is still `pending`, else `after_send`), `requiresApproval` from the matching settings flag, `autoApprove` from whether the actor's role satisfies `settings.void_approval_role`. Since only `manager`/`admin` ever hold `void.approve` (confirmed against the static permission matrix), "satisfies" is a two-level seniority check between those two roles — a `voidApprovalRole` of `'manager'` (the default) means both manager and admin auto-approve; `'admin'` means only admin does, so a manager would queue like anyone else. This makes "a manager never queues for themselves" fall out of the general rule for the default config, without hardcoding it as a special case.

### 2. `voidService.ts` (new) — the full flow

- `requestVoid` — single entry point for both the new `POST .../items/:itemId/void` route and the legacy `DELETE .../items/:itemId` route. Checks item existence/not-already-cancelled, reason requirement, an existing pending request for the same item (`VOID_ALREADY_PENDING`, new — not named in the spec but needed to prevent two concurrent approvals both trying to cancel the same item), then resolves the policy and either queues (`restaurant_void_log` + `approval_requests`, item untouched) or executes immediately (`restaurant_void_log` `auto_approved`, item cancelled, `void_id` set, order recomputed).
- `approveVoid` / `rejectVoid` — resolve a `pending_approval` log (404 if missing, `VOID_ALREADY_RESOLVED` — new — if already resolved). Approve cancels the item, sets `void_id`, recomputes, resolves the `approval_requests` row. Reject touches nothing on the order — the log gets `status='rejected'` and `rejection_reason`.
- `listPendingVoids` / `listVoids` / `getVoid` — the manager queue and the reporting endpoints, both paginated like every other list route in this API.
- `hasPendingVoid` — the order-close guard's query, reused by `lifecycleService.closeOrder`.

### 3. Wiring

- `src/modules/orders/orderItemsRoutes.ts`: new `POST /:itemId/void`; `DELETE /:itemId` rewritten to call `requestVoid` (mapping Phase 1's single `reason` field to `reason_text`), returning 202 when a request is queued instead of always 200. Both routes gated by `order.void` (was `order.create` — the same four roles hold both permissions, so this is a semantic rename, not an authorization change).
- `src/modules/voids/routes.ts` (new top-level module) + `app.ts`: `GET /voids/pending`, `POST /voids/:id/approve`, `POST /voids/:id/reject`, `GET /voids`, `GET /voids/:id`. `/pending` registered before `/:id` so the literal path isn't swallowed by the param route (same discipline as `GET /users/roles` before `GET /users/:id` in session 2a-ii).
- `lifecycleService.closeOrder`: new `hasPendingVoid` check, before the existing unserved-items check — 409 `ORDER_HAS_PENDING_VOID`.

### 4. Retired: `orderItemsService.voidItem` (Phase 1)

Deleted, along with its now-unused `canVoidAfterSend`/`UserRole` imports. Its old behavior (flatly blocking a non-admin after-send void via `allow_item_void_after_send`) has no equivalent in the new flow — every after-send void either auto-approves or queues, never rejects outright — so there was nothing left to keep. `tests/orders.test.ts`'s "Void rules with the flag on and off" describe block (5 tests, all exercising that removed blocking behavior) was removed rather than rewritten in place; equivalent-and-broader coverage of the new flow lives in the new `tests/voidFlow.test.ts`.

### 5. Found and fixed: `RestaurantVoidLog`/`ApprovalRequest` missing from `VENUE_SCOPED_MODELS`

Same pattern as sessions 2c (`OrderCourse`) and this session's own venue-scope discipline: both tables have their own `venue_id` column but were never added to `src/middleware/venueScope.ts`'s guard set when created in 2a-i. Fixed before writing the first real queries against them, and confirmed every `findFirst`/`findMany`/`count`/`updateMany` call site in `voidService.ts` already carried an explicit `venueId` filter (so flipping the guard on didn't break anything — verified by the full suite passing).

### 6. FK confirmation

`order_items.void_id → restaurant_void_log.id` was already present in `prisma/schema.prisma` (`voidId`/`voidLog` fields, with a comment noting it was "wired now that restaurant_void_log exists") — section 7's "add the FK now, if not already applied" was already satisfied by 2a-i. No migration needed this session.

### 7. Docs

`docs/API.md` (new void section + rewrote the `DELETE .../items/:itemId` row), `docs/ERRORS.md` (3 new codes; `VOID_AFTER_SEND_NOT_ALLOWED` marked as dead/superseded rather than removed from `ErrorCode`, since removing a wire-contract literal is a bigger step than this session's scope called for; also fixed a stale `require_reason_on_void` doc reference that should have said `void_reason_required` since 2a-i's rename).

## Interpretation calls — flagged explicitly

- **`reason_code` is not validated against `void_reason_preset_list` server-side.** The spec says a request "needs `reason_code` (from `void_reason_preset_list`) or `reason_text`" — read as "the preset list is what the client uses to populate a picker," not a server-enforced whitelist. The server only checks that *some* reason was supplied when required. Chosen to avoid brittleness if the preset list is edited without a matching client release.
- **`approved_by_user_id`/`approved_by_name` on `restaurant_void_log` are reused as "resolved by" on rejection too**, not left null — the schema has no separate rejected-by pair, and who acted on a rejected request is exactly as reportable as who approved one.
- **A duplicate pending request for the same item is rejected** (`VOID_ALREADY_PENDING`) rather than allowed to queue a second `approval_requests` row — not specified either way, but two live pending requests for one item risks a double-cancel race once both get approved.
- **`allow_item_void_after_send` is fully superseded**, not consulted anywhere in the new flow (see "Retired" above) — this is the one explicit, deliberate behavior replacement the session's own text calls for.

## Tests

`tests/voidFlow.test.ts` (new, 21 tests) — before-send/approval-off immediate cancel, after-send/approval-on pending request (item stays live), manager self-void auto-approves despite `void_requires_approval=true`, reason requirement (missing / preset code / free text), approve (cancels + recomputes), reject (item untouched, rejection logged), `void_value` math with modifiers, order-close guard, duplicate-pending-request rejection, every resolution path writing the log, and log fields surviving the requesting user's soft-deletion.

`tests/orders.test.ts` — the 5 Phase-1-only void tests removed (see "Retired" above); the rest of the file (numbering, table constraints, modifier validation matrix, tax totals) unaffected.

Full suite: 20 files, 485 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

2d-ii (per `docs/phase2/2d-ii.md`, not yet read this session) is display alerts for voids — explicitly out of this session's scope per its own header ("NOT display alerts — that is 2d-ii"). This session's void flow is complete and tested on its own; 2d-ii should be able to build on `restaurant_void_log`/`approval_requests` as-is without touching `voidService.ts`.
