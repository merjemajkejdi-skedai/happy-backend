# Session 2f-i — Split Equal

**Status:** Complete. Full suite green (23 files / 516 tests), `tsc --noEmit` clean. No migration needed — `parent_order_id`/`split_type`/`split_sequence` and the relaxed `orders_active_table_key` index were already added in 2a-i; this session is the first to write real logic against them.

## Implemented

### 1. `src/modules/orders/splitService.ts`

- `computeEqualShares(total, ways)` — the money-conservation core. Works in integer cents (`total.times(100)`), floor-divides by `ways`, and hands the entire rounding remainder to child 1. Sums are exact by construction, verified for both evenly divisible (900.00/3 → 300/300/300) and unevenly divisible (1000.00/3 → 333.34/333.33/333.33) totals.
- `splitEqual(venueId, actorUserId, orderId, ways)` — 404 if the order doesn't exist; 409 `ORDER_NOT_MODIFIABLE` if `closed`/`cancelled`; 403 `SPLIT_MODE_DISABLED` unless `split_bill_enabled AND split_equal_enabled`; 422 `SPLIT_WAYS_INVALID` unless `ways` is an integer in `[2, split_max_ways]`; 409 `ORDER_ALREADY_PAID` if `amount_paid > 0`. On success, one transaction creates `ways` child orders (own `order_number`/`ticket_number` via `allocateNumbers`, `parent_order_id`, `split_type='equal'`, `split_sequence` 1..n) each carrying one synthetic `order_item` (`menu_item_id: null`, `item_name_snapshot: 'Split N of M'`, `destination_snapshot: 'none'`, `status: 'served'`), then writes exactly one `order_events` row on the **parent**.
- `listSplits(venueId, orderId)` — the child orders for a parent, ordered by `split_sequence`.
- `mergeBackSplit(venueId, actorUserId, orderId, childId)` — 409 `ORDER_ALREADY_PAID` if the child's own `amount_paid > 0`; otherwise hard-deletes the child (its synthetic item cascades), writes one `order_events` row on the parent, then calls `recomputeOrder` on the parent per the spec's literal wording.

### 2. Routes

`src/modules/orders/splitRoutes.ts` (new, mounted at `/orders/:id` alongside `lifecycleRouter`/`coursesRouter`): `POST /split`, `GET /splits`, `POST /splits/:childId/merge-back`. Wired into `src/modules/orders/routes.ts`.

### 3. Docs

`docs/API.md` (new "Orders — split equal" section), `docs/ERRORS.md` (`SPLIT_MODE_DISABLED`, `SPLIT_WAYS_INVALID`, `ORDER_ALREADY_PAID`, and a note added to the existing `ORDER_NOT_MODIFIABLE` row). No `docs/SCHEMA.md` changes — no columns were added this session.

## Interpretation calls — flagged explicitly

- **Child order totals are never derived through `recomputeOrder`'s generic tax/service-charge formula.** The parent's `grand_total` is already fully taxed and service-charged before it's divided; reapplying `settings.service_charge_percent` to a child's share via the normal formula would double-charge. Instead, each child's `subtotal`/`grand_total` is set directly to its share, with `tax_total`/`service_charge_total`/`discount_total` all zeroed — and the synthetic item mirrors this (`tax_rate_snapshot: 0`).
- **`order_events` are written only against the parent's `order_id`, never a child's.** `OrderEvent.orderId` has no `onDelete` cascade in the schema, and `order_events` is append-only (no row is ever deleted to unblock a hard delete). Since `merge-back` must hard-delete the child order, a child-scoped event would make that delete fail on a foreign-key violation. Recording the split as one event on the parent (payload listing every child id/share) and the merge-back as one event on the parent (payload naming the merged-back child) satisfies "append an event for every state change" without ever needing to delete an event row.
- **Every child order is created with `status: 'served'`, `served_at: now()`, directly at creation.** The synthetic line item is a payment-line artifact, not a real menu item — it never needs to reach a kitchen/bar display or move through `pending → sent → preparing → ready`.
- **`business_date` is inherited as-is from the parent**, including the pre-existing gap (not fixed this session, not in scope) that no code anywhere in this codebase actually populates `Order.businessDate` — it is always `null` in practice today. Splitting doesn't make this any better or worse; it simply copies whatever the parent has.
- **`GET /orders/:id/splits` is gated by `order.view_own`**, the same flat permission `coursesRouter` reuses for its own reads — the session spec names no explicit permission for this one route (unlike the other two, which both name `order.split`).
- **A `closed`/`cancelled` parent blocks a split with 409 `ORDER_NOT_MODIFIABLE`** (the same code the codebase already uses for "can't add items to a closed/cancelled order"). This guard isn't in the spec's own test list, but leaving it out would let a split happen on a bookkeeping order in a terminal state — added as a reasonable extension of the existing convention, not a new code.
- **`ways=1` is rejected** (`SPLIT_WAYS_INVALID`) — the spec's range is literally "2 and `split_max_ways`", and a 1-way split is a no-op that would still burn an order-number allocation for no reason.

## Tests

`tests/split.test.ts` (new, 13 tests): exact conservation for both an evenly divisible (900.00/3) and an unevenly divisible (1000.00/3, remainder-to-child-1) total; `SPLIT_MODE_DISABLED` for `split_bill_enabled=false` and separately for `split_equal_enabled=false`; `SPLIT_WAYS_INVALID` below the minimum and above `split_max_ways`; `ORDER_ALREADY_PAID` once `amount_paid > 0`; children receive distinct `order_number`s different from the parent's; the relaxed `orders_active_table_key` index permits a parent plus 4 children sharing one table; two independent (parentless) orders on the same table are still rejected with `TABLE_ALREADY_HAS_ACTIVE_ORDER`; `merge-back` deletes the target child, leaves the other child and the parent's own totals untouched, and is itself blocked once the child has been paid; and a genuine rollback test that pre-occupies the second child's predicted `order_number` with an unrelated order (forcing the real `(venue_id, order_number)` unique constraint to fail mid-transaction on i=1) and asserts zero orphaned children and zero `order.split` events survive — proving the whole-split-as-one-transaction requirement against a real Postgres constraint rather than a mock.

Full suite: 23 files, 516 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

Per `docs/phase2/README.md`'s numbering: **2f-ii — Split by item / by seat** (uses `OrderItem.splitFromOrderId`/`originalOrderItemId`/`splitLineageChildren`, untouched this session since equal split keeps all items on the parent), then **2f-iii — Merge** (the reverse direction — combining two live orders into one, distinct from this session's merge-*back*, which only undoes a split). This session did not touch payments, shifts, or by-item/by-seat split; those remain exactly as they were before 2f-i.
