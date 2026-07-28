// The single exported list of every error code this API can return, in any
// module. sendError()'s generic codes and sendDomainError()'s `code`
// parameter (via lib/domainError.ts's err()) both type-check against this —
// a typo or a new code that isn't added here is a compile error, not a
// runtime surprise for the client. See docs/ERRORS.md for what each one
// means and when it fires.
export const ERROR_CODES = [
  // ── Generic (lib/response.ts sendError) ─────────────────────────────────
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',

  // ── Hardening (Prompt 10) ────────────────────────────────────────────────
  'RATE_LIMIT_EXCEEDED',
  'IDEMPOTENCY_IN_PROGRESS',

  // ── Auth ─────────────────────────────────────────────────────────────────
  // (login failures use only the generic codes above — NOT_FOUND,
  // VALIDATION_ERROR, UNAUTHORIZED)

  // ── Settings ─────────────────────────────────────────────────────────────
  'COURSES_NOT_ALLOWED_FOR_BAR',
  'COUNTER_SERVICE_REQUIRED',
  'TABLE_REQUIRED_FOR_ORDER',
  'PIN_LENGTH_OUT_OF_RANGE',

  // ── Users ────────────────────────────────────────────────────────────────
  'CREDENTIALS_REQUIRED',
  'EMAIL_ALREADY_IN_USE',
  'PIN_ALREADY_IN_USE',
  'DUPLICATE_CREDENTIAL',
  'CANNOT_MODIFY_SELF',
  'EMAIL_REQUIRED_FOR_PASSWORD',

  // ── Permissions (Phase 2, session 2a-ii) ────────────────────────────────
  'INSUFFICIENT_ROLE_AUTHORITY',

  // ── Areas ────────────────────────────────────────────────────────────────
  'AREA_HAS_ACTIVE_TABLES',
  'INVALID_REASSIGN_TARGET',

  // ── Tables ───────────────────────────────────────────────────────────────
  'TABLE_NUMBER_REQUIRED',
  'TABLE_NAME_NOT_ALLOWED',
  'TABLE_NAME_REQUIRED',
  'TABLE_NUMBER_NOT_ALLOWED',
  'TABLE_IDENTIFIER_REQUIRED',
  'TABLE_IDENTIFIER_ALREADY_IN_USE',
  'TABLE_NUMBER_ALREADY_IN_USE',
  'TABLE_NAME_ALREADY_IN_USE',
  'TABLE_HAS_ACTIVE_ORDER',
  'TABLE_INACTIVE',
  'INVALID_RANGE',
  'RANGE_TOO_LARGE',

  // ── Menu ─────────────────────────────────────────────────────────────────
  'CATEGORY_HAS_ACTIVE_ITEMS',
  'SKU_ALREADY_IN_USE',
  'INVALID_MAX_SELECT',
  'INVALID_MIN_SELECT',
  'DESTINATION_NOT_AVAILABLE',
  'COURSES_DISABLED',

  // ── Menu — modifier groups (Phase 2, session 2b-i) ──────────────────────
  'INVALID_TIER_PRICES',
  'MODIFIER_GROUP_LIMIT_EXCEEDED',
  'MODIFIER_GROUP_HAS_ATTACHED_ITEMS',

  // ── Orders (core + items) ────────────────────────────────────────────────
  // (TABLE_REQUIRED_FOR_ORDER is reused from Settings above — same meaning,
  // fired here when an order tries counter mode at a venue that requires a
  // table for every order)
  'COUNTER_SERVICE_DISABLED',
  'TABLE_ID_NOT_ALLOWED',
  'TABLE_ID_REQUIRED',
  'TABLE_ALREADY_HAS_ACTIVE_ORDER',
  'ORDER_NOT_MODIFIABLE',
  'MENU_ITEM_UNAVAILABLE',
  'NOTES_NOT_ALLOWED',
  'ITEM_ALREADY_SENT',
  'ITEM_ALREADY_CANCELLED',
  'VOID_AFTER_SEND_NOT_ALLOWED',
  'VOID_REASON_REQUIRED',
  'MODIFIER_SELECTION_INVALID',

  // ── Orders — modifier validation (Phase 2, session 2b-ii) ───────────────
  'MODIFIER_GROUP_REQUIRED',
  'MODIFIER_MIN_NOT_MET',
  'MODIFIER_MAX_EXCEEDED',
  'MODIFIER_OPTION_NOT_IN_GROUP',
  'MODIFIER_DUPLICATE_SELECTION',
  'MODIFIER_DESTINATION_MISMATCH',

  // ── Orders (lifecycle) ───────────────────────────────────────────────────
  'NO_PENDING_ITEMS',
  'TRANSFER_DISABLED',
  'NO_READY_ITEMS',
  'INVALID_STATUS_TRANSITION',
  'ORDER_HAS_UNSERVED_ITEMS',
  'CANCEL_REASON_REQUIRED',
  'CANCEL_AFTER_SEND_NOT_ALLOWED',

  // ── Orders — course firing (Phase 2, session 2c) ─────────────────────────
  'COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE',
  'PREVIOUS_COURSE_NOT_SERVED',
  'COURSE_ALREADY_STARTED',

  // ── Orders — void request/approval (Phase 2, session 2d-i) ───────────────
  'ORDER_HAS_PENDING_VOID',
  'VOID_ALREADY_RESOLVED',
  'VOID_ALREADY_PENDING',

  // ── Menu — stock & 86 (Phase 2, session 2e) ──────────────────────────────
  'INSUFFICIENT_STOCK',
  'ITEM_NOT_STOCK_TRACKED',

  // ── Orders — split (Phase 2, session 2f-i) ───────────────────────────────
  'SPLIT_MODE_DISABLED',
  'SPLIT_WAYS_INVALID',
  'ORDER_ALREADY_PAID',

  // ── Orders — split by item / by seat (Phase 2, session 2f-ii) ────────────
  'SPLIT_ITEM_NOT_IN_ORDER',
  'SPLIT_ITEM_DOUBLE_ALLOCATED',
  'SPLIT_ITEM_CANCELLED',

  // ── Orders — merge (Phase 2, session 2f-iii) ──────────────────────────────
  'MERGE_DISABLED',
  'MERGE_REQUIRES_MANAGER',
  'MERGE_ORDER_HAS_SPLIT',

  // ── Orders — payments (Phase 2, session 2g-i) ─────────────────────────────
  'PAYMENT_METHOD_DISABLED',
  'PAYMENT_EXCEEDS_DUE',
  'PARTIAL_PAYMENT_NOT_ALLOWED',
  'PAYMENT_ALREADY_VOIDED',
  'ORDER_NOT_SETTLED',

  // ── Shifts (Phase 2, session 2g-ii) ───────────────────────────────────────
  'SHIFT_ALREADY_OPEN',
  'SHIFT_HAS_OPEN_ORDERS',

  // ── Displays ─────────────────────────────────────────────────────────────
  'DISPLAY_DISABLED',
  'NO_ITEMS_TO_BUMP',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
