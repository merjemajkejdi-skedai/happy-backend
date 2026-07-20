import { Request, Response, NextFunction } from 'express';
import type { StaffRole } from '../types';

export function roleGuard(...allowed: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Unauthorised' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    next();
  };
}
