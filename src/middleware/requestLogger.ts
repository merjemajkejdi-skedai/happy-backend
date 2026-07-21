import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../shared/logger';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

// Mounted before every router so it wraps every request, authenticated or
// not. Reads req.auth at response-finish time (after `authenticate` has
// already run and populated it, on routes that require it) rather than at
// request-start, so venue_id/user_id are correctly present whenever they
// exist and simply omitted otherwise. Never touches req.body — PINs,
// passwords, hashes, and tokens are never in scope to log by construction.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  req.requestId = requestId;

  res.on('finish', () => {
    logger.info({
      event: 'http.request',
      requestId,
      method: req.method,
      route: req.route ? `${req.baseUrl}${req.route.path}` : req.originalUrl,
      venueId: req.auth?.venueId,
      userId: req.auth?.userId,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
}
