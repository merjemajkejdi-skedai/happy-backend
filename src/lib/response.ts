import { Response } from 'express';

// Standard response envelope for every route in this API:
//   success: { "data": ..., "meta": {...} }
//   error:   { "error": { "code", "message", "details"? } }

export type ErrorCode = 'VALIDATION_ERROR' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export function sendData<T>(res: Response, data: T, meta: Record<string, unknown> = {}): void {
  res.json({ data, meta });
}

export function sendError(res: Response, code: ErrorCode, message: string, details?: unknown): void {
  res.status(STATUS_BY_CODE[code]).json({
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}
