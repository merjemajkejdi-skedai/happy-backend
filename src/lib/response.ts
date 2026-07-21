import { Response } from 'express';
import type { ErrorCode } from '../shared/errorCodes';

// Standard response envelope for every route in this API:
//   success: { "data": ..., "meta": {...} }
//   error:   { "error": { "code", "message", "details"? } }

export type GenericErrorCode = 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<GenericErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export function sendData<T>(res: Response, data: T, meta: object = {}): void {
  res.json({ data, meta });
}

export function sendError(res: Response, code: GenericErrorCode, message: string, details?: unknown): void {
  res.status(STATUS_BY_CODE[code]).json({
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

// For business-rule errors that need their own specific code rather than one
// of the generic ones above (e.g. 422 COURSES_NOT_ALLOWED_FOR_BAR) — the
// envelope shape is identical, this just decouples the code string from a
// fixed status mapping. `code` is typed against the full ErrorCode union
// (shared/errorCodes.ts), not just the 6 generic ones.
export function sendDomainError(res: Response, status: number, code: ErrorCode, message: string, details?: unknown): void {
  res.status(status).json({
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}
