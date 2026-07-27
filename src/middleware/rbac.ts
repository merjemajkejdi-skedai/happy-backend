import { Request, Response, NextFunction } from 'express';
import { sendError } from '../lib/response';
import { roleHasPermission, resolvePermissionsForVenue, type Permission } from '../shared/permissions';

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

// For permissions marked (S) in docs/phase2/2a-ii.md's matrix — checking
// only the static registry isn't enough, since the effective grant depends
// on restaurant_settings (and, for display.view/display.bump, venue_type).
// Use this instead of requirePermission() for those; use requirePermission
// for everything else (it's a static Set lookup, no DB round trip, cheaper).
export function requireResolvedPermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return sendError(res, 'UNAUTHORIZED', 'Unauthorised');
    const resolved = await resolvePermissionsForVenue(req.auth.role, req.auth.venueId);
    if (!resolved.permissions.includes(permission)) {
      return sendError(res, 'FORBIDDEN', `Missing permission: ${permission}`);
    }
    next();
  };
}

// display.view/display.bump aren't a flat yes/no — which specific display
// (kitchen, bar) an actor may reach depends on role + venue_type (see
// resolveDisplayScope). Use on routes that are unambiguously about ONE
// display (GET /displays/kitchen, GET /displays/bar).
export function requireDisplayScope(destination: 'kitchen' | 'bar') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return sendError(res, 'UNAUTHORIZED', 'Unauthorised');
    const resolved = await resolvePermissionsForVenue(req.auth.role, req.auth.venueId);
    if (!resolved.displayScope[destination]) {
      return sendError(res, 'FORBIDDEN', `Missing permission: display.view (${destination})`);
    }
    next();
  };
}
