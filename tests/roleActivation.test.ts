// Session 2a-ii: role activation, the manager authority restriction (section
// 5), and cross-checks proving GET /permissions' resolution matches the real
// enforcement points that exist in this repo today. This codebase has no
// HTTP/supertest layer anywhere (confirmed by reading every existing test
// file before writing this one) — every other test calls services or
// middleware directly, so that's the convention followed here too.
//
// Several permissions in the full matrix (order.fire, order.split,
// order.merge, order.merge_approve, void.approve, order.payment,
// order.payment_void, menu.stock, shift.manage, reports.view/export) have NO
// route yet — those features belong to later Phase 2 sessions (this one is
// permissions-only, no feature logic). GET /permissions still resolves them
// correctly (exhaustively covered in tests/permissionMatrix.test.ts); there
// is simply nothing to cross-check them against here, and that's expected,
// not a gap — see docs/phase2/SESSION-2a-ii.md.
import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { prisma } from '../src/db/prisma';
import {
  checkManagerAuthority,
  createUser,
  updateUser,
  assignableRoles,
  softDeleteUser,
} from '../src/modules/users/service';
import {
  resolvePermissions,
  resolvePermissionsForVenue,
  canVoidAfterSend,
  resolveDisplayScope,
} from '../src/shared/permissions';
import { requireResolvedPermission, requireDisplayScope } from '../src/middleware/rbac';
import type { UserRole } from '../src/generated/prisma/client';

async function venueByslug(slug: string) {
  const venue = await prisma.venue.findUnique({ where: { slug } });
  if (!venue) throw new Error(`seed venue missing: ${slug}`);
  return venue;
}

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = vi.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

describe('checkManagerAuthority (section 5)', () => {
  it('manager cannot target manager or admin', () => {
    expect(checkManagerAuthority('manager', 'manager')).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE_AUTHORITY',
      message: 'Managers may only manage waiter, kitchen, or bar accounts',
    });
    expect(checkManagerAuthority('manager', 'admin')).toEqual({
      status: 403,
      code: 'INSUFFICIENT_ROLE_AUTHORITY',
      message: 'Managers may only manage waiter, kitchen, or bar accounts',
    });
  });

  it('manager can target waiter, kitchen, or bar', () => {
    expect(checkManagerAuthority('manager', 'waiter')).toBeNull();
    expect(checkManagerAuthority('manager', 'kitchen')).toBeNull();
    expect(checkManagerAuthority('manager', 'bar')).toBeNull();
  });

  it('admin is never restricted by this check', () => {
    for (const target of ['waiter', 'kitchen', 'bar', 'manager', 'admin'] as UserRole[]) {
      expect(checkManagerAuthority('admin', target)).toBeNull();
    }
  });
});

describe('assignableRoles (GET /users/roles)', () => {
  it("admin's assignable roles are all five", () => {
    expect(assignableRoles('admin').sort()).toEqual(['admin', 'bar', 'kitchen', 'manager', 'waiter'].sort());
  });
  it("manager's assignable roles are waiter/kitchen/bar only", () => {
    expect(assignableRoles('manager').sort()).toEqual(['bar', 'kitchen', 'waiter'].sort());
  });
});

describe('Manager authority enforced end-to-end through createUser/updateUser (real DB)', () => {
  it('manager cannot create a manager account', async () => {
    const venue = await venueByslug('happy-hybrid');
    const result = await createUser(venue.id, 'manager', { fullName: 'Illicit Manager', role: 'manager', pin: '9001' });
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'INSUFFICIENT_ROLE_AUTHORITY', message: 'Managers may only manage waiter, kitchen, or bar accounts' },
    });
  });

  it('manager cannot create an admin account', async () => {
    const venue = await venueByslug('happy-hybrid');
    const result = await createUser(venue.id, 'manager', { fullName: 'Illicit Admin', role: 'admin', pin: '9002' });
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'INSUFFICIENT_ROLE_AUTHORITY', message: 'Managers may only manage waiter, kitchen, or bar accounts' },
    });
  });

  it('manager CAN create waiter/kitchen/bar accounts', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    for (const role of ['waiter', 'kitchen', 'bar'] as const) {
      const result = await createUser(venue.id, 'manager', { fullName: `Legit ${role}`, role, pin: `91${role.length}${role.length}` });
      expect(result.ok).toBe(true);
      if (result.ok) await softDeleteUser(venue.id, admin.id, result.value.id);
    }
  });

  it('manager cannot edit an EXISTING manager account, even to change an unrelated field', async () => {
    const venue = await venueByslug('happy-hybrid');
    // Distinct actor from the target, so this isolates the rule-5 authority
    // check from the separate CANNOT_MODIFY_SELF check (which only fires for
    // isActive:false on your own account, and is a different code entirely).
    const actingManager = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'manager' } });
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const otherManager = await createUser(venue.id, 'admin', { fullName: 'Other Manager', role: 'manager', pin: '9006' });
    expect(otherManager.ok).toBe(true);
    if (!otherManager.ok) return;

    const result = await updateUser(venue.id, actingManager.id, 'manager', otherManager.value.id, { fullName: 'Renamed' });
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'INSUFFICIENT_ROLE_AUTHORITY', message: 'Managers may only manage waiter, kitchen, or bar accounts' },
    });

    await softDeleteUser(venue.id, admin.id, otherManager.value.id);
  });

  it('manager cannot promote a waiter into manager or admin', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const created = await createUser(venue.id, 'admin', { fullName: 'Promotion Target', role: 'waiter', pin: '9003' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const attempt = await updateUser(venue.id, admin.id, 'manager', created.value.id, { role: 'manager' });
    expect(attempt).toEqual({
      ok: false,
      error: { status: 403, code: 'INSUFFICIENT_ROLE_AUTHORITY', message: 'Managers may only manage waiter, kitchen, or bar accounts' },
    });

    await softDeleteUser(venue.id, admin.id, created.value.id);
  });

  it('manager CAN edit an existing waiter (e.g. deactivate)', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const created = await createUser(venue.id, 'admin', { fullName: 'Editable Waiter', role: 'waiter', pin: '9004' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateUser(venue.id, admin.id, 'manager', created.value.id, { fullName: 'Edited By Manager' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fullName).toBe('Edited By Manager');

    await softDeleteUser(venue.id, admin.id, created.value.id);
  });

  it('admin is unrestricted: can create/edit manager and admin accounts', async () => {
    const venue = await venueByslug('happy-hybrid');
    const admin = await prisma.user.findFirstOrThrow({ where: { venueId: venue.id, role: 'admin' } });
    const created = await createUser(venue.id, 'admin', { fullName: 'Admin-made Manager', role: 'manager', pin: '9005' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = await updateUser(venue.id, admin.id, 'admin', created.value.id, { role: 'admin' });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.value.role).toBe('admin');

    await softDeleteUser(venue.id, admin.id, created.value.id);
  });
});

describe('GET /permissions (resolvePermissionsForVenue) matches the real enforcement points that exist today', () => {
  it('menu.eightysix: requireResolvedPermission agrees with resolvePermissions for every role, flag on and off', async () => {
    const venue = await venueByslug('happy-hybrid');
    for (const eightysixRequiresManager of [false, true]) {
      await prisma.restaurantSettings.update({ where: { venueId: venue.id }, data: { eightysixRequiresManager } });

      for (const role of ['waiter', 'kitchen', 'bar', 'manager', 'admin'] as UserRole[]) {
        const resolved = await resolvePermissionsForVenue(role, venue.id);
        const expectPass = resolved.permissions.includes('menu.eightysix');

        const req = { auth: { userId: 'u1', venueId: venue.id, role } } as any;
        const res = mockRes();
        const next = vi.fn();
        await requireResolvedPermission('menu.eightysix')(req, res, next);

        expect(next.mock.calls.length > 0).toBe(expectPass);
      }
    }
    await prisma.restaurantSettings.update({ where: { venueId: venue.id }, data: { eightysixRequiresManager: false } });
  });

  it('display scope: requireDisplayScope agrees with resolvePermissions.displayScope for every role, both destinations', async () => {
    const venue = await venueByslug('happy-hybrid'); // venue_type happy_hybrid — not happy_restaurant, so kitchen sees kitchen only
    for (const role of ['waiter', 'kitchen', 'bar', 'manager', 'admin'] as UserRole[]) {
      const resolved = await resolvePermissionsForVenue(role, venue.id);

      for (const destination of ['kitchen', 'bar'] as const) {
        const expectPass = resolved.displayScope[destination];
        const req = { auth: { userId: 'u1', venueId: venue.id, role } } as any;
        const res = mockRes();
        const next = vi.fn();
        await requireDisplayScope(destination)(req, res, next);
        expect(next.mock.calls.length > 0).toBe(expectPass);
      }
    }
  });

  it('display scope at a happy_restaurant venue: kitchen gets both destinations', async () => {
    const venue = await venueByslug('happy-resto'); // venue_type happy_restaurant
    const resolved = await resolvePermissionsForVenue('kitchen', venue.id);
    expect(resolved.displayScope).toEqual({ kitchen: true, bar: true });

    for (const destination of ['kitchen', 'bar'] as const) {
      const req = { auth: { userId: 'u1', venueId: venue.id, role: 'kitchen' } } as any;
      const res = mockRes();
      const next = vi.fn();
      await requireDisplayScope(destination)(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('order.void_after_send: canVoidAfterSend agrees with resolvePermissions for waiter/bar under both approval settings', async () => {
    const venue = await venueByslug('happy-hybrid');
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId: venue.id } });

    for (const voidRequiresApproval of [false, true]) {
      const testSettings = { ...settings, voidRequiresApproval };
      for (const role of ['waiter', 'kitchen', 'bar', 'manager', 'admin'] as UserRole[]) {
        const resolved = resolvePermissions(role, testSettings, await prisma.venue.findUniqueOrThrow({ where: { id: venue.id } }));
        expect(canVoidAfterSend(role, testSettings)).toBe(resolved.permissions.includes('order.void_after_send'));
      }
    }
  });
});
