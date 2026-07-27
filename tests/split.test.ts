import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as splitService from '../src/modules/orders/splitService';

const SLUG = 'test-split-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  itemId: string; // price 1000.00, no modifiers
  areaId: string;
}

let fx: Fixture;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;
  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } });
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantTable.deleteMany({ where: { venueId: venue.id } });
  await prisma.area.deleteMany({ where: { venueId: venue.id } });
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
      name: 'Split Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: true,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          taxRatePercent: 0,
          serviceChargePercent: 0,
          splitBillEnabled: true,
          splitEqualEnabled: true,
          splitMaxWays: 8,
          ticketNumberPrefix: 'S-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });
  const waiter = await prisma.user.create({
    data: { venueId: venue.id, role: 'waiter', fullName: 'Fixture Waiter', pinHash: 'x', pinLookup: `waiter-${venue.id}` },
  });
  const area = await prisma.area.create({ data: { venueId: venue.id, name: 'Main' } });
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const item = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen' },
  });

  return { venueId: venue.id, waiterUserId: waiter.id, itemId: item.id, areaId: area.id };
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

// A counter order with one Burger (price 1000.00) — grand_total lands at
// exactly 1000.00 since tax/service charge are zeroed in the fixture.
async function newCounterOrder(): Promise<string> {
  const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!orderResult.ok) throw new Error('order setup failed');
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderResult.value.id, { menuItemId: fx.itemId, quantity: 1 });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  return orderResult.value.id;
}

async function newTableOrder(): Promise<{ orderId: string; tableId: string }> {
  const table = await prisma.restaurantTable.create({ data: { venueId: fx.venueId, areaId: fx.areaId, tableNumber: Math.floor(Math.random() * 100000) } });
  const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'table', tableId: table.id });
  if (!orderResult.ok) throw new Error('order setup failed');
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderResult.value.id, { menuItemId: fx.itemId, quantity: 1 });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  return { orderId: orderResult.value.id, tableId: table.id };
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Money conservation', () => {
  it('sums exactly to the parent for an evenly divisible total (900.00 / 3)', async () => {
    const orderId = await newCounterOrder();
    // Force a clean 900.00 grand_total for this fixture rather than fiddling
    // with item prices/quantities to land on a round evenly-divisible number.
    await prisma.order.update({ where: { id: orderId }, data: { subtotal: 900, taxTotal: 0, serviceChargeTotal: 0, discountTotal: 0, grandTotal: 900 } });

    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    const sum = result.value.reduce((acc, o) => acc + Number(o.grandTotal), 0);
    expect(sum).toBeCloseTo(900, 2);
    for (const child of result.value) expect(Number(child.grandTotal)).toBeCloseTo(300, 2);
  });

  it('sums exactly to the parent for an unevenly divisible total (1000.00 / 3), remainder to child 1', async () => {
    const orderId = await newCounterOrder(); // grand_total = 1000.00

    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const totals = result.value.map(o => Number(o.grandTotal));
    const sum = totals.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1000, 2);
    expect(totals[0]).toBeCloseTo(333.34, 2);
    expect(totals[1]).toBeCloseTo(333.33, 2);
    expect(totals[2]).toBeCloseTo(333.33, 2);
  });
});

describe('Gates', () => {
  it('rejects with 403 SPLIT_MODE_DISABLED when split_bill_enabled is off', async () => {
    await withSettings({ splitBillEnabled: false }, async () => {
      const orderId = await newCounterOrder();
      const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2);
      expect(result).toEqual({ ok: false, error: { status: 403, code: 'SPLIT_MODE_DISABLED', message: 'Equal split is not enabled for this venue' } });
    });
  });

  it('rejects with 403 SPLIT_MODE_DISABLED when split_equal_enabled is off', async () => {
    await withSettings({ splitEqualEnabled: false }, async () => {
      const orderId = await newCounterOrder();
      const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SPLIT_MODE_DISABLED');
    });
  });

  it('rejects ways below the minimum', async () => {
    const orderId = await newCounterOrder();
    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPLIT_WAYS_INVALID');
  });

  it('rejects ways above split_max_ways', async () => {
    const orderId = await newCounterOrder();
    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SPLIT_WAYS_INVALID');
  });

  it('rejects a split once the order has been paid, at least partially', async () => {
    const orderId = await newCounterOrder();
    await prisma.order.update({ where: { id: orderId }, data: { amountPaid: 100 } });
    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2);
    expect(result).toEqual({ ok: false, error: { status: 409, code: 'ORDER_ALREADY_PAID', message: 'This order has already been paid, at least partially, and cannot be split' } });
  });
});

describe('Order numbers', () => {
  it('each child receives its own distinct order_number', async () => {
    const orderId = await newCounterOrder();
    const parent = await ordersService.getOrder(fx.venueId, orderId);
    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const numbers = result.value.map(o => o.orderNumber);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers).not.toContain(parent!.orderNumber);
  });
});

describe('Relaxed active-table index', () => {
  it('permits the parent plus every child to share one table', async () => {
    const { orderId, tableId } = await newTableOrder();
    const result = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const child of result.value) expect(child.tableId).toBe(tableId);
  });

  it('still rejects two independent (parentless) orders on the same table', async () => {
    const { tableId } = await newTableOrder();
    const second = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'table', tableId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('TABLE_ALREADY_HAS_ACTIVE_ORDER');
  });
});

describe('Merge-back', () => {
  it('restores the parent exactly — child gone, parent totals untouched', async () => {
    const orderId = await newCounterOrder();
    const parentBefore = await ordersService.getOrder(fx.venueId, orderId);

    const split = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const [child1, child2] = split.value;

    const merged = await splitService.mergeBackSplit(fx.venueId, fx.waiterUserId, orderId, child1.id);
    expect(merged.ok).toBe(true);

    const deletedChild = await prisma.order.findUnique({ where: { id: child1.id } });
    expect(deletedChild).toBeNull();

    const remaining = await splitService.listSplits(fx.venueId, orderId);
    expect(remaining.ok).toBe(true);
    if (remaining.ok) expect(remaining.value.map(o => o.id)).toEqual([child2.id]);

    const parentAfter = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(parentAfter!.grandTotal)).toBe(Number(parentBefore!.grandTotal));
    expect(Number(parentAfter!.subtotal)).toBe(Number(parentBefore!.subtotal));
  });

  it('rejects merge-back once the child has been paid', async () => {
    const orderId = await newCounterOrder();
    const split = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const childId = split.value[0].id;
    await prisma.order.update({ where: { id: childId }, data: { amountPaid: 50 } });

    const merged = await splitService.mergeBackSplit(fx.venueId, fx.waiterUserId, orderId, childId);
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error.code).toBe('ORDER_ALREADY_PAID');
  });
});

describe('Rollback leaves no partial state', () => {
  it('a mid-loop failure (forced unique order_number collision) leaves zero orphaned children', async () => {
    const orderId = await newCounterOrder();

    // Read the perpetual counter row to predict exactly which order_number
    // the *second* child would be allocated, then pre-occupy it with an
    // unrelated real order — forcing tx.order.create to fail on i=1 via the
    // genuine (venue_id, order_number) unique constraint, after i=0 already
    // succeeded inside the same transaction. This proves atomicity using a
    // real Postgres constraint rather than a mock.
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
        ticketNumber: 'BLOCK-0001', // orders_service_mode_check requires this for counter mode
        status: 'draft',
        openedByUserId: fx.waiterUserId,
        subtotal: 0,
        taxTotal: 0,
        serviceChargeTotal: 0,
        discountTotal: 0,
        grandTotal: 0,
      },
    });

    await expect(splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2)).rejects.toThrow();

    const orphans = await prisma.order.findMany({ where: { venueId: fx.venueId, parentOrderId: orderId } });
    expect(orphans).toHaveLength(0);
    const events = await prisma.orderEvent.findMany({ where: { venueId: fx.venueId, orderId, eventType: 'order.split' } });
    expect(events).toHaveLength(0);

    await prisma.order.delete({ where: { id: blocker.id } });
  });
});
