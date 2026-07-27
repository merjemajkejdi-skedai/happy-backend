import type { UserRole, RestaurantSettings, Venue, VenueType } from '../generated/prisma/client';
import { prisma } from '../db/prisma';

// Single source of truth for what each role can do. Nothing in this codebase
// should ever write `role === 'admin'` (or any other role check) inline —
// gate the action behind a Permission and check it through requirePermission
// / requireResolvedPermission (middleware/rbac.ts) instead. Adding a new
// capability means adding it here once, not hunting down every route that
// should respect it.
export type Permission =
  | 'order.create'
  | 'order.view_own'
  | 'order.view_all'
  | 'order.send'
  | 'order.fire'
  | 'order.serve'
  | 'order.transfer'
  | 'order.close'
  | 'order.cancel_sent'
  | 'order.split'
  | 'order.merge'
  | 'order.merge_approve'
  | 'order.events.read'
  | 'order.void'
  | 'order.void_after_send'
  | 'void.approve'
  | 'order.payment'
  | 'order.payment_void'
  | 'display.view'
  | 'display.bump'
  | 'menu.view'
  | 'menu.write'
  | 'menu.eightysix'
  | 'menu.stock'
  | 'table.view'
  | 'table.status'
  | 'table.write'
  | 'shift.manage'
  | 'reports.view'
  | 'reports.export'
  | 'user.manage'
  | 'settings.write'
  | 'venue.write';

// Static matrix — session 2a-ii, docs/phase2/2a-ii.md section 3, transcribed
// exactly. Permissions marked (S) there hold their MAXIMAL (ceiling) value
// here; resolvePermissions() below narrows/computes the effective set at
// request time from restaurant_settings + venue. One deliberate exception:
// order.void_after_send is NOT given to waiter/bar here even though section
// 4 grants it to them conditionally — see the comment on canVoidAfterSend
// for why, and docs/phase2/SESSION-2a-ii.md for the full rationale.
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  waiter: new Set<Permission>([
    'order.create',
    'order.view_own',
    'order.send',
    'order.fire',
    'order.serve',
    'order.transfer',
    'order.close',
    'order.split',
    'order.merge',
    'order.void',
    'order.payment',
    'menu.view',
    'menu.eightysix',
    'table.view',
    'table.status',
  ]),
  kitchen: new Set<Permission>([
    'display.view',
    'display.bump',
    'menu.view',
    'menu.eightysix',
    'menu.stock',
  ]),
  bar: new Set<Permission>([
    'order.create',
    'order.view_own',
    'order.send',
    'order.serve',
    'order.transfer',
    'order.close',
    'order.split',
    'order.void',
    'order.payment',
    'display.view',
    'display.bump',
    'menu.view',
    'menu.eightysix',
    'menu.stock',
    'table.view',
    'table.status',
  ]),
  manager: new Set<Permission>([
    'order.create',
    'order.view_own',
    'order.view_all',
    'order.send',
    'order.fire',
    'order.serve',
    'order.transfer',
    'order.close',
    'order.cancel_sent',
    'order.split',
    'order.merge',
    'order.merge_approve',
    'order.events.read',
    'order.void',
    'void.approve',
    'order.payment',
    'order.payment_void',
    'display.view',
    'display.bump',
    'menu.view',
    'menu.write',
    'menu.eightysix',
    'menu.stock',
    'table.view',
    'table.status',
    'table.write',
    'shift.manage',
    'reports.view',
    'reports.export',
    'user.manage',
  ]),
  admin: new Set<Permission>([
    'order.create',
    'order.view_own',
    'order.view_all',
    'order.send',
    'order.fire',
    'order.serve',
    'order.transfer',
    'order.close',
    'order.cancel_sent',
    'order.split',
    'order.merge',
    'order.merge_approve',
    'order.events.read',
    'order.void',
    'void.approve',
    'order.payment',
    'order.payment_void',
    'display.view',
    'display.bump',
    'menu.view',
    'menu.write',
    'menu.eightysix',
    'menu.stock',
    'table.view',
    'table.status',
    'table.write',
    'shift.manage',
    'reports.view',
    'reports.export',
    'user.manage',
    'settings.write',
    'venue.write',
  ]),
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

// ── Settings-dependent resolution (2a-ii section 4) ─────────────────────────

export interface DisplayScope {
  kitchen: boolean;
  bar: boolean;
}

export interface ResolvedPermissions {
  permissions: Permission[];
  displayScope: DisplayScope;
}

// "kitchen sees the kitchen display, plus the bar display only when
// venue_type='happy_restaurant'. Bar sees the bar display only." — a scope
// helper rather than a flat boolean because display.view/display.bump are
// not simply on/off: which display(s) an actor may reach depends on both
// role and venue type.
export function resolveDisplayScope(role: UserRole, venueType: VenueType): DisplayScope {
  if (role === 'kitchen') return { kitchen: true, bar: venueType === 'happy_restaurant' };
  if (role === 'bar') return { kitchen: false, bar: true };
  if (role === 'manager' || role === 'admin') return { kitchen: true, bar: true };
  return { kitchen: false, bar: false };
}

// "order.void_after_send — for waiter/bar: only when void_requires_approval
// is false ... otherwise the void goes through the approval flow instead."
//
// This is implemented as a direct per-role/per-setting computation rather
// than a narrowing of the static matrix above, because the static matrix
// (section 3) gives waiter/bar a ceiling of N for this permission while
// section 4's resolution rule describes them conditionally GAINING it — the
// two are inconsistent for this one cell. Treating section 4 as
// authoritative is the only reading under which its rule has any effect;
// treating section 3's N as a hard ceiling would make that rule dead code.
// See docs/phase2/SESSION-2a-ii.md for the full note.
export function canVoidAfterSend(role: UserRole, settings: Pick<RestaurantSettings, 'voidRequiresApproval'>): boolean {
  if (role === 'manager' || role === 'admin') return true;
  if (role === 'waiter' || role === 'bar') return settings.voidRequiresApproval === false;
  return false;
}

export function resolvePermissions(role: UserRole, settings: RestaurantSettings, venue: Venue): ResolvedPermissions {
  const base = ROLE_PERMISSIONS[role];
  const result = new Set<Permission>();
  const displayScope = resolveDisplayScope(role, venue.venueType);

  for (const permission of base) {
    switch (permission) {
      case 'order.split':
        if (settings.splitBillEnabled) result.add(permission);
        break;
      case 'order.merge':
        if (!settings.mergeTablesEnabled) break;
        if (role === 'waiter' && settings.mergeRequiresManager) break;
        result.add(permission);
        break;
      case 'menu.eightysix':
        if (role === 'manager' || role === 'admin' || !settings.eightysixRequiresManager) result.add(permission);
        break;
      case 'reports.view':
      case 'reports.export':
        if (role === 'admin' || (role === 'manager' && settings.reportsVisibleToManager)) result.add(permission);
        break;
      case 'display.view':
      case 'display.bump':
        if (displayScope.kitchen || displayScope.bar) result.add(permission);
        break;
      default:
        result.add(permission);
    }
  }

  if (canVoidAfterSend(role, settings)) result.add('order.void_after_send');

  return { permissions: [...result], displayScope };
}

// Convenience wrapper for call sites that only have a venueId (most route
// handlers and middleware) — fetches venue + settings and resolves in one
// call. Throws if either is missing, matching orders/validation.ts's
// getVenueAndSettings (venue/settings rows are guaranteed to exist for any
// venueId reachable via an authenticated request).
export async function resolvePermissionsForVenue(role: UserRole, venueId: string): Promise<ResolvedPermissions> {
  const [venue, settings] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId } }),
    prisma.restaurantSettings.findUnique({ where: { venueId } }),
  ]);
  if (!venue || !settings) throw new Error(`venue or settings missing for ${venueId}`);
  return resolvePermissions(role, settings, venue);
}
