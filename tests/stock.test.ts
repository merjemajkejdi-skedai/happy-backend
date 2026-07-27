import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as voidService from '../src/modules/orders/voidService';
import * as stockService from '../src/modules/menu/stockService';
import { requireResolvedPermission } from '../src/middleware/rbac';
import type { Response } from 'express';
import { vi } from 'vitest';

const SLUG = 'test-stock-fixture';
const TIMEZONE = 'Europe/Tirane';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  managerUserId: string;
  adminUserId: string;
  categoryId: string;
}

let fx: Fixture;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;
  await prisma.stockMovement.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuItemStock.deleteMany({ where: { venueId: venue.id } });
  await prisma.approvalRequest.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantVoidLog.deleteMany({ where: { venueId: venue.id } });
  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } });
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuItem.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuCategory.deleteMany({ where: { venueId: venue.id } });
  await prisma.user.deleteMany({ where: { venueId: venue.id } });
  await prisma.venue.delete({ where: { id: venue.id } });
}

async function setupFixture(): Promise<Fixture> {
  await destroyFixture();
  const venue = await prisma.venue.create({
    data: {
      slug: SLUG,
      name: 'Stock Fixture',
      venueType: 'happy_hybrid',
      timezone: TIMEZONE,
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          stockTrackingMode: 'count',
          stockAuto86AtZero: true,
          stockWarnThreshold: 5,
          allowNegativeStock: false,
          eightysixRequiresManager: false,
          eightysixResetsDaily: true,
          voidReasonRequired: false,
          voidRequiresApproval: false,
          voidBeforeSendRequiresApproval: false,
          ticketNumberPrefix: 'S-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });
  const waiter = await prisma.user.create({
    data: { venueId: venue.id, role: 'waiter', fullName: 'Fixture Waiter', pinHash: 'x', pinLookup: `waiter-${venue.id}` },
  });
  const manager = await prisma.user.create({
    data: { venueId: venue.id, role: 'manager', fullName: 'Fixture Manager', pinHash: 'x', pinLookup: `manager-${venue.id}` },
  });
  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Fixture Admin', pinHash: 'x', pinLookup: `admin-${venue.id}` },
  });
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });

  return { venueId: venue.id, waiterUserId: waiter.id, managerUserId: manager.id, adminUserId: admin.id, categoryId: category.id };
}

async function withSettings<T>(data: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const before = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId: fx.venueId } });
  await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data });
  try {
    return await fn();
  } finally {
    const revert: Record<string, unknown> = {};
    for (const key of Object.keys(data)) revert[key] = (before as Record<string, unknown>)[key];
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: revert });
  }
}

async function createItem(name: string, price = 1000) {
  return prisma.menuItem.create({ data: { venueId: fx.venueId, categoryId: fx.categoryId, name, price, destination: 'kitchen' } });
}

async function newOrder(userId = fx.waiterUserId) {
  const result = await ordersService.createOrder(fx.venueId, userId, { serviceMode: 'counter' });
  if (!result.ok) throw new Error('order setup failed');
  return result.value.id;
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Atomic decrement — concurrency', () => {
  it('exactly one of several concurrent adds succeeds for the last unit', async () => {
    const item = await createItem('Last Unit Item');
    const patched = await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 1 });
    expect(patched.ok).toBe(true);

    const N = 6;
    const orderIds = await Promise.all(Array.from({ length: N }, () => newOrder()));
    const results = await Promise.all(
      orderIds.map(orderId => orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: item.id })),
    );

    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(N - 1);
    for (const r of failed) {
      if (!r.ok) expect(r.error.code).toBe('INSUFFICIENT_STOCK');
    }

    const row = await prisma.menuItemStock.findFirst({ where: { venueId: fx.venueId, menuItemId: item.id } });
    expect(row!.currentQuantity).toBe(0);
  });
});

describe('Oversell prevention at exactly zero', () => {
  it('rejects an add when current_quantity is 0', async () => {
    const item = await createItem('Zero Stock Item');
    await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 0 });

    const orderId = await newOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: item.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_STOCK');
  });
});

describe('allow_negative_stock', () => {
  it('permits going below zero when the flag is on', async () => {
    await withSettings({ allowNegativeStock: true }, async () => {
      const item = await createItem('Negative Allowed Item');
      await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 0 });

      const orderId = await newOrder();
      const result = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: item.id });
      expect(result.ok).toBe(true);

      const row = await prisma.menuItemStock.findFirst({ where: { venueId: fx.venueId, menuItemId: item.id } });
      expect(row!.currentQuantity).toBe(-1);
    });
  });
});

describe('Auto-86 at zero', () => {
  it('sets is_86ed when the last unit is decremented', async () => {
    const item = await createItem('Auto 86 Item');
    await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 1 });

    const orderId = await newOrder();
    const result = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: item.id });
    expect(result.ok).toBe(true);

    const row = await prisma.menuItemStock.findFirst({ where: { venueId: fx.venueId, menuItemId: item.id } });
    expect(row!.currentQuantity).toBe(0);
    expect(row!.is86ed).toBe(true);
  });
});

describe('Void restores on approval, not on request', () => {
  it('leaves stock untouched while pending, restores once approved', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const item = await createItem('Void Restore Item');
      await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 5 });

      const orderId = await newOrder();
      const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: item.id });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      let row = await prisma.menuItemStock.findFirst({ where: { venueId: fx.venueId, menuItemId: item.id } });
      expect(row!.currentQuantity).toBe(4);

      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, { itemIds: [added.value.id] });
      const requested = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, added.value.id, { reasonText: 'x' });
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;
      expect(requested.value.pending).toBe(true);

      row = await prisma.menuItemStock.findFirst({ where: { venueId: fx.venueId, menuItemId: item.id } });
      expect(row!.currentQuantity).toBe(4); // still decremented — not restored on request

      const approved = await voidService.approveVoid(fx.venueId, fx.managerUserId, requested.value.voidLog.id);
      expect(approved.ok).toBe(true);

      row = await prisma.menuItemStock.findFirst({ where: { venueId: fx.venueId, menuItemId: item.id } });
      expect(row!.currentQuantity).toBe(5); // restored on approval

      const restoreMovement = await prisma.stockMovement.findFirst({
        where: { venueId: fx.venueId, menuItemId: item.id, reason: 'void' },
      });
      expect(restoreMovement).not.toBeNull();
      expect(restoreMovement!.delta).toBe(1);
      expect(restoreMovement!.balanceAfter).toBe(5);
    });
  });
});

describe('Daily reset', () => {
  it('creates fresh rows for a new business_date, idempotently', async () => {
    const item = await createItem('Daily Reset Item');
    await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 10 });

    const tomorrow = new Date(stockService.businessDateFor(TIMEZONE).getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const opened = await stockService.dayOpen(fx.venueId, TIMEZONE, fx.adminUserId, tomorrowStr);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const tomorrowRow = opened.value.find(r => r.menuItemId === item.id);
    expect(tomorrowRow).toBeTruthy();
    expect(tomorrowRow!.startingQuantity).toBe(10);
    expect(tomorrowRow!.currentQuantity).toBe(10);

    const rowCountBefore = await prisma.menuItemStock.count({ where: { venueId: fx.venueId, menuItemId: item.id } });

    // Idempotent: opening the same business_date again doesn't duplicate.
    const openedAgain = await stockService.dayOpen(fx.venueId, TIMEZONE, fx.adminUserId, tomorrowStr);
    expect(openedAgain.ok).toBe(true);
    const rowCountAfter = await prisma.menuItemStock.count({ where: { venueId: fx.venueId, menuItemId: item.id } });
    expect(rowCountAfter).toBe(rowCountBefore);
  });
});

describe('is_orderable', () => {
  it('is false for inactive, unavailable, 86ed, and zero-stock (with allow_negative_stock off)', () => {
    const activeAvailable = { isActive: true, isAvailable: true };
    const notActive = { isActive: false, isAvailable: true };
    const notAvailable = { isActive: true, isAvailable: false };

    expect(stockService.computeIsOrderable(notActive, null, false)).toBe(false);
    expect(stockService.computeIsOrderable(notAvailable, null, false)).toBe(false);
    expect(stockService.computeIsOrderable(activeAvailable, { mode: 'count', currentQuantity: 5, is86ed: true }, false)).toBe(false);
    expect(stockService.computeIsOrderable(activeAvailable, { mode: 'count', currentQuantity: 0, is86ed: false }, false)).toBe(false);

    // The positive case, for contrast.
    expect(stockService.computeIsOrderable(activeAvailable, { mode: 'count', currentQuantity: 1, is86ed: false }, false)).toBe(true);
    expect(stockService.computeIsOrderable(activeAvailable, null, false)).toBe(true); // never tracked
    expect(stockService.computeIsOrderable(activeAvailable, { mode: 'none', currentQuantity: null, is86ed: false }, false)).toBe(true);
  });
});

describe('eightysix_requires_manager flips the permission dynamically', () => {
  function mockRes() {
    const res = {} as Response;
    res.status = vi.fn().mockReturnValue(res) as unknown as Response['status'];
    res.json = vi.fn().mockReturnValue(res) as unknown as Response['json'];
    return res;
  }

  it('waiter can 86 when the flag is off, cannot when it is on', async () => {
    const reqFor = () => ({ auth: { userId: fx.waiterUserId, venueId: fx.venueId, role: 'waiter' } }) as any;

    const allowedRes = mockRes();
    const allowedNext = vi.fn();
    await requireResolvedPermission('menu.eightysix')(reqFor(), allowedRes, allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();

    await withSettings({ eightysixRequiresManager: true }, async () => {
      const deniedRes = mockRes();
      const deniedNext = vi.fn();
      await requireResolvedPermission('menu.eightysix')(reqFor(), deniedRes, deniedNext);
      expect(deniedNext).not.toHaveBeenCalled();
      expect(deniedRes.status).toHaveBeenCalledWith(403);
    });
  });
});

describe('Every stock change writes a movement with correct balance_after', () => {
  it('order decrement and manual patch both produce accurate movements', async () => {
    const item = await createItem('Movement Item');
    const set = await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { startingQuantity: 10 });
    expect(set.ok).toBe(true);
    if (set.ok) {
      const movement = await prisma.stockMovement.findFirst({
        where: { venueId: fx.venueId, menuItemId: item.id, reason: 'manual_adjust' },
        orderBy: { createdAt: 'desc' },
      });
      expect(movement!.delta).toBe(10);
      expect(movement!.balanceAfter).toBe(10);
    }

    const orderId = await newOrder();
    const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: item.id, quantity: 3 });
    expect(added.ok).toBe(true);
    if (added.ok) {
      const movement = await prisma.stockMovement.findFirst({
        where: { venueId: fx.venueId, menuItemId: item.id, reason: 'order', orderItemId: added.value.id },
      });
      expect(movement!.delta).toBe(-3);
      expect(movement!.balanceAfter).toBe(7);
    }

    const adjusted = await stockService.patchItemStock(fx.venueId, TIMEZONE, item.id, fx.adminUserId, { delta: 5 });
    expect(adjusted.ok).toBe(true);
    if (adjusted.ok) {
      const movement = await prisma.stockMovement.findFirst({
        where: { venueId: fx.venueId, menuItemId: item.id, reason: 'restock' },
      });
      expect(movement!.delta).toBe(5);
      expect(movement!.balanceAfter).toBe(12);
    }
  });
});

describe('Low-stock list at the threshold boundary', () => {
  it('includes items at or below stock_warn_threshold (5), excludes above', async () => {
    const atThreshold = await createItem('At Threshold Item');
    const aboveThreshold = await createItem('Above Threshold Item');
    const belowThreshold = await createItem('Below Threshold Item');

    await stockService.patchItemStock(fx.venueId, TIMEZONE, atThreshold.id, fx.adminUserId, { startingQuantity: 5 });
    await stockService.patchItemStock(fx.venueId, TIMEZONE, aboveThreshold.id, fx.adminUserId, { startingQuantity: 6 });
    await stockService.patchItemStock(fx.venueId, TIMEZONE, belowThreshold.id, fx.adminUserId, { startingQuantity: 4 });

    const low = await stockService.listLowStock(fx.venueId, TIMEZONE);
    const lowIds = low.map(r => r.menuItemId);
    expect(lowIds).toContain(atThreshold.id);
    expect(lowIds).toContain(belowThreshold.id);
    expect(lowIds).not.toContain(aboveThreshold.id);
  });
});
