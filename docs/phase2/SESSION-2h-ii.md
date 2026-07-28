# Session 2h-ii — Export & Phase 2 Hardening

**Status:** Complete. Full suite green (29 files / 628 tests), `tsc --noEmit` clean. This is the last Phase 2 session — the exit checklist below is fully green and the OpenAPI spec now covers every Phase 2 route.

## Implemented

### 1. Export — `GET /reports/export`

New route in `src/modules/reports/routes.ts`, gated by `reports.export` (settings-resolved — see interpretation call below). `?format=csv|json&section=sales|waiters|voids|items|payments&from&to&shift_id` — both `format` and `section` are required (400 `VALIDATION_ERROR` if missing/invalid; no silent default, since the spec named no default for either).

Every section is a straight slice of the same `computeReport` payload every other `/reports/*` route already serves (`sectionData()`) — "exports must match the on-screen report exactly" is satisfied by construction, not a second formatting path. `format=json` returns the section via the normal `{data, meta}` envelope, unchanged. `format=csv` (`toCsv()`): array-shaped sections (`waiters`, `items`) get one row per element; object-shaped sections (`sales`, `voids`, `payments`) get exactly one row of the object's own top-level keys, with any nested array/object (e.g. `voids.by_reason`) JSON-stringified into its own cell rather than inventing a second, differently-shaped table. Numbers are formatted via `Intl.NumberFormat(venue.locale)` (the venue's own `locale` column, e.g. `sq-AL`). A fixed column list (`ARRAY_SECTION_COLUMNS`) guarantees a header row even when `waiters`/`items` comes back empty. `Content-Disposition: attachment; filename="report-<section>-<from>-<to>.csv"`.

### 2. Pagination audit — no code changes

Every Phase 2 list endpoint that can grow unboundedly at venue scale was already paginated with the Phase 1 `parsePagination`/`buildPaginationMeta` meta shape before this session: `GET /voids`, `GET /voids/pending` (2d-i), `GET /menu/stock/movements` (2e), `GET /shifts` (2g-ii). `GET /orders/:id/splits` and `GET /orders/:id/payments` are deliberately NOT paginated — both are scoped to a single order and bounded by `split_max_ways`/a handful of tender records, the same category as the already-unpaginated `GET /orders/:id/courses` from 2c. No gaps found.

### 3. Idempotency-Key wired onto 5 routes

`src/lib/idempotency.ts`'s `runIdempotent` (previously only on `POST /orders`, `POST /orders/:id/items`, `POST /orders/:id/send`) now also wraps: `POST /orders/:id/split` (all three `split_type` branches share one route string, `'POST /orders/:id/split'`), `POST /orders/:id/merge`, `POST /orders/:id/payments`, `POST /orders/:id/courses/:n/fire`, `POST /orders/:id/items/:itemId/void` (both the 200 and 202 outcomes go through the same handler, since a replay must reproduce whichever one actually happened). `docs/API.md`'s Idempotency section and each route's own table row updated.

### 4. Error code consolidation — no code changes

Audited `src/shared/errorCodes.ts`'s `ERROR_CODES` array and `docs/ERRORS.md` against every code named in `docs/phase2/2h-ii.md` section 3 — all 23 were already present and documented with status + trigger, added incrementally by their originating sessions (2a-ii through 2g-ii). Nothing to consolidate; this was already a running convention across the arc, not a gap that accumulated.

### 5. OpenAPI spec extended to cover every Phase 2 route

`src/shared/openapi.ts` (the hand-authored, programmatically-built source of `docs/openapi.json`) gained 6 new `components.schemas` entries (`StockRow`, `OrderCourse`, `VoidLog`, `Payment`, `Shift`, `ReportPayload`) and 44 new path entries, using the file's existing `op()`/`response()`/`envelope()`/`pathParam()`/`queryParam()` helpers — no new authoring pattern introduced. Two existing paths were extended additively: `GET /menu/items/{id}/modifier-groups` (a `get` alongside the existing `post` — this route existed in the actual API since 2b-i but was missing its GET half from the spec) and `GET /displays/kitchen`/`GET /displays/bar` (added `fire_alerts`/`void_alerts` to the 200 response schema, matching what the routes have actually returned since 2c/2d-ii).

`docs/openapi.json` regenerated from `src/shared/openapi.ts` via a one-off `ts-node` script (not committed — the file itself has always been "hand-authored... and snapshotted," no prior dedicated regen script existed). Diffed old vs. new snapshot programmatically: of the 51 pre-existing paths, only the 3 above changed, and only additively (verified no property was removed or retyped). The `ErrorCode` enum schema also grew from 51 to 84 values — not new work, just the snapshot catching up to `errorCodes.ts`'s actual (already-correct) state, since `docs/openapi.json` had gone stale after Phase 1 and was never regenerated across the whole Phase 2 arc until now. Confirmed zero removed codes.

`tests/openapiSpec.test.ts`'s hard-coded "found the expected number of operations with a 200 response" assertion updated from 72 to 118 (the actual new count, verified via the same test file's own `it.each` loop, which also confirms none of the 46 new operations accidentally types its 200 response as the error envelope — a real bug class this test exists specifically to catch, per its own header comment).

### 6. Phase 2 guard tests — `tests/phase2Guards.test.ts` (new)

Covers the checklist items in `docs/phase2/2h-ii.md` section 5 that are genuinely new this session (not already covered by `tests/phase1Guards.test.ts`, which still passes unmodified and already covers `discount_total`/`pms_*` end-to-end through the full Phase-2-updated codebase):

- **No payment gateway/card-processing code**: `package.json` has no gateway SDK dependency; the `Payment` Prisma model has no card-number/CVV/expiry column; no source file references a card PAN, CVV, or gateway/terminal keyword.
- **No WebSocket/SSE code**: no source file imports `ws`/`socket.io`, constructs a `WebSocket`, or opens an `EventSource`/`text/event-stream` response; neither dependency is declared.
- **No printing code**: no source file talks to a thermal printer or an ESC/POS-style library. `kitchen_printer_enabled`/`bar_printer_enabled` remain inert boolean columns, never read outside the settings serializer.
- **`reports.export` never emits PDF**: the export route only recognizes `csv`/`json`.
- **`discount_total`/`pms_*` stay inert under the new Phase 2 write paths too**: `paymentsService.ts` (the newest and most money-adjacent Phase 2 module) never references `discountTotal`/`pmsFolioId`/`pmsRoomNumber`/`pmsPostedAt` at all.

The venue-scope route audit (`tests/routeSecurity.test.ts`) needed no changes — it walks the live Express app dynamically rather than an allowlist, so every Phase 2 router (already correctly wired with `authenticate`+`venueScope` as their first statement since their own originating sessions) was automatically included and passes.

## Interpretation calls — flagged explicitly

- **A real, pre-existing enforcement gap found and fixed while building the export route's permission gate**: `reports.view`/`reports.export` are settings-dependent (a manager only actually holds them when `restaurant_settings.reports_visible_to_manager` is true — see `resolvePermissions` in `shared/permissions.ts`), but `src/modules/reports/routes.ts` (2h-i) and `src/modules/shifts/routes.ts`'s three read routes (2g-ii) were gating on the STATIC `requirePermission('reports.view')` — the role's ceiling permission, not the resolved one. A manager would keep report/shift-history access even with `reports_visible_to_manager=false` explicitly set, silently defeating the setting. Fixed by switching both to `requireResolvedPermission`, the same pattern already established for `menu.eightysix` (also settings-dependent) in `menu/itemsRoutes.ts` since 2e — not a new pattern, just applying the existing one where it was missed. Directly in scope for this session's own exit-checklist item #1 ("matrix enforced"), which this gap would otherwise have silently failed. No existing test asserted the old (buggy) behavior, so the fix is a pure correctness improvement with zero blast radius — confirmed via the full suite.
- **CSV export's per-section row shape** (array section → one row per element; object section → one row, nested arrays/objects JSON-stringified into their own cell) is a documented judgment call, not specified verbatim in `docs/phase2/2h-ii.md` or `REPORT-PAYLOAD.md`. Chosen because it's a single general rule requiring no per-section hardcoding (so it can't silently drift from `reportService.ts`'s own shape over time), and because a CSV is inherently one flat table — inventing a second row-shape per section (e.g., one table for `voids`' scalars and another for its `by_reason` breakdown) wasn't asked for and adds real complexity for a feature `2h-ii.md` explicitly allows to be "if running long, ship the core plus shift/range routes."
- **`?format`/`?section` on `GET /reports/export` are both required, no default.** The spec's own query-string ordering (`?format=csv|json&from&to&section`) doesn't imply a default for either, and a silent default risks a client getting CSV when it expected JSON (or vice versa) without any error to catch the mistake — safer to require both explicitly.
- **`docs/openapi.json`'s stale `ErrorCode` enum (51 → 84 values) is a byproduct of this session's regeneration, not new scope creep.** It reflects codes added by five prior sessions that never had their snapshot regenerated; fixing it is squarely inside "regenerate the OpenAPI spec covering every Phase 2 route, request, response, and error" (2h-ii.md section 4), and was verified purely additive before being accepted.

## Tests

`tests/phase2Guards.test.ts` (new, 8 tests, all passing) — see section 6 above.

`tests/openapiSpec.test.ts` updated (72 → 118 expected 200-response operations) — passing, including the per-operation envelope-shape check across all 46 new operations.

Full suite: 29 files, 628 tests, all passing (previously 574; +8 phase2Guards, +46 openapiSpec — exact accounting, no other file's test count changed). `tsc --noEmit` clean. Zero Phase 1 tests required modification.

## Phase 2 exit checklist (docs/phase2/2h-ii.md section 7)

| Item | Result | Evidence |
|---|---|---|
| All five roles active, matrix enforced, `GET /permissions` matches enforcement | **PASS** | `tests/permissionMatrix.test.ts`, `tests/roleActivation.test.ts` (2a-ii). This session additionally closed a real matrix-enforcement gap for `reports.view`/`reports.export` — see interpretation calls above. |
| Modifiers validate across multiple groups and snapshot immutably | **PASS** | `tests/modifierPricing.test.ts`, `tests/orderModifiers.test.ts` (2b-i/2b-ii). |
| Courses fire on restaurant and hybrid, 403 on bar | **PASS** | `tests/courseFiring.test.ts` (2c). |
| Every void path writes `restaurant_void_log` | **PASS** | `tests/voidFlow.test.ts` (2d-i) — all four outcomes (auto-approved, pending, approved, rejected) asserted to write a row. |
| Stock decrement is atomic under concurrency | **PASS** | `tests/stock.test.ts` (2e) — includes a real concurrent-request test, not just a logical assertion. |
| Money is conserved across every split mode | **PASS** | `tests/split.test.ts` (equal), `tests/splitByItem.test.ts` (by_item/by_seat) (2f-i/2f-ii) — each asserts parent+children sum to the original. |
| Merge preserves item state and marks the source `'merged'` | **PASS** | `tests/merge.test.ts` (2f-iii). |
| Payments reconcile into `amount_paid` and `amount_due` | **PASS** | `tests/payments.test.ts` (2g-i). |
| One open shift per venue; business date respects the start hour | **PASS** | `tests/shifts.test.ts` (2g-ii) — includes a real DST-transition boundary test. |
| Reports reconcile against raw data and do not drift when the menu changes | **PASS** | `tests/reports.test.ts` (2h-i) — including the CRITICAL snapshot-discipline test (menu/modifier price changed after shift close; finalized report byte-identical before/after). |
| All three seeded venue types exercise their configured Phase 2 features | **PASS** | `happy_restaurant`/`happy_hybrid` exercise courses (`tests/courseFiring.test.ts`) and kitchen display; `happy_bar` exercises the bar display and confirms `COURSES_NOT_ALLOWED_FOR_BAR`; `happy_hybrid` is the primary fixture for `tests/reports.test.ts`'s `destinations`/`courses` null-vs-populated branching. Individually confirmed per-session, not by one aggregate test. |

**All 11 items green.** OpenAPI spec (`docs/openapi.json`, `GET /api/v1/openapi.json`) covers all 95 paths / 118 operations across Phase 1 and Phase 2.

## Next session starting point

Phase 2 is complete per its own exit criteria. No `docs/phase2/2i*.md` or similar exists as of this session (not checked beyond confirming `2h-ii.md` was the last file this arc's numbering names). Any further work is a new phase, outside this session's scope to plan.
