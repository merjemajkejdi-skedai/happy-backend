import { describe, it, expect, vi } from 'vitest';
import { roleHasPermission, ROLE_PERMISSIONS, type Permission } from '../src/shared/permissions';
import { requirePermission } from '../src/middleware/rbac';
import type { Response } from 'express';

const ALL_PERMISSIONS: Permission[] = [
  'order.create', 'order.send', 'order.transfer', 'order.serve', 'order.close',
  'order.void_after_send', 'order.cancel_sent', 'display.bump', 'display.view',
  'settings.write', 'user.manage', 'menu.write', 'table.write',
  'table.status', 'menu.availability', 'order.events.read', 'venue.write',
];

describe('permission registry', () => {
  it('waiter can create/send orders and change table status', () => {
    expect(roleHasPermission('waiter', 'order.create')).toBe(true);
    expect(roleHasPermission('waiter', 'order.send')).toBe(true);
    expect(roleHasPermission('waiter', 'table.status')).toBe(true);
  });

  it('waiter cannot write settings, manage users, or void after send', () => {
    expect(roleHasPermission('waiter', 'settings.write')).toBe(false);
    expect(roleHasPermission('waiter', 'user.manage')).toBe(false);
    expect(roleHasPermission('waiter', 'order.void_after_send')).toBe(false);
  });

  it('kitchen can bump the display but cannot create orders or write settings', () => {
    expect(roleHasPermission('kitchen', 'display.bump')).toBe(true);
    expect(roleHasPermission('kitchen', 'order.create')).toBe(false);
    expect(roleHasPermission('kitchen', 'settings.write')).toBe(false);
  });

  it('admin has every Phase 1 permission', () => {
    for (const p of ALL_PERMISSIONS) expect(roleHasPermission('admin', p)).toBe(true);
  });

  it('manager and bar have no permissions in Phase 1 (defined, no routes yet)', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(roleHasPermission('manager', p)).toBe(false);
      expect(roleHasPermission('bar', p)).toBe(false);
    }
    expect(ROLE_PERMISSIONS.manager.size).toBe(0);
    expect(ROLE_PERMISSIONS.bar.size).toBe(0);
  });
});

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = vi.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

describe('requirePermission middleware', () => {
  it('calls next() when the role has the permission', () => {
    const req = { auth: { userId: 'u1', venueId: 'v1', role: 'admin' as const } } as any;
    const res = mockRes();
    const next = vi.fn();
    requirePermission('settings.write')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when the role lacks the permission', () => {
    const req = { auth: { userId: 'u1', venueId: 'v1', role: 'waiter' as const } } as any;
    const res = mockRes();
    const next = vi.fn();
    requirePermission('settings.write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) }),
    );
  });

  it('returns 401 when unauthenticated (no req.auth)', () => {
    const req = {} as any;
    const res = mockRes();
    const next = vi.fn();
    requirePermission('order.create')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
