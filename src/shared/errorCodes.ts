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
  'ROLE_NOT_AVAILABLE_IN_PHASE_1',
  'CREDENTIALS_REQUIRED',
  'EMAIL_ALREADY_IN_USE',
  'PIN_ALREADY_IN_USE',
  'DUPLICATE_CREDENTIAL',
  'CANNOT_MODIFY_SELF',
  'EMAIL_REQUIRED_FOR_PASSWORD',

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

  // ── Orders (lifecycle) ───────────────────────────────────────────────────
  'NO_PENDING_ITEMS',
  'TRANSFER_DISABLED',
  'NO_READY_ITEMS',
  'INVALID_STATUS_TRANSITION',
  'ORDER_HAS_UNSERVED_ITEMS',
  'CANCEL_REASON_REQUIRED',
  'CANCEL_AFTER_SEND_NOT_ALLOWED',

  // ── Displays ─────────────────────────────────────────────────────────────
  'DISPLAY_DISABLED',
  'NO_ITEMS_TO_BUMP',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
