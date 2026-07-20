import { Request, Response, NextFunction } from 'express';
import { sendError } from '../lib/response';
import { roleHasPermission, type Permission } from '../shared/permissions';

// The only place in the codebase that should ever gate a route by role.
// Never write `req.auth.role === 'admin'` at a call site — add the
// capability to shared/permissions.ts and check it here instead.
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return sendError(res, 'UNAUTHORIZED', 'Unauthorised');
    if (!roleHasPermission(req.auth.role, permission)) {
      return sendError(res, 'FORBIDDEN', `Missing permission: ${permission}`);
    }
    next();
  };
}
