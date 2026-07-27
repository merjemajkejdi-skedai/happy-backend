import { describe, it, expect, vi } from 'vitest';
import { roleHasPermission } from '../src/shared/permissions';
import { requirePermission } from '../src/middleware/rbac';
import type { Response } from 'express';

// Exhaustive coverage of every permission x role cell (including the
// session 2a-ii additions for manager/bar and the settings-dependent ones)
// lives in tests/permissionMatrix.test.ts — this file keeps only the
// original spot-checks plus the requirePermission middleware behavior
// tests below.
describe('permission registry', () => {
  it('waiter can create/send orders and change table status', () => {
    expect(roleHasPermission('waiter', 'order.create')).toBe(true);
    expect(roleHasPermission('waiter', 'order.send')).toBe(true);
    expect(roleHasPermission('waiter', 'table.status')).toBe(true);
  });

  it('waiter cannot write settings or manage users', () => {
    expect(roleHasPermission('waiter', 'settings.write')).toBe(false);
    expect(roleHasPermission('waiter', 'user.manage')).toBe(false);
  });

  it('kitchen can bump the display but cannot create orders or write settings', () => {
    expect(roleHasPermission('kitchen', 'display.bump')).toBe(true);
    expect(roleHasPermission('kitchen', 'order.create')).toBe(false);
    expect(roleHasPermission('kitchen', 'settings.write')).toBe(false);
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
