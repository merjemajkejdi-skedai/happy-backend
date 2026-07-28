import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as coursesService from '../src/modules/orders/coursesService';
import * as voidService from '../src/modules/orders/voidService';
import * as splitService from '../src/modules/orders/splitService';

const SLUG = 'test-split-by-item-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  itemAId: string; // price 1000.00, course 1
  itemBId: string; // price 2000.00, course 2
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
      name: 'Split By Item Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          taxRatePercent: 10,
          serviceChargePercent: 0,
          coursesEnabled: true,
          sendByCourse: true,
          voidReasonRequired: false,
          voidRequiresApproval: false,
          splitBillEnabled: true,
          splitByItemEnabled: true,
          splitMaxWays: 8,
          ticketNumberPrefix: 'I-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });
  const waiter = await prisma.user.create({
    data: { venueId: venue.id, role: 'waiter', fullName: 'Fixture Waiter', pinHash: 'x', pinLookup: `waiter-${venue.id}` },
  });
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const itemA = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Starter', price: 1000, destination: 'kitchen' },
  });
  const itemB = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Main', price: 2000, destination: 'kitchen' },
  });

  return { venueId: venue.id, waiterUserId: waiter.id, itemAId: itemA.id, itemBId: itemB.id };
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

// Counter order with Starter (course 1, 1000.00) + Main (course 2, 2000.00).
// subtotal 3000.00, tax 10% = 300.00, grand_total 3300.00.
async function newOrderWithBothItems(): Promise<{ orderId: string; itemAOrderItemId: string; itemBOrderItemId: string }> {
  const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!orderResult.ok) throw new Error('order setup failed');
  const orderId = orderResult.value.id;
  const a = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: fx.itemAId, quantity: 1, courseNumber: 1 });
  const b = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: fx.itemBId, quantity: 1, courseNumber: 2 });
  if (!a.ok || !b.ok) throw new Error('addItem failed');
  return { orderId, itemAOrderItemId: a.value.id, itemBOrderItemId: b.value.id };
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Items move with kitchen state intact', () => {
  it('preserves snapshots, status, and timestamps — only order_id/provenance change', async () => {
    const { orderId, itemAOrderItemId } = await newOrderWithBothItems();
    await coursesService.fireCourse(fx.venueId, fx.waiterUserId, orderId, 1); // itemA -> 'sent'

    const before = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemAOrderItemId } });
    expect(before.status).toBe('sent');
    expect(before.sentAt).not.toBeNull();

    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [itemAOrderItemId] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const child = result.value[0];

    const after = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemAOrderItemId } });
    expect(after.orderId).toBe(child.id);
    expect(after.splitFromOrderId).toBe(orderId);
    expect(after.originalOrderItemId).toBe(itemAOrderItemId);
    expect(after.status).toBe(before.status);
    expect(after.sentAt?.getTime()).toBe(before.sentAt?.getTime());
    expect(after.itemNameSnapshot).toBe(before.itemNameSnapshot);
    expect(Number(after.unitPriceSnapshot)).toBe(Number(before.unitPriceSnapshot));
    expect(Number(after.taxRateSnapshot)).toBe(Number(before.taxRateSnapshot));
    expect(after.courseNumber).toBe(before.courseNumber);
  });
});

describe('Validation', () => {
  it('rejects double allocation', async () => {
    const { orderId, itemAOrderItemId } = await newOrderWithBothItems();
    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [
      { orderItemIds: [itemAOrderItemId] },
      { orderItemIds: [itemAOrderItemId] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPLIT_ITEM_DOUBLE_ALLOCATED');
  });

  it('rejects an item that does not belong to this order', async () => {
    const { orderId } = await newOrderWithBothItems();
    const other = await newOrderWithBothItems();
    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [other.itemAOrderItemId] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPLIT_ITEM_NOT_IN_ORDER');
  });

  it('rejects a cancelled item', async () => {
    const { orderId, itemAOrderItemId } = await newOrderWithBothItems();
    const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemAOrderItemId, { reasonText: 'test' });
    expect(voided.ok).toBe(true);

    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [itemAOrderItemId] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPLIT_ITEM_CANCELLED');
  });

  it('rejects with 403 SPLIT_MODE_DISABLED when split_by_item_enabled is off', async () => {
    await withSettings({ splitByItemEnabled: false }, async () => {
      const { orderId, itemAOrderItemId } = await newOrderWithBothItems();
      const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [itemAOrderItemId] }]);
      expect(result).toEqual({ ok: false, error: { status: 403, code: 'SPLIT_MODE_DISABLED', message: 'Item/seat split is not enabled for this venue' } });
    });
  });
});

describe('Unallocated items stay on the parent', () => {
  it('moves only the listed item, leaving the rest', async () => {
    const { orderId, itemAOrderItemId, itemBOrderItemId } = await newOrderWithBothItems();
    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [itemAOrderItemId] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parent = await ordersService.getOrder(fx.venueId, orderId);
    const parentItemIds = parent!.items.map(i => i.id);
    expect(parentItemIds).toContain(itemBOrderItemId);
    expect(parentItemIds).not.toContain(itemAOrderItemId);

    const child = await ordersService.getOrder(fx.venueId, result.value[0].id);
    expect(child!.items.map(i => i.id)).toEqual([itemAOrderItemId]);
  });
});

describe('Totals conservation', () => {
  it('parent plus children grand totals equal the original, including tax', async () => {
    const { orderId, itemAOrderItemId, itemBOrderItemId } = await newOrderWithBothItems();
    const before = await ordersService.getOrder(fx.venueId, orderId);
    const originalGrandTotal = Number(before!.grandTotal);
    expect(originalGrandTotal).toBe(3300); // 3000 subtotal + 10% tax

    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [
      { orderItemIds: [itemAOrderItemId] },
      { orderItemIds: [itemBOrderItemId] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parentAfter = await ordersService.getOrder(fx.venueId, orderId);
    const sum =
      Number(parentAfter!.grandTotal) + result.value.reduce((acc, c) => acc + Number(c.grandTotal), 0);
    expect(sum).toBe(originalGrandTotal);

    // Each child's own total is its item's price plus 10% tax.
    const totals = result.value.map(c => Number(c.grandTotal)).sort((a, b) => a - b);
    expect(totals).toEqual([1100, 2200]); // 1000*1.10, 2000*1.10
    expect(Number(parentAfter!.grandTotal)).toBe(0);
  });
});

describe('Course reconciliation', () => {
  it('creates the course row on the child and drops the empty never-fired row on the parent', async () => {
    const { orderId, itemAOrderItemId } = await newOrderWithBothItems(); // itemA is the only item in course 1

    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [itemAOrderItemId] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const childId = result.value[0].id;

    const parentCourse1 = await prisma.orderCourse.findUnique({ where: { orderId_courseNumber: { orderId, courseNumber: 1 } } });
    expect(parentCourse1).toBeNull(); // empty + never fired -> dropped

    const parentCourse2 = await prisma.orderCourse.findUnique({ where: { orderId_courseNumber: { orderId, courseNumber: 2 } } });
    expect(parentCourse2).not.toBeNull(); // itemB untouched, still has its course row
    expect(parentCourse2!.itemCount).toBe(1);

    const childCourse1 = await prisma.orderCourse.findUnique({ where: { orderId_courseNumber: { orderId: childId, courseNumber: 1 } } });
    expect(childCourse1).not.toBeNull();
    expect(childCourse1!.itemCount).toBe(1);
  });

  it('keeps an empty parent course row if it was already fired', async () => {
    const { orderId, itemAOrderItemId } = await newOrderWithBothItems();
    await coursesService.fireCourse(fx.venueId, fx.waiterUserId, orderId, 1);

    const result = await splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [{ orderItemIds: [itemAOrderItemId] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parentCourse1 = await prisma.orderCourse.findUnique({ where: { orderId_courseNumber: { orderId, courseNumber: 1 } } });
    expect(parentCourse1).not.toBeNull(); // fired -> kept even though now empty
    expect(parentCourse1!.itemCount).toBe(0);
    expect(parentCourse1!.firedAt).not.toBeNull();
  });
});

describe('by_seat', () => {
  it('groups items by seat_number in ascending order and leaves seatless items on the parent', async () => {
    const { orderId, itemAOrderItemId, itemBOrderItemId } = await newOrderWithBothItems();
    // add a third, seatless item to the same order as A and B
    const c = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: fx.itemAId, quantity: 1, courseNumber: 1 });
    if (!c.ok) throw new Error('setup failed');

    await prisma.orderItem.update({ where: { id: itemAOrderItemId }, data: { seatNumber: 2 } });
    await prisma.orderItem.update({ where: { id: itemBOrderItemId }, data: { seatNumber: 1 } });
    // c.value.id stays seatless

    const result = await splitService.splitBySeat(fx.venueId, fx.waiterUserId, orderId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2); // seats 1 and 2
    expect(result.value[0].splitSequence).toBe(1); // seat 1 first (ascending)
    expect(result.value[1].splitSequence).toBe(2); // seat 2 second

    const seat1Child = await ordersService.getOrder(fx.venueId, result.value[0].id);
    expect(seat1Child!.items.map(i => i.id)).toEqual([itemBOrderItemId]);
    const seat2Child = await ordersService.getOrder(fx.venueId, result.value[1].id);
    expect(seat2Child!.items.map(i => i.id)).toEqual([itemAOrderItemId]);

    const parentAfter = await ordersService.getOrder(fx.venueId, orderId);
    expect(parentAfter!.items.map(i => i.id)).toEqual([c.value.id]); // seatless item stays
  });

  it('is a no-op success when no items have a seat assigned', async () => {
    const { orderId } = await newOrderWithBothItems();
    const result = await splitService.splitBySeat(fx.venueId, fx.waiterUserId, orderId);
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe('Rollback leaves no partial state', () => {
  it('a mid-loop failure (forced unique order_number collision) leaves items on the parent', async () => {
    const { orderId, itemAOrderItemId, itemBOrderItemId } = await newOrderWithBothItems();

    const counter = await prisma.ticketCounter.findUnique({
      where: { venueId_businessDate: { venueId: fx.venueId, businessDate: new Date('1970-01-01T00:00:00.000Z') } },
    });
    const nextOrderNumber = (counter?.lastOrderNumber ?? 0) + 1;
    const collidingOrderNumber = nextOrderNumber + 1; // the second child's number

    const blocker = await prisma.order.create({
      data: {
        venueId: fx.venueId,
        orderNumber: collidingOrderNumber,
        serviceMode: 'counter',
        ticketNumber: 'BLOCK-0002',
        status: 'draft',
        openedByUserId: fx.waiterUserId,
        subtotal: 0,
        taxTotal: 0,
        serviceChargeTotal: 0,
        discountTotal: 0,
        grandTotal: 0,
      },
    });

    await expect(
      splitService.splitByItem(fx.venueId, fx.waiterUserId, orderId, [
        { orderItemIds: [itemAOrderItemId] },
        { orderItemIds: [itemBOrderItemId] },
      ]),
    ).rejects.toThrow();

    const orphans = await prisma.order.findMany({ where: { venueId: fx.venueId, parentOrderId: orderId } });
    expect(orphans).toHaveLength(0);

    const itemA = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemAOrderItemId } });
    const itemB = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemBOrderItemId } });
    expect(itemA.orderId).toBe(orderId);
    expect(itemB.orderId).toBe(orderId);

    await prisma.order.delete({ where: { id: blocker.id } });
  });
});
