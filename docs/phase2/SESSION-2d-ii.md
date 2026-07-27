# Session 2d-ii — Void & Fire Display Alerts

**Status:** Complete. Full suite green (21 files / 493 tests), `tsc --noEmit` clean.

## Implemented

### 1. Migration

New column `restaurant_void_log.void_alert_acked_at timestamptz null` — additive, migration `20260727132613_void_alert_ack`. Distinct from the existing `kitchen_notified_at` (first-surfaced marker, set once and never overwritten) — this is the dismissal marker, same two-column pattern session 2c used for fire alerts (`fired_at` for timing, `fire_alert_acked_at` for dismissal). Documented in `docs/phase2/SCHEMA-ADDITIONS.md`'s `restaurant_void_log` section as a 2d-ii addendum.

### 2. `buildVoidAlert` (`src/modules/displays/serializers.ts`)

Shares the fire alert's envelope fields (`id`/`type`/`headline`/`acknowledged`) per section 6's "unified envelope," `type: 'void'`. One genuine difference from fire alerts worth flagging: **the void headline does not uppercase the item name or location** — only the `"VOID"` prefix is uppercase (`"VOID — Ribeye 300g — Table 5"`, matching the spec's own example exactly), whereas fire alerts uppercase both the course name and the location (`"FIRE MAINS — TABLE 5"`). Implemented literally per each spec's own example rather than assuming symmetry between the two alert types.

### 3. `displays/service.ts`

- `buildVoidAlerts(venueId, destination?)` — the shared query: `stage='after_send' AND status IN ('approved','auto_approved') AND void_alert_acked_at IS NULL`, optionally filtered by `destination_snapshot`. Gated entirely by `settings.void_alerts_kitchen` (see interpretation note below). Stamps `kitchen_notified_at` on any row that doesn't have it yet, in the same call — `updateMany` only targets rows where it's currently null, so "set once, never overwritten" holds by construction.
- `getEmbeddedVoidAlerts(venueId, destination)` — used inside `getDisplay` for the per-destination `void_alerts` array on `GET /displays/kitchen`/`/bar`.
- `getVoidAlerts(venueId)` — the standalone `GET /displays/void-alerts` route, no destination filter (see interpretation note below).
- `ackVoidAlert(venueId, id)` — 404 if the void log doesn't exist, otherwise unconditionally sets `void_alert_acked_at` (idempotent: acking twice just writes the timestamp again, the resulting "gone from the list" state doesn't change).

### 4. Routes

`GET /displays/void-alerts` (`display.view`), `POST /displays/void-alerts/:id/ack` (`display.bump`) in `src/modules/displays/routes.ts`. `GET /displays/kitchen`/`/bar` additively gain a `void_alerts` array alongside the existing `fire_alerts` one.

### 5. Docs

`docs/API.md` (new void-alerts section), `docs/phase2/SCHEMA-ADDITIONS.md` (2d-ii addendum to `restaurant_void_log`). No new error codes this session — `ackVoidAlert`'s 404 reuses the generic `NOT_FOUND` code, same as `ackFireAlert`.

## Interpretation calls — flagged explicitly

- **`void_alerts_kitchen` gates both kitchen and bar alerts**, not just kitchen ones, despite its name. The schema has no separate `void_alerts_bar` flag, and section 2's gate condition ("all of: stage=after_send, settings.void_alerts_kitchen is true, void reached approved/auto_approved") is written unqualified by destination, while section 4 ("routing") explicitly describes bar-destination voids reaching the bar display. Read as one global toggle named after its primary motivating case (kitchen staff mid-prep), not a kitchen-only gate.
- **`GET /displays/void-alerts` returns both destinations combined**, not scoped to one. Its path has no `/kitchen` or `/bar` segment (unlike 2c's `GET /displays/kitchen/fire-alerts`), which is the literal signal this route is meant to be a consolidated feed rather than mirroring the per-destination pattern. The properly destination-filtered arrays are the embedded `void_alerts` on `GET /displays/kitchen`/`/bar`, which do the actual per-item routing described in section 4.
- **`voided_by` in the payload is the log's `approved_by_name`**, not `requested_by_name` — read as "who actually executed the void" (the approval action, whether auto or manual), since that's the person whose authority the void ultimately rests on. For an auto-approved void these are the same person anyway (2d-i sets both fields to the acting user).

## Tests

`tests/voidAlerts.test.ts` (new, 8 tests) — alert only after send (before-send void produces none), `void_alerts_kitchen=false` suppresses entirely, no alert while `pending_approval` / one appears on approval, destination routing (a voided bar item never on the kitchen alert list and vice versa), ack removes it and is idempotent, `kitchen_notified_at` set once and unchanged on a second surfacing, and fire + void alerts coexisting in one `GET /displays/kitchen` response with correct `type` discriminators.

Full suite: 21 files, 493 tests, all passing. `tsc --noEmit` clean.

## Next session starting point

2e (per `docs/phase2/2e.md`, not yet read this session) — the stock-restoration TODO left in `voidService.ts` (both the auto-approve and approve paths in session 2d-i) is explicitly flagged there as 2e's responsibility; this session did not touch it.
