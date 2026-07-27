# Session 2b-ii — Modifiers on Order Items

**Status:** Complete. Full suite green (18 files / 459 tests), `tsc --noEmit` clean.

## Implemented

### 1. Shared modifier resolution (`src/modules/orders/orderItemsService.ts`)

Replaced the old `validateModifierSelection` (Phase 1) with `resolveModifierSelections(venueId, menuItemId, itemDestination, rawOptionIds, settings)`, used by `addItem`, `updateItem`, and the new `setItemModifiers`. It always fetches the real option+group rows first (existence is referential integrity, not a business rule — `MODIFIER_SELECTION_INVALID` fires regardless of `require_modifier_validation`), then, only while `settings.require_modifier_validation` is true, runs the full matrix from section 1:

- duplicate option ids in the payload → `MODIFIER_DUPLICATE_SELECTION`
- every selected option's group must be attached to the item → `MODIFIER_OPTION_NOT_IN_GROUP`
- a group's `applies_to_destination` must match the item's destination → `MODIFIER_DESTINATION_MISMATCH`
- an attached required group with zero selections → `MODIFIER_GROUP_REQUIRED`
- selection count vs `min_select`/`max_select` (and the `type='single'` max-1 case, which reuses `MODIFIER_MAX_EXCEEDED` — the spec's 6-code list doesn't have a separate code for it, and it's the same "exceeded the cap" shape) → `MODIFIER_MIN_NOT_MET` / `MODIFIER_MAX_EXCEEDED`

When the flag is false, every rule above is skipped but resolution still runs, so snapshots are still written correctly for whatever real options were submitted (including duplicates, which are no longer deduplicated — each payload entry becomes its own `order_item_modifiers` row, since "still snapshot correctly" means faithfully, not silently cleaned up).

**Ordinal for tiered pricing** is the 1-indexed position of an option within its own group *as submitted in the payload* — the only signal available for "1st pick free, 2nd costs 50...". Verified explicitly in `tests/orderModifiers.test.ts` that resubmitting the same three tiered options in a different order changes which one resolves to which tier price (ordinal tracks submission order, not option identity). Documented as a design decision in code comments since the spec doesn't pin this down.

### 2. Snapshotting & totals

`price_delta_snapshot` is now always computed via `resolveModifierPrice` (from session 2b-i's `src/modules/menu/modifierPricing.ts` — not reimplemented) instead of the raw stored `price_delta`. `modifiers_total`/`line_total` math is unchanged: `modifiers_total = sum(price_delta_snapshot)`, `line_total = (unit_price_snapshot + modifiers_total) * quantity`, both `Prisma.Decimal` throughout.

### 3. New route

```
PATCH /orders/:id/items/:itemId/modifiers    order.create
```

`src/modules/orders/orderItemsRoutes.ts` + `orderItemsService.setItemModifiers`. Replaces an item's modifier selections only, while `pending`; 409 `ITEM_ALREADY_SENT` otherwise. Revalidates via the same shared resolver and recomputes `modifiers_total`/`line_total`/order totals. Writes an `item.modifiers_updated` order event (new `event_type` string — `order_events.event_type` is a plain column, no enum, so no schema change needed).

### 4. Error codes & docs

`src/shared/errorCodes.ts`: added `MODIFIER_GROUP_REQUIRED`, `MODIFIER_MIN_NOT_MET`, `MODIFIER_MAX_EXCEEDED`, `MODIFIER_OPTION_NOT_IN_GROUP`, `MODIFIER_DUPLICATE_SELECTION`, `MODIFIER_DESTINATION_MISMATCH`. `docs/ERRORS.md` documents all six plus clarified what `MODIFIER_SELECTION_INVALID` now means (existence only, no longer the catch-all for business rules). `docs/API.md` updated for the new route and gating flag on the three item-modifier routes — not explicitly required by this session's spec (only `docs/ERRORS.md` was named), but a proportionate in-scope doc-sync for the route this session actually added.

### 5. Existing Phase 1 tests updated, not reverted

`tests/orders.test.ts`'s "Modifier validation matrix" describe block had two assertions hardcoded to the old catch-all `MODIFIER_SELECTION_INVALID` for what are now `MODIFIER_GROUP_REQUIRED` and `MODIFIER_MAX_EXCEEDED` — this is the new intended behavior this session introduces, not a regression, so the test assertions were updated in place (same pattern as session 2a-ii's test-file updates). The third assertion (nonexistent option id → `MODIFIER_SELECTION_INVALID`) was correct already and untouched.

## Deferred, and why

- **`src/shared/openapi.ts` / `docs/openapi.json` not updated** — same reasoning as 2b-i's handoff: hand-authored, not route-derived, `tests/openapiSpec.test.ts` only checks internal consistency of the static file, not the live router, so this doesn't block a green suite. Now two sessions behind the real route surface (2b-i's group CRUD additions plus this session's `PATCH .../modifiers`). Flagging again — this should get its own sync session before it drifts further.
- **A group flipping into/out of `pricing_mode='tiered'` doesn't retroactively touch already-placed order items** — by design (snapshot discipline), confirmed by the CRITICAL immutability test in `tests/orderModifiers.test.ts`.
- **No new permission was added for `PATCH .../modifiers`** — spec names `order.create`, same as `POST`/`PATCH` on the item itself; no interpretation needed.

## Tests

`tests/orderModifiers.test.ts` (new, dedicated fixture — 6 purpose-built modifier groups covering required/single/min-max/destination-mismatch/unattached-option/free/tiered on two menu items) — required-group rejected, single-type two-selections rejected, min/max at n-1/n/n+1 (both boundaries), option-not-in-attached-group rejected, duplicate-id rejected, destination-mismatch rejected, free mode zeroes deltas, tiered resolves by submission-order ordinal (including the reordered-options proof), multi-group totals math, modifier-edit blocked after send + succeeds while pending + still revalidates, `require_modifier_validation=false` skips every rule but still snapshots (and still enforces existence), and the CRITICAL snapshot-immutability test (change an option's `tier_prices` after ordering, assert the existing order item's totals/snapshots are untouched).

`tests/orders.test.ts` — two stale assertions updated to the new codes; rest of the file (numbering, table constraints, void rules, tax totals) unaffected and still green.

Full suite: 18 files, 459 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

2c (per `docs/phase2/2c.md`, not yet read this session) is the next file in the Phase 2 arc. This session did not touch anything beyond order-item modifier validation/snapshotting/the one new route — menu-side modifier CRUD (2b-i) and modifier configuration are untouched.
