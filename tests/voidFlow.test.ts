import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as voidService from '../src/modules/orders/voidService';

const SLUG = 'test-void-flow-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  managerUserId: string;
  adminUserId: string;
  itemId: string; // price 1000
  groupId: string;
  cheeseOptionId: string; // priceDelta 100
}

let fx: Fixture;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;
  await prisma.approvalRequest.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantVoidLog.deleteMany({ where: { venueId: venue.id } });
  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } });
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });
  const groups = await prisma.modifierGroup.findMany({ where: { venueId: venue.id } });
  const items = await prisma.menuItem.findMany({ where: { venueId: venue.id } });
  await prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: items.map(i => i.id) } } });
  await prisma.modifierOption.deleteMany({ where: { groupId: { in: groups.map(g => g.id) } } });
  await prisma.modifierGroup.deleteMany({ where: { venueId: venue.id } });
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
      name: 'Void Flow Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          allowFreeTextNotes: true,
          autoSendOnAdd: false,
          voidReasonRequired: true,
          voidBeforeSendRequiresApproval: false,
          voidRequiresApproval: false,
          voidApprovalRole: 'manager',
          ticketNumberPrefix: 'V-',
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
  const item = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen' },
  });
  const group = await prisma.modifierGroup.create({ data: { venueId: venue.id, name: 'Toppings', type: 'multiple', pricingMode: 'fixed' } });
  const cheese = await prisma.modifierOption.create({ data: { groupId: group.id, name: 'Cheese', priceDelta: 100 } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: item.id, groupId: group.id } });

  return {
    venueId: venue.id,
    waiterUserId: waiter.id,
    managerUserId: manager.id,
    adminUserId: admin.id,
    itemId: item.id,
    groupId: group.id,
    cheeseOptionId: cheese.id,
  };
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

async function newOrderWithItem(quantity = 1) {
  const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!orderResult.ok) throw new Error('order setup failed');
  const orderId = orderResult.value.id;
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, {
    menuItemId: fx.itemId,
    quantity,
    modifierOptionIds: [fx.cheeseOptionId],
  });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  return { orderId, itemId: added.value.id };
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Before-send void with approval off', () => {
  it('cancels the item immediately and writes an auto_approved log', async () => {
    const { orderId, itemId } = await newOrderWithItem();

    const result = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'changed mind' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending).toBe(false);
    expect(result.value.voidLog.status).toBe('auto_approved');
    expect(result.value.voidLog.stage).toBe('before_send');

    const order = await ordersService.getOrder(fx.venueId, orderId);
    expect(order!.items.find(i => i.id === itemId)!.status).toBe('cancelled');
    expect(Number(order!.subtotal)).toBe(0);
  });
});

describe('After-send void with approval on', () => {
  it('creates a pending request and leaves the item live', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});

      const result = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'kitchen error' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pending).toBe(true);
      expect(result.value.voidLog.status).toBe('pending_approval');
      expect(result.value.voidLog.stage).toBe('after_send');

      const order = await ordersService.getOrder(fx.venueId, orderId);
      const item = order!.items.find(i => i.id === itemId)!;
      expect(item.status).toBe('sent'); // untouched — not cancelled yet
      expect(Number(order!.subtotal)).toBeGreaterThan(0);

      const approval = await prisma.approvalRequest.findFirst({ where: { venueId: fx.venueId, subjectId: result.value.voidLog.id } });
      expect(approval).not.toBeNull();
      expect(approval!.requiredRole).toBe('manager');
    });
  });
});

describe('Manager self-void', () => {
  it('auto-approves even when void_requires_approval is on', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});

      const result = await voidService.requestVoid(fx.venueId, fx.managerUserId, 'manager', orderId, itemId, { reasonText: 'manager override' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pending).toBe(false);
      expect(result.value.voidLog.status).toBe('auto_approved');
      expect(result.value.voidLog.approvedByUserId).toBe(fx.managerUserId);

      const order = await ordersService.getOrder(fx.venueId, orderId);
      expect(order!.items.find(i => i.id === itemId)!.status).toBe('cancelled');
    });
  });
});

describe('Reason requirement', () => {
  it('rejects with no reason', async () => {
    const { orderId, itemId } = await newOrderWithItem();
    const result = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, {});
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'VOID_REASON_REQUIRED', message: 'A reason is required to void this item' },
    });
  });

  it('accepts a preset reason_code', async () => {
    const { orderId, itemId } = await newOrderWithItem();
    const result = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonCode: 'Wrong item' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voidLog.reasonCode).toBe('Wrong item');
  });

  it('accepts free-text reason_text', async () => {
    const { orderId, itemId } = await newOrderWithItem();
    const result = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'Guest allergy discovered' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voidLog.reasonText).toBe('Guest allergy discovered');
  });
});

describe('Approve', () => {
  it('cancels the item and recomputes order totals', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});
      const requested = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'kitchen error' });
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;

      const beforeOrder = await ordersService.getOrder(fx.venueId, orderId);
      expect(Number(beforeOrder!.subtotal)).toBeGreaterThan(0);

      const approved = await voidService.approveVoid(fx.venueId, fx.managerUserId, requested.value.voidLog.id);
      expect(approved.ok).toBe(true);
      if (approved.ok) {
        expect(approved.value.status).toBe('approved');
        expect(approved.value.approvedByUserId).toBe(fx.managerUserId);
      }

      const afterOrder = await ordersService.getOrder(fx.venueId, orderId);
      expect(afterOrder!.items.find(i => i.id === itemId)!.status).toBe('cancelled');
      expect(Number(afterOrder!.subtotal)).toBe(0);
    });
  });
});

describe('Reject', () => {
  it('leaves the item live and logs the rejection', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});
      const requested = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'kitchen error' });
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;

      const rejected = await voidService.rejectVoid(fx.venueId, fx.managerUserId, requested.value.voidLog.id, 'Item was correct, guest changed mind');
      expect(rejected.ok).toBe(true);
      if (rejected.ok) {
        expect(rejected.value.status).toBe('rejected');
        expect(rejected.value.rejectionReason).toBe('Item was correct, guest changed mind');
        expect(rejected.value.approvedByUserId).toBe(fx.managerUserId);
      }

      const order = await ordersService.getOrder(fx.venueId, orderId);
      expect(order!.items.find(i => i.id === itemId)!.status).toBe('sent'); // untouched
    });
  });
});

describe('void_value math', () => {
  it('matches quantity * (unit_price_snapshot + modifiers_total)', async () => {
    const { orderId, itemId } = await newOrderWithItem(2); // qty 2, unit 1000, +100 modifier
    const result = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'test' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Number(result.value.voidLog.voidValue)).toBe(2200); // 2 * (1000 + 100)
  });
});

describe('Order close guard', () => {
  it('blocks closing while a void is pending approval', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});
      const requested = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'kitchen error' });
      expect(requested.ok).toBe(true);

      const closeResult = await lifecycleService.closeOrder(fx.venueId, fx.adminUserId, orderId);
      expect(closeResult).toEqual({
        ok: false,
        error: { status: 409, code: 'ORDER_HAS_PENDING_VOID', message: 'This order has a void request awaiting approval and cannot be closed yet' },
      });
    });
  });
});

describe('Duplicate pending request', () => {
  it('rejects a second void request while one is already pending', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});
      const first = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'a' });
      expect(first.ok).toBe(true);

      const second = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'b' });
      expect(second).toEqual({
        ok: false,
        error: { status: 409, code: 'VOID_ALREADY_PENDING', message: 'A void request for this item is already pending approval' },
      });
    });
  });
});

describe('Every path writes the log', () => {
  it('auto_approved, pending_approval, approved, and rejected paths all produce a restaurant_void_log row', async () => {
    // auto_approved
    const autoApproved = await newOrderWithItem();
    const r1 = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', autoApproved.orderId, autoApproved.itemId, { reasonText: 'a' });
    expect(r1.ok && (await voidService.getVoid(fx.venueId, r1.value.voidLog.id))).toBeTruthy();

    await withSettings({ voidRequiresApproval: true }, async () => {
      // pending_approval
      const pending = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, pending.orderId, {});
      const r2 = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', pending.orderId, pending.itemId, { reasonText: 'b' });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect((await voidService.getVoid(fx.venueId, r2.value.voidLog.id))!.status).toBe('pending_approval');

      // approved
      const toApprove = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, toApprove.orderId, {});
      const r3 = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', toApprove.orderId, toApprove.itemId, { reasonText: 'c' });
      if (!r3.ok) return;
      await voidService.approveVoid(fx.venueId, fx.managerUserId, r3.value.voidLog.id);
      expect((await voidService.getVoid(fx.venueId, r3.value.voidLog.id))!.status).toBe('approved');

      // rejected
      const toReject = await newOrderWithItem();
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, toReject.orderId, {});
      const r4 = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', toReject.orderId, toReject.itemId, { reasonText: 'd' });
      if (!r4.ok) return;
      await voidService.rejectVoid(fx.venueId, fx.managerUserId, r4.value.voidLog.id, 'no');
      expect((await voidService.getVoid(fx.venueId, r4.value.voidLog.id))!.status).toBe('rejected');
    });
  });
});

describe('Log survives deletion of the requesting user', () => {
  it('keeps requested_by_name/approved_by_name after the user is soft-deleted', async () => {
    const throwaway = await prisma.user.create({
      data: { venueId: fx.venueId, role: 'waiter', fullName: 'Throwaway Waiter', pinHash: 'x', pinLookup: `throwaway-${fx.venueId}` },
    });
    const orderResult = await ordersService.createOrder(fx.venueId, throwaway.id, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const added = await orderItemsService.addItem(fx.venueId, throwaway.id, orderResult.value.id, { menuItemId: fx.itemId });
    if (!added.ok) throw new Error('setup failed');

    const requested = await voidService.requestVoid(fx.venueId, throwaway.id, 'waiter', orderResult.value.id, added.value.id, { reasonText: 'test' });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    await prisma.user.update({ where: { id: throwaway.id }, data: { deletedAt: new Date() } });

    const log = await voidService.getVoid(fx.venueId, requested.value.voidLog.id);
    expect(log!.requestedByName).toBe('Throwaway Waiter');
    expect(log!.requestedByUserId).toBe(throwaway.id);
  });
});
