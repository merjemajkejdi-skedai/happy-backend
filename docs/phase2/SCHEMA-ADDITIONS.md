# Phase 2 Schema Additions — 8 New Tables

Authoritative for session 2a-i.

Conventions from Phase 1 apply to all: `id uuid PK DEFAULT gen_random_uuid()`,
`created_at` and `updated_at timestamptz NOT NULL DEFAULT now()`. None of these
are soft-deletable.

**Creation order:** `shifts` must be created before `restaurant_void_log` and
`payments`, which reference it. Then wire the two deferred foreign keys:

- `orders.shift_id` → `shifts.id`
- `order_items.void_id` → `restaurant_void_log.id`

---

## 1. `order_courses`

Tracks fire state per course per order. Needed as its own table because "which
courses have fired" cannot be inferred from item timestamps when a course has
zero items.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| order_id | uuid | NOT NULL FK→orders ON DELETE CASCADE |
| course_number | smallint | NOT NULL |
| course_name_snapshot | text | NOT NULL |
| status | course_status | NOT NULL DEFAULT 'pending' |
| fired_at | timestamptz | NULL |
| fired_by_user_id | uuid | NULL FK→users |
| first_ready_at | timestamptz | NULL |
| all_served_at | timestamptz | NULL |
| item_count | smallint | NOT NULL DEFAULT 0 |

```
UNIQUE(order_id, course_number)
INDEX (venue_id, status, fired_at)
```

`course_name_snapshot` is copied from `settings.course_names` at row creation.
Renaming courses later must not rewrite history.

---

## 2. `restaurant_void_log`

Standalone reporting table. Deliberately NO cascade from `orders` or `users` — it
must survive their deletion, which is why names are snapshotted.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| business_date | date | NOT NULL |
| shift_id | uuid | NULL FK→shifts |
| order_id | uuid | NOT NULL — no FK cascade |
| order_number | int | NOT NULL |
| order_item_id | uuid | NULL — no FK cascade |
| item_name_snapshot | text | NOT NULL |
| category_name_snapshot | text | NOT NULL |
| quantity | smallint | NOT NULL |
| unit_price_snapshot | numeric(10,2) | NOT NULL |
| void_value | numeric(10,2) | NOT NULL |
| destination_snapshot | destination | NOT NULL |
| stage | void_stage | NOT NULL |
| status | void_status | NOT NULL |
| reason_code | text | NULL |
| reason_text | text | NULL |
| requested_by_user_id | uuid | NOT NULL FK→users |
| requested_by_name | text | NOT NULL |
| approved_by_user_id | uuid | NULL FK→users |
| approved_by_name | text | NULL |
| requested_at | timestamptz | NOT NULL DEFAULT now() |
| resolved_at | timestamptz | NULL |
| rejection_reason | text | NULL |
| kitchen_notified_at | timestamptz | NULL |
| table_label_snapshot | text | NULL |

```
INDEX (venue_id, business_date)
INDEX (venue_id, status) WHERE status = 'pending_approval'
INDEX (venue_id, shift_id)
```

`void_value` = `quantity * (unit_price_snapshot + modifiers_total)`.

---

## 3. `menu_item_stock`

Separate from `menu_items` so per-order stock churn doesn't write to the menu
table.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| menu_item_id | uuid | NOT NULL FK→menu_items ON DELETE CASCADE |
| business_date | date | NOT NULL |
| mode | stock_mode | NOT NULL |
| starting_quantity | int | NULL |
| current_quantity | int | NULL |
| reserved_quantity | int | NOT NULL DEFAULT 0 |
| is_86ed | boolean | NOT NULL DEFAULT false |
| eightysixed_at | timestamptz | NULL |
| eightysixed_by_user_id | uuid | NULL FK→users |
| eightysix_reason | text | NULL |
| restored_at | timestamptz | NULL |

```
UNIQUE(menu_item_id, business_date)
INDEX (venue_id, business_date, is_86ed)
```

`menu_items.is_available` (Phase 1) stays as the manual, non-dated switch.
`menu_item_stock.is_86ed` is the dated, service-level switch. Both are consulted;
do not conflate them.

---

## 4. `stock_movements`

Append-only. No `updated_at` — rows are never modified.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| menu_item_id | uuid | NOT NULL FK→menu_items |
| business_date | date | NOT NULL |
| delta | int | NOT NULL |
| reason | text | NOT NULL |
| order_item_id | uuid | NULL |
| actor_user_id | uuid | NULL FK→users |
| balance_after | int | NOT NULL |
| created_at | timestamptz | NOT NULL DEFAULT now() |

```
INDEX (venue_id, menu_item_id, business_date)
```

`reason` is one of: `order`, `void`, `manual_adjust`, `restock`, `day_open`.

---

## 5. `payments`

Capture only. No processing, no gateway, no card data.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| order_id | uuid | NOT NULL FK→orders |
| shift_id | uuid | NULL FK→shifts |
| business_date | date | NOT NULL |
| method | payment_method | NOT NULL |
| amount | numeric(10,2) | NOT NULL CHECK (amount > 0) |
| tip_amount | numeric(10,2) | NOT NULL DEFAULT 0 |
| received_amount | numeric(10,2) | NULL |
| change_amount | numeric(10,2) | NULL |
| reference | text | NULL |
| taken_by_user_id | uuid | NOT NULL FK→users |
| taken_by_name | text | NOT NULL |
| is_voided | boolean | NOT NULL DEFAULT false |
| voided_by_user_id | uuid | NULL FK→users |
| voided_reason | text | NULL |

```
INDEX (venue_id, business_date, method)
INDEX (order_id)
```

`reference` holds a voucher code, last 4 digits, or free text. **Never a full
card number** — there is no card data in this system.

---

## 6. `shifts`

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| business_date | date | NOT NULL |
| name | text | NULL |
| status | shift_status | NOT NULL DEFAULT 'open' |
| opened_at | timestamptz | NOT NULL DEFAULT now() |
| opened_by_user_id | uuid | NOT NULL FK→users |
| closed_at | timestamptz | NULL |
| closed_by_user_id | uuid | NULL FK→users |
| opening_float | numeric(10,2) | NOT NULL DEFAULT 0 |
| closing_cash_counted | numeric(10,2) | NULL |
| cash_variance | numeric(10,2) | NULL |
| notes | text | NULL |

```
PARTIAL UNIQUE INDEX (venue_id) WHERE status = 'open'
INDEX (venue_id, business_date)
```

The partial unique index is the enforcement mechanism for one open shift per
venue. Do not rely on application logic alone.

---

## 7. `shift_reports`

Materialized snapshot so a closed shift's numbers never drift.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| shift_id | uuid | NULL FK→shifts |
| period_start | timestamptz | NOT NULL |
| period_end | timestamptz | NOT NULL |
| generated_at | timestamptz | NOT NULL DEFAULT now() |
| generated_by_user_id | uuid | NOT NULL FK→users |
| payload | jsonb | NOT NULL |
| is_final | boolean | NOT NULL DEFAULT false |

```
INDEX (venue_id, period_start, period_end)
INDEX (shift_id)
```

`payload` holds the full computed report. Session 2h-i defines its structure (see
`REPORT-PAYLOAD.md`); session 2a-i only creates the column.

---

## 8. `approval_requests`

Generic by design. Void approval is the only Phase 2 consumer; discount and comp
approvals land in Phase 3 without a schema change.

| column | type | constraints |
|---|---|---|
| venue_id | uuid | NOT NULL FK→venues |
| request_type | text | NOT NULL |
| subject_id | uuid | NOT NULL |
| order_id | uuid | NULL FK→orders |
| status | void_status | NOT NULL DEFAULT 'pending_approval' |
| requested_by_user_id | uuid | NOT NULL FK→users |
| required_role | user_role | NOT NULL |
| resolved_by_user_id | uuid | NULL FK→users |
| requested_at | timestamptz | NOT NULL DEFAULT now() |
| resolved_at | timestamptz | NULL |
| expires_at | timestamptz | NULL |
| payload | jsonb | NOT NULL DEFAULT '{}' |

```
INDEX (venue_id, status) WHERE status = 'pending_approval'
INDEX (request_type, subject_id)
```

`request_type` is `'void'` in Phase 2. `subject_id` points at
`restaurant_void_log.id`. The `void_status` enum is reused here rather than
defining a parallel one.
