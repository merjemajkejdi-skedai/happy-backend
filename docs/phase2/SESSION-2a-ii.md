# Phase 2 Session 2a-ii — Role Activation & Permission Resolution

**Depends on**: 2a-i (schema, seeded manager and bar users).
**Scope**: Permissions only. No feature logic.

## What was implemented

1. **Phase 1 role guard removed** (`src/modules/users/service.ts`): the
   `ALLOWED_ROLES`/`ROLE_NOT_AVAILABLE_IN_PHASE_1` restriction is gone. All
   five roles (`waiter`/`kitchen`/`admin`/`manager`/`bar`) are now
   assignable; an invalid role string fails generic `VALIDATION_ERROR`.
   Confirmed zero live occurrences remain anywhere (repo-wide grep — the
   only hits left are an explanatory code comment, this handoff's own
   history, and the 2a-ii spec file itself).
2. **Full permission registry rewrite** (`src/shared/permissions.ts`):
   - `Permission` type extended to the complete 32-permission set from
     section 2/3 of the spec (added `order.view_own`, `order.view_all`,
     `order.fire`, `order.split`, `order.merge`, `order.merge_approve`,
     `order.void`, `void.approve`, `order.payment`, `order.payment_void`,
     `menu.stock`, `table.view`, `shift.manage`, `reports.view`,
     `reports.export`; renamed `menu.availability` → `menu.eightysix`).
   - `ROLE_PERMISSIONS` static matrix transcribed exactly from section 3's
     table (the ceiling/maximal value for every (S)-marked cell).
   - `resolvePermissions(role, settings, venue)` — settings-dependent
     resolution per section 4: `order.split` (`split_bill_enabled`),
     `order.merge` (`merge_tables_enabled` + waiter-only
     `merge_requires_manager`), `menu.eightysix`
     (`eightysix_requires_manager`, manager/admin exempt), `reports.view`/
     `reports.export` (`reports_visible_to_manager` for manager,
     unconditional for admin), `display.view`/`display.bump` (via
     `resolveDisplayScope`), and `order.void_after_send` (see the dedicated
     note below). `resolvePermissionsForVenue(role, venueId)` is the
     convenience wrapper that fetches venue+settings and resolves in one
     call — this is what every route-level check and `GET /permissions`
     actually use.
   - `resolveDisplayScope(role, venueType)` — kitchen sees kitchen always,
     plus bar only at a `happy_restaurant` venue; bar sees bar only;
     manager/admin see both; waiter sees neither. Returns
     `{kitchen: boolean, bar: boolean}`, not a flat boolean, per the spec's
     explicit instruction.
3. **Manager authority restriction** (section 5, `src/modules/users/service.ts`):
   `checkManagerAuthority(actorRole, targetRole)` returns 403
   `INSUFFICIENT_ROLE_AUTHORITY` when a manager's actor role targets
   `manager`/`admin` — checked in the service layer (not just middleware),
   inside both `createUser` (against the role being assigned) and
   `updateUser` (against both the subject's *current* role and, if
   changing, the *new* role) — so it applies uniformly regardless of which
   route reaches these functions. `assignableRoles(actorRole)` backs
   `GET /users/roles`.
4. **Three new routes**:
   - `GET /permissions` (new module, `src/modules/permissions/`) — resolved
     matrix + `display_scope` for the current user, via
     `resolvePermissionsForVenue`.
   - `GET /users/roles` — roles the current actor may assign.
   - `PATCH /users/:id/role` — dedicated role-change endpoint, same
     `updateUser` service call and rule-5 check as the general
     `PATCH /users/:id`.
5. **`requireResolvedPermission(permission)` and `requireDisplayScope(destination)`**
   added to `src/middleware/rbac.ts`, alongside the existing (still-used-for-
   static-permissions) `requirePermission`. Wired onto every route whose
   permission is (S)-marked and already has a real enforcement point:
   - `PATCH /menu/items/:id/availability` → `requireResolvedPermission('menu.eightysix')`
     (was the flat `requirePermission('menu.availability')`).
   - `GET /displays/kitchen` / `GET /displays/bar` → `requireDisplayScope('kitchen'|'bar')`
     (was the flat `requirePermission('display.view')` for both — meaning a
     kitchen actor could previously call `GET /displays/bar` at any venue
     with no distinction; now scoped correctly).
   - `orderItemsService.voidItem`'s void-after-send check now calls
     `canVoidAfterSend(actorRole, settings)` instead of the stale flat
     `roleHasPermission(actorRole, 'order.void_after_send')` — see the
     dedicated note below for why this mattered.
6. **Non-(S) view permissions wired onto their routes** (no settings
   dependency, so the flat `requirePermission` suffices):
   `table.view` on `GET /tables` and `GET /tables/:id`; `menu.view` on
   `GET /menu`, `GET /menu/categories`, `GET /menu/items`,
   `GET /menu/items/:id`, `GET /menu/modifier-groups`; `order.view_own`/
   `order.view_all` on `GET /orders` and `GET /orders/:id` (custom inline
   logic, not a single middleware — see below).
7. **`order.view_own` vs `order.view_all`** (`src/modules/orders/routes.ts`):
   an actor with `order.view_all` sees everything (existing `?mine=`
   behavior unchanged); an actor with only `order.view_own` is forced to
   `mine=true` regardless of the query param on `GET /orders`, and
   `GET /orders/:id` additionally checks `order.openedByUserId` matches the
   actor. An actor with neither (kitchen) gets 403 on both — a real,
   intentional behavior change from Phase 1, where these routes had no
   permission gate at all.
8. Docs: `docs/API.md` (Users section rewritten, new Permissions section),
   `docs/ERRORS.md` (`ROLE_NOT_AVAILABLE_IN_PHASE_1` row removed,
   `INSUFFICIENT_ROLE_AUTHORITY` added), `src/shared/openapi.ts` (three new
   paths, `POST /users` role enum widened to all five, and — found and fixed
   in passing — the `allowOrderMerge`/`requireReasonOnVoid` fields flagged
   as stale in session 2a-i's handoff are now actually removed from the
   settings schema), `docs/openapi.json` regenerated via
   `npm run openapi:generate`.

## A real inconsistency found and how it was resolved

**`order.void_after_send` for waiter/bar**: section 3's static matrix gives
waiter/bar a ceiling of **N** for this permission. Section 4's resolution
rule says *"for waiter/bar: only when `void_requires_approval` is false...
otherwise the void goes through the approval flow instead"* — describing
them conditionally **gaining** it. Section 3 itself says (S)-rows should
hold their *maximal* value as the ceiling, which only makes sense if the
true ceiling is Y (narrowed down when the setting requires approval) — not
N (which would make section 4's rule permanently dead code, since resolution
can only narrow, never add, per that same section 3 instruction).

Resolved in favor of section 4, since that's the only reading under which
its explicit rule has any effect at all. Implemented as
`canVoidAfterSend(role, settings)` — a direct per-role computation rather
than a narrowing of the static set — called both by `resolvePermissions`
(so `GET /permissions` reports it correctly) and directly by
`orderItemsService.voidItem` (the one real enforcement point). Full detail
and the reasoning is in the code comment on `canVoidAfterSend` in
`src/shared/permissions.ts`.

**This surfaced a real Phase 1 test failure, not just a design question**:
`orderItemsService.voidItem` was still calling the stale flat
`roleHasPermission(actorRole, 'order.void_after_send')` after the registry
rewrite — since I deliberately did *not* put `order.void_after_send` in any
role's static `ROLE_PERMISSIONS` set (matching section 3's N for
waiter/kitchen/bar, and omitting it from manager/admin's sets too, relying
entirely on `canVoidAfterSend`), the flat check started returning `false`
for *everyone*, including admin — breaking a passing Phase 1 test
(`tests/orders.test.ts`, "allows an admin ... to void a sent item"). Fixed
by swapping in `canVoidAfterSend` at that one call site. The Phase 1 test
itself was also rewritten (title and body) to reflect the new
`void_requires_approval`-gated behavior for waiter, since the old assertion
("waiter is always denied") is no longer true and was itself testing a
now-superseded assumption, not a regression.

## Deviations / judgment calls (all within permissions scope, none are feature logic)

- **`GET /orders`/`GET /orders/:id` and `GET /tables`, `GET /menu*` were
  ungated in Phase 1** (no `requirePermission` at all — just
  `authenticate`+`venueScope`). Wiring `order.view_own`/`view_all`,
  `table.view`, `menu.view` onto them is a real behavior change (kitchen
  can no longer call `GET /orders` at all, for instance) — but it's exactly
  what completing the matrix requires, and matches the spec's own explicit
  "every cell of the matrix" test requirement. `menu.view` in particular is
  Y for all five roles today, so it's currently a no-op gate everywhere —
  kept for spec completeness and so there's a real enforcement point to
  test against, not because it denies anyone right now.
- **Considered, then reverted**: I initially added a `PATCH /users/:id/role`-style
  broadening of `EDITABLE_FIELDS` isn't relevant here (that was 2a-i), but I
  did initially over-broaden `checkManagerAuthority`'s call sites before
  settling on exactly two (create + update), and considered adding a
  destination-aware scope to the display *mutation* routes (`/displays/bump`,
  `/displays/items/:id/status`, `/displays/recall`,
  `/displays/items/:id/recall`) to mirror the view-side scoping. Did **not**
  do this: those routes take `order_item_ids`/`order_id`/`itemId`, not a
  `kitchen`/`bar` path segment, so scoping them would require fetching the
  item to check its `destination_snapshot` and comparing against the
  actor's `resolveDisplayScope` — a real business-logic addition ("can bar
  staff bump a kitchen item?"), not stated anywhere in section 4, and out of
  this session's "no feature logic" scope. Flagging explicitly rather than
  silently leaving it unconsidered: **the bump/recall/status-change routes
  still only check the flat `display.bump` permission, not destination
  scope.** A future session should decide whether that's the intended
  behavior (view is scoped, mutation isn't, on the theory that the frontend
  already only shows items an actor could see) or needs the same scoping
  view got.
- **`user.manage`'s `(S)` marker**: interpreted as referring to rule 5's
  actor-vs-target authority restriction (a *finer-grained* authorization
  rule enforced in the service layer), not a `restaurant_settings` boolean
  narrowing the base permission itself — there's no settings column that
  turns `user.manage` on/off, and section 4's bullet list doesn't mention
  one. `resolvePermissions` treats it as unconditional Y for manager/admin
  (matching the static matrix exactly, no narrowing).
- **No new Phase 2 settings fields added to `PATCH /settings`'s
  `EDITABLE_FIELDS`** — that's route/service work for whichever session
  implements the feature each belongs to (courses, split, void, stock,
  payments, shifts), not this permissions-only session.
- **No routes exist yet for**: `order.fire`, `order.split`, `order.merge`,
  `order.merge_approve`, `void.approve`, `order.payment`,
  `order.payment_void`, `menu.stock`, `shift.manage`, `reports.view`,
  `reports.export`. `GET /permissions` resolves all of them correctly
  (exhaustively unit-tested in `tests/permissionMatrix.test.ts`), but there
  is nothing to cross-check enforcement against for these — that's the job
  of the later Phase 2 sessions that build each feature, not a gap in this
  one's own test coverage. `tests/roleActivation.test.ts`'s cross-check
  suite covers every (S) permission that *does* have a real route today
  (`menu.eightysix`, `display.view`/`display.bump` scope,
  `order.void_after_send`).

## Tests — final state

`npx vitest run`: **15 files / 412 tests, all passing.**

New this session:
- `tests/permissionMatrix.test.ts` (194 tests) — every cell of the static
  matrix (32 permissions × 5 roles, minus `order.void_after_send` which is
  covered separately for the reason above) plus focused resolution tests
  for every settings-dependent permission (`order.split`, `order.merge`,
  `order.void_after_send`, `menu.eightysix`, `reports.view`/`export`,
  `display.view`/`display.bump` scope), all pure unit tests against
  `resolvePermissions` directly — written before the implementation.
- `tests/roleActivation.test.ts` (16 tests) — `checkManagerAuthority` unit
  tests, `assignableRoles` unit tests, then real-DB integration tests
  proving the manager restriction end-to-end through `createUser`/
  `updateUser` (manager can't create/edit manager or admin, including
  promoting an existing waiter into either; manager CAN create/edit
  waiter/kitchen/bar; admin is unrestricted), and cross-checks proving
  `resolvePermissionsForVenue`'s output matches what the real
  `requireResolvedPermission`/`requireDisplayScope`/`canVoidAfterSend`
  enforcement points actually do, across role × setting combinations.

Fixed this session (broken by the registry rewrite, now updated to assert
the new intended behavior rather than the old Phase-1-only one):
`tests/menu.test.ts` (86-toggle tests — now async, real venue, resolved
permission), `tests/phase1Guards.test.ts` and `tests/rbac.test.ts` (removed
the now-false "manager/bar have zero permissions" assertions —
superseded by the two new files above), `tests/venueConfig.test.ts`
(rewrote "Manager/bar role rejection" into "Manager/bar roles are
assignable"; fixed three `createUser` call sites missing the new
`actorRole` parameter), `tests/orders.test.ts` (void-after-send test split
into an admin-unconditional case and a waiter-conditional-on-the-setting
case), `tests/openapiSpec.test.ts` (operation count 69→72 for the three new
routes).

## Exact starting point for the next session

- Every route this session touched has real, working enforcement — nothing
  here is scaffolding to revisit. `GET /permissions` is safe for the
  frontend to start consuming immediately.
- If a future session builds a feature whose permission already exists in
  the matrix (split, merge, void approval, payments, stock, shifts,
  reports), it should call `resolvePermissionsForVenue` (or add a
  focused route-level `requireResolvedPermission`/custom check following
  the `menu.eightysix`/`display.view` pattern in this session) rather than
  re-deriving settings logic — the resolution rule for each one is already
  correct and tested.
- **Open question for whoever builds the display bump/recall/status
  routes' real destination scoping** (or explicitly decides it's not
  needed): see the deviation note above.
- `PATCH /settings`'s `EDITABLE_FIELDS` whitelist does not yet include any
  Phase 2 settings column — add the relevant ones when building each
  feature, not preemptively.
