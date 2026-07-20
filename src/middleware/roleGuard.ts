import { Request, Response, NextFunction } from 'express';
import { sendError } from '../lib/response';
import type { StaffRole } from '../types';

export function roleGuard(...allowed: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return sendError(res, 'UNAUTHORIZED', 'Unauthorised');
    if (!allowed.includes(req.user.role)) {
      return sendError(res, 'FORBIDDEN', 'Insufficient permissions');
    }
    next();
  };
}
