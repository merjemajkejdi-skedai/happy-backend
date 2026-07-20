import type { UserRole } from '../generated/prisma/client';

// Single source of truth for what each role can do. Nothing in this codebase
// should ever write `role === 'admin'` (or any other role check) inline —
// gate the action behind a Permission and check it through requirePermission
// (middleware/rbac.ts) instead. Adding a new capability means adding it here
// once, not hunting down every route that should respect it.
export type Permission =
  | 'order.create'
  | 'order.send'
  | 'order.void_after_send'
  | 'display.bump'
  | 'settings.write'
  | 'user.manage'
  | 'menu.write'
  | 'table.write'
  | 'table.status'
  | 'menu.availability'
  | 'order.events.read'
  | 'venue.write';

// Phase 1 only defines permissions for waiter/kitchen/admin — those are the
// only roles with routes. manager and bar exist in the UserRole enum for
// forward compatibility but get empty sets: no route checks a manager/bar
// permission yet, so an empty set is exactly correct, not a placeholder.
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  waiter: new Set<Permission>([
    'order.create',
    'order.send',
    'table.status',
    'menu.availability', // front-of-house is often first to spot a stock-out
  ]),
  kitchen: new Set<Permission>([
    'display.bump',
    'menu.availability', // kitchen is the other side of the same real-time signal
  ]),
  admin: new Set<Permission>([
    'order.create',
    'order.send',
    'order.void_after_send', // voiding a sent item is a supervisory action
    'display.bump',
    'settings.write',
    'user.manage',
    'menu.write',
    'table.write',
    'table.status',
    'menu.availability',
    'order.events.read',
    'venue.write',
  ]),
  manager: new Set<Permission>(),
  bar: new Set<Permission>(),
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
