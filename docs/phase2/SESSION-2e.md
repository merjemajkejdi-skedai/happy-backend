# Session 2e — Stock & 86

**Status:** Complete. Full suite green (22 files / 503 tests), `tsc --noEmit` clean. No migration needed — `menu_item_stock`/`stock_movements` were already fully created in 2a-i; this session is the first to write real logic against them.

## Implemented

### 1. `is_orderable` / `stock_remaining` — one shared computation

`computeIsOrderable`/`computeStockRemaining` in `src/modules/menu/stockService.ts`, implementing section 1's formula literally: `is_active AND is_available AND NOT is_86ed AND (mode='none' OR current_quantity > 0 OR allow_negative_stock)`. No stock row at all (never tracked) behaves like `mode='none'`. Wired into `serializeMenuItem` (now takes `stock`/`allowNegativeStock` params — every call site updated), `treeService.getMenuTree` (one batched stock query for the whole tree, not one per item), and `itemsRoutes.ts`'s list/get/create/update/availability responses. `menu_version` now also hashes in the fetched stock rows' `updated_at`, so an 86 toggle or quantity change (both on `menu_item_stock`, a different table from everything the version hash previously covered) correctly bumps it.

### 2. Atomic decrement — `decrementStockForOrder`

Wired into `orderItemsService.addItem`'s own transaction. Reads the stock row once first only to learn whether the item is tracked at all today (`mode`/`id` aren't subject to the race, only `current_quantity` is), then does the actual check-and-decrement as a single `UPDATE menu_item_stock SET current_quantity = current_quantity - $qty WHERE id = $id AND (current_quantity >= $qty OR $allowNegative) RETURNING current_quantity` via `tx.$queryRaw`. Zero rows back means insufficient stock → the transaction throws a small local `StockDecrementFailure` (carrying the domain error), caught just outside `$transaction` and converted back to the normal `OrderItemResult` shape — same pattern this module already uses for Prisma constraint-violation catches. Never reads `current_quantity` and branches on it before writing.

Verified with a genuine concurrency test: 6 concurrent `addItem` calls against a stock of 1 — exactly one succeeds, the rest get `INSUFFICIENT_STOCK`, final `current_quantity` is 0.

### 3. Restoration — replaces the two TODOs from 2d-i

`restoreStockForVoid` finds the *exact* original decrement via `stock_movements` (`reason='order'`, keyed by `order_item_id` — a plain non-FK reference chosen precisely so this lookup survives regardless of how much later the void happens) and reverses that exact delta against the same `business_date`'s row. This is more robust than assuming "today" at restoration time — correct even for a void on a later business day than the original order, not just the common same-day case. Wired into both `voidService.requestVoid`'s auto-approve branch and `approveVoid` — never the pending-request branch, matching "restore on approval, not on request," which the dedicated test confirms explicitly (stock stays decremented while `pending_approval`, restores only once `approveVoid` runs).

### 4. Admin operations

- `eightysixItem` / `restoreItem` — the dated, service-level 86 (`menu_item_stock.is_86ed`), distinct from Phase 1's `menu_items.is_available`. `restoreItem` on an item that isn't currently 86'd is an idempotent no-op success, matching this whole session arc's established idempotency convention (fire/hold/void-ack).
- `patchItemStock` — `{starting_quantity}` (create-or-reset today's row, movement reason `manual_adjust`) or `{delta}` (adjust an existing row only — 422 `ITEM_NOT_STOCK_TRACKED` if none exists yet; reason `restock` if the delta is positive, `manual_adjust` otherwise).
- `bulkSetStock`, `dayOpen`, `listStock`, `listMovements`, `listLowStock` — see routes below.

### 5. Routes

`src/modules/menu/itemsRoutes.ts`: `POST /:id/86`, `POST /:id/restore`, `PATCH /:id/stock` (all item-scoped, `menu.eightysix` or `menu.stock`). `src/modules/menu/stockRoutes.ts` (new) + wired into `menuRouter`: `GET /stock`, `GET /stock/movements`, `GET /stock/low`, `POST /stock/bulk-set`, `POST /stock/day-open`.

### 6. Docs

`docs/API.md` (new Menu — stock section, updated availability/86/restore/stock rows), `docs/ERRORS.md` (`INSUFFICIENT_STOCK`, `ITEM_NOT_STOCK_TRACKED`). No schema doc changes — no columns were added.

## Interpretation calls — flagged explicitly

- **An item's stock `mode` is venue-wide, not per-item.** `restaurant_settings.stock_tracking_mode` is the one setting; there's no per-`menu_item` override field anywhere in the schema. Every row created by `patchItemStock`/`bulkSetStock`/`dayOpen` uses `settings.stockTrackingMode` at creation time. `eightysixItem` is the one exception — a manual 86 can happen on an item that's never been quantity-tracked at all, so it creates a row with whatever the venue's mode is, `is_86ed=true`, and no meaningful starting/current quantity implied by that alone.
- **`day-open` only carries forward items that have *ever* had a stock row before**, seeded from each one's most recent prior row's `starting_quantity`. It never invents a starting quantity for an item that's never been explicitly stocked via `patchItemStock`/`bulkSetStock`. This is the more conservative of two readings — the spec doesn't say which items participate — and is directly testable ("daily reset creates fresh rows," "idempotent for a given business_date"), both covered.
- **`POST /menu/stock/bulk-set`'s payload is best-effort** — `{items: [{menu_item_id, starting_quantity}]}` — the spec gives no example (unlike, say, the fire-alert JSON in session 2c), and it isn't in this session's own test list. Implemented and reasonably designed, but genuinely unverified against whatever the real intended shape is.
- **`is_orderable`/`stock_remaining` are exposed camelCase** (`isOrderable`/`stockRemaining`) like every other menu-module field, not the snake_case spelling used in the spec's prose — the displays module is the only part of this API with a genuinely locked snake_case wire shape, and this isn't it.
- **`GET /menu/stock` and `GET /menu/stock/low` are gated by `menu.view`** — the session spec's own route list names no permission for either (every other route in that list has one). Treated as ordinary menu-adjacent reads.
- **`business_date` for stock is computed independently of `ticket_number_reset`.** A new `businessDateFor(timezone)` helper (NOT a reuse of `orders/validation.ts`'s `computeBusinessDate`, which is specifically about the ticket-numbering setting and has a non-daily epoch fallback that makes no sense here) — stock always resets by calendar day in the venue's own timezone, unconditionally.

## Tests

`tests/stock.test.ts` (new, 10 tests) — the genuine concurrency race (6 concurrent adds against a stock of 1, exactly one succeeds), oversell prevented at exactly zero, `allow_negative_stock` permits going below, auto-86 at zero, void restores on approval not on request (with an explicit "still decremented while pending" assertion), daily reset creates fresh rows idempotently, `is_orderable` false for each of inactive/unavailable/86'd/zero-stock (pure-function unit tests), `eightysix_requires_manager` flips `requireResolvedPermission('menu.eightysix')` dynamically (reusing the exact pattern from `menu.test.ts`'s 2a-ii coverage), every stock change (order/manual/restock) writes a movement with the correct `balance_after`, low-stock list accurate at the threshold boundary.

Full suite: 22 files, 503 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

Per `docs/phase2/2f-i.md` / `2f-ii.md` / `2f-iii.md` (not yet read this session) — the next arc in `docs/phase2/README.md`'s numbering. This session did not touch payments, shifts, or split/merge; those remain exactly as they were before 2e.
