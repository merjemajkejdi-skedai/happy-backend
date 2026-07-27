# Session 2b-i — Modifier Groups: Pricing & CRUD

**Status:** Complete. Full suite green (17 files / 442 tests), `tsc --noEmit` clean.

## Implemented

### 1. Pricing resolution (`src/modules/menu/modifierPricing.ts`, new)

Pure function `resolveModifierPrice(option, ordinal, group, settings)`, unit-tested
against all three modes in `tests/modifierPricing.test.ts` (12 tests): `free` forces
0 regardless of stored `price_delta`; `fixed` returns the stored `price_delta`;
`tiered` resolves from `tier_prices` by 1-indexed selection ordinal, carrying the
last applicable tier forward past the highest key, resolving to 0 below the lowest
key. Resolution order is `group.pricing_mode` overriding
`settings.modifier_pricing_mode` — in the current schema `pricing_mode` is `NOT
NULL DEFAULT 'fixed'`, so the settings fallback is defensive/unreachable in
practice, noted in a code comment rather than removed (matches the literal spec
wording). Not inlined anywhere — session 2b-ii (order-item pricing) is expected to
call it directly.

### 2. Write validation (`src/modules/menu/modifiersService.ts`, rewritten)

- `type='single'` → `max_select` must be 1 or null; `type='multiple'` → `max_select`
  null or >= `min_select`; `is_required` → `min_select` >= 1 (Phase 1 rules,
  reconfirmed, unchanged).
- `tier_prices` → rejected unless the option's parent group's `pricing_mode='tiered'`
  (`INVALID_TIER_PRICES`); when allowed, keys must be positive-integer strings,
  values numbers >= 0. Checked on both `createModifierOption` and
  `updateModifierOption` — an update that switches a group's `pricing_mode` away
  from `tiered` does not retroactively strip existing options' stored
  `tier_prices` (no cross-entity cascade was specified; a subsequent option write
  would still be rejected for having stale non-tiered `tier_prices`, but that edge
  case — group flips modes with tiered data left dangling on its options — reads
  data untouched until the client next writes it, not silently mutated).
- `applies_to_destination` → validated via the existing `validateDestination`
  helper (`src/modules/menu/validation.ts`), same rule as category/item
  destinations; skipped when null (no restriction).
- `modifier_max_groups_per_item` → enforced in `setItemModifierGroups` against
  `getVenueContext(venueId).modifierMaxGroupsPerItem` (schema default 10).

`getVenueContext` (`src/modules/menu/validation.ts`) extended to also return
`modifierPricingMode`/`modifierMaxGroupsPerItem` from `restaurant_settings` —
additive, both existing call sites (`categoriesService.ts`, `itemsService.ts`) use
destructured field access and are unaffected.

Three new error codes added to `src/shared/errorCodes.ts`: `INVALID_TIER_PRICES`,
`MODIFIER_GROUP_LIMIT_EXCEEDED`, `MODIFIER_GROUP_HAS_ATTACHED_ITEMS`.

### 3. CRUD surface

`src/modules/menu/modifiersService.ts` new functions: `reorderModifierGroups`
(positional `sort_order` from array order, same convention as
`setItemModifierGroups`), `duplicateModifierGroup` (copies group config + options,
explicitly **not** item attachments, per spec — new group named `"<name> (copy)"`),
`getItemModifierGroups` (resolved groups + options + defaults for one item, same
shape as the menu tree's per-item slice). `deleteModifierGroup` now checks for
attachment to any active menu item first, returning 409
`MODIFIER_GROUP_HAS_ATTACHED_ITEMS`. `listModifierGroups` takes an
`includeInactive` flag (`is_active=false` groups are a distinct, separate concept
from soft-delete — `deleted_at` rows are never returned either way, same
convention as `menu_items.is_active` vs `is_available`).

Routes (`src/modules/menu/modifiersRoutes.ts`, `src/modules/menu/itemsRoutes.ts`),
all under existing `menu.write`/`menu.view` permissions:

```
GET    /menu/modifier-groups              ?include_inactive
POST   /menu/modifier-groups              + pricing_mode/applies_to_destination/display_style/is_active
PATCH  /menu/modifier-groups/:id          + same new fields
DELETE /menu/modifier-groups/:id          409 MODIFIER_GROUP_HAS_ATTACHED_ITEMS if attached
POST   /menu/modifier-groups/:id/options  + is_default/stock_tracked/tier_prices
PATCH  /menu/modifier-options/:id         + same new fields
DELETE /menu/modifier-options/:id
PATCH  /menu/modifier-groups/:id/reorder  new
POST   /menu/modifier-groups/:id/duplicate new
GET    /menu/items/:id/modifier-groups    new — resolved groups + options + defaults
POST   /menu/items/:id/modifier-groups    unchanged (already existed Phase 1); now also 422s MODIFIER_GROUP_LIMIT_EXCEEDED
```

### 4. Menu tree (`src/modules/menu/treeService.ts`)

Each item's `modifierGroups` already carried `options` (Phase 1, spread include);
this session added a `resolvedPricingMode` field per group (`group.pricingMode ??
settings.modifierPricingMode` — same resolution order as
`resolveModifierPrice`, computed once against a `restaurant_settings` row fetched
alongside the other three queries, still zero N+1) and switched the tree's group
query to filter `isActive: true` (inactive groups are hidden from the
customer/POS-facing tree, matching how inactive/unavailable items are already
excluded — not explicitly stated in the spec but consistent with the existing
`is_active` convention elsewhere in this same tree). `is_default` was already on
the wire via the option spread; no change needed there.

### 5. Docs

`docs/API.md` Menu section rewritten for the new/changed rows above. Also fixed a
pre-existing stale reference on the same line (`menu.availability` → the actual
current permission name `menu.eightysix`, renamed in session 2a-ii but never
updated in this doc — noticed while editing the adjacent row, in-scope to fix since
it's the same table row this session was already touching).

`docs/SCHEMA.md`'s `modifier_groups`/`modifier_options` row extended in place with
the eight new Phase 2 columns and what they mean.

`docs/ERRORS.md` Menu section extended with the three new codes.

## Deferred, and why

- **`src/shared/openapi.ts` / `docs/openapi.json` were not updated.** The session
  spec (section 5) explicitly names only `docs/API.md` and `docs/SCHEMA.md`. The
  OpenAPI spec is hand-authored (not derived from live route registration), and
  `tests/openapiSpec.test.ts` asserts against its own static content (a hardcoded
  operation count), not against the actual Express router — so the full suite
  staying green is not a proof the OpenAPI spec is still accurate. `docs/openapi.json`
  now under-reports the true route surface (missing the reorder/duplicate/
  GET-item-modifier-groups routes and the new group/option fields). Flagging this
  explicitly rather than silently letting `docs/API.md`'s claim of it being the
  "full machine-readable contract" go quietly wrong — a future session should
  either fold an OpenAPI sync into its scope or this gets its own small session.
- **A group flipping `pricing_mode` away from `'tiered'` does not strip existing
  options' stored `tier_prices`.** Not specified either way; chosen to leave stored
  data untouched rather than silently deleting it, since `resolveModifierPrice`
  already ignores `tier_prices` for non-tiered modes (dead data, not wrong
  behavior). A future write to that option would still correctly reject new/edited
  `tier_prices` under the now-non-tiered group.
- **`GET /menu/modifier-groups` still isn't gated by `modifiers_enabled`** — same
  as Phase 1, informational only in `docs/API.md`, not enforced server-side. Not
  part of this session's stated scope (section 2's list doesn't include it).

## Tests

`tests/modifiers.test.ts` (new) — group rule validation reconfirmed,
`applies_to_destination` accept/reject, `tier_prices` malformed-shape table test +
allowed-only-when-tiered, `modifier_max_groups_per_item` cap (11 groups rejected,
10 accepted, against the schema default), delete-blocked-while-attached →
succeeds once detached, duplicate (config + options copied, attachments not),
reorder (positional `sort_order`), `include_inactive` listing toggle,
`getItemModifierGroups` resolved shape. `tests/modifierPricing.test.ts` (already
existed from earlier in this session) — all three pricing modes, edge cases.
`tests/menu.test.ts`'s existing tree-shape test extended with `resolvedPricingMode`
and `is_default` assertions.

Full suite: 17 files, 442 tests, all passing. `npx tsc --noEmit` clean (note:
`tsconfig.json`'s `include: ["src"]` means this never type-checks `tests/` —
confirmed by actually running vitest, not just the compile check).

## Next session starting point

2b-ii: order-item modifier pricing — call `resolveModifierPrice` from the
order-item creation/update path instead of the current flat `price_delta` usage;
do not touch modifier *configuration* (this session's surface) beyond what's
needed to read it.
