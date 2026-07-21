import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import { deriveOrderStatus } from '../src/modules/orders/statusMachine';

const SLUG = 'test-lifecycle-fixture';

interface Fixture {
  venueId: string;
  adminUserId: string;
  tableIds: string[];
  burgerId: string; // destination 'kitchen'
  napkinsId: string; // destination 'none'
}

let fx: Fixture;

async function destroyLifecycleFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;

  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } });
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuItem.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuCategory.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantTable.deleteMany({ where: { venueId: venue.id } });
  await prisma.area.deleteMany({ where: { venueId: venue.id } });
  await prisma.user.deleteMany({ where: { venueId: venue.id } });
  await prisma.venue.delete({ where: { id: venue.id } });
}

async function setupLifecycleFixture(): Promise<Fixture> {
  await destroyLifecycleFixture();

  const venue = await prisma.venue.create({
    data: {
      slug: SLUG,
      name: 'Lifecycle Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          coursesEnabled: true,
          tablesEnabled: true,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          allowTableTransfer: true,
          requireReasonOnVoid: false,
          taxRatePercent: 10,
          serviceChargePercent: 0,
        },
      },
    },
  });

  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Fixture Admin', pinHash: 'x', pinLookup: `lifecycle-${venue.id}` },
  });

  const area = await prisma.area.create({ data: { venueId: venue.id, name: 'Main' } });
  const tableIds: string[] = [];
  for (let n = 1; n <= 5; n++) {
    const table = await prisma.restaurantTable.create({ data: { venueId: venue.id, areaId: area.id, tableNumber: n } });
    tableIds.push(table.id);
  }

  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const burger = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen' },
  });
  const napkins = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Extra Napkins', price: 0, destination: 'none' },
  });

  return { venueId: venue.id, adminUserId: admin.id, tableIds, burgerId: burger.id, napkinsId: napkins.id };
}

beforeAll(async () => {
  fx = await setupLifecycleFixture();
});
afterAll(async () => {
  await destroyLifecycleFixture();
});

describe('Derived status correctness for every item-state combination', () => {
  const s = (status: string) => ({ status: status as never });

  it('no items, or all-cancelled items -> draft', () => {
    expect(deriveOrderStatus([])).toBe('draft');
    expect(deriveOrderStatus([s('cancelled')])).toBe('draft');
  });

  it('at least one active item, all pending -> open', () => {
    expect(deriveOrderStatus([s('pending')])).toBe('open');
    expect(deriveOrderStatus([s('pending'), s('pending')])).toBe('open');
    expect(deriveOrderStatus([s('pending'), s('cancelled')])).toBe('open');
  });

  it('some sent/preparing/ready, nothing served -> sent', () => {
    expect(deriveOrderStatus([s('sent')])).toBe('sent');
    expect(deriveOrderStatus([s('preparing')])).toBe('sent');
    expect(deriveOrderStatus([s('ready')])).toBe('sent');
    expect(deriveOrderStatus([s('pending'), s('sent')])).toBe('sent');
  });

  it('some served, not all active items -> partially_served', () => {
    expect(deriveOrderStatus([s('served'), s('pending')])).toBe('partially_served');
    expect(deriveOrderStatus([s('served'), s('sent')])).toBe('partially_served');
    expect(deriveOrderStatus([s('served'), s('ready')])).toBe('partially_served');
  });

  it('all active (non-cancelled) items served -> served', () => {
    expect(deriveOrderStatus([s('served')])).toBe('served');
    expect(deriveOrderStatus([s('served'), s('served')])).toBe('served');
    expect(deriveOrderStatus([s('served'), s('cancelled')])).toBe('served');
  });

  it('explicit flags override item-derived status entirely', () => {
    expect(deriveOrderStatus([s('pending')], 'closed')).toBe('closed');
    expect(deriveOrderStatus([s('served')], 'cancelled')).toBe('cancelled');
    expect(deriveOrderStatus([], 'closed')).toBe('closed');
  });
});

describe('Full happy path: create -> add -> send -> preparing -> ready -> serve -> close', () => {
  it('walks the whole lifecycle with status derived correctly at each step', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[0] });
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    const orderId = orderResult.value.id;
    expect(orderResult.value.status).toBe('draft');

    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId: fx.burgerId, quantity: 1 });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;
    const itemId = addResult.value.id;

    let order = await ordersService.getOrder(fx.venueId, orderId);
    expect(order!.status).toBe('open');

    const sendResult = await lifecycleService.sendItems(fx.venueId, fx.adminUserId, orderId, {});
    expect(sendResult.ok).toBe(true);
    if (sendResult.ok) expect(sendResult.value.kitchen.count).toBe(1);

    order = await ordersService.getOrder(fx.venueId, orderId);
    expect(order!.status).toBe('sent');
    expect(order!.items[0].status).toBe('sent');
    expect(order!.firstSentAt).not.toBeNull();

    // Kitchen display / recall (preparing <-> ready) is the next prompt —
    // advance directly here to exercise the rest of this lifecycle.
    await prisma.orderItem.update({ where: { id: itemId }, data: { status: 'preparing' } });
    await prisma.orderItem.update({ where: { id: itemId }, data: { status: 'ready' } });

    const serveResult = await lifecycleService.serveItem(fx.venueId, fx.adminUserId, orderId, itemId);
    expect(serveResult.ok).toBe(true);

    order = await ordersService.getOrder(fx.venueId, orderId);
    expect(order!.status).toBe('served');
    expect(order!.items[0].status).toBe('served');

    const closeResult = await lifecycleService.closeOrder(fx.venueId, fx.adminUserId, orderId);
    expect(closeResult.ok).toBe(true);
    if (closeResult.ok) {
      expect(closeResult.value.status).toBe('closed');
      expect(closeResult.value.closedAt).not.toBeNull();
      expect(Number(closeResult.value.grandTotal)).toBe(1100); // 1000 + 10% tax
    }

    const table = await prisma.restaurantTable.findUnique({ where: { id: fx.tableIds[0] } });
    expect(table!.status).toBe('dirty');
  });
});

describe('Send-by-course on happy-restaurant', () => {
  it('sends only the requested course, leaving other courses pending', async () => {
    const venue = await prisma.venue.findUnique({ where: { slug: 'happy-resto' } });
    if (!venue) throw new Error('seed venue happy-resto missing');
    const admin = await prisma.user.findFirst({ where: { venueId: venue.id, role: 'admin' } });
    const table = await prisma.restaurantTable.findFirst({ where: { venueId: venue.id, deletedAt: null } });
    const starter = await prisma.menuItem.findFirst({ where: { venueId: venue.id, name: 'Bruschetta' } });
    const main = await prisma.menuItem.findFirst({ where: { venueId: venue.id, name: 'Pasta Carbonara' } });
    if (!admin || !table || !starter || !main) throw new Error('seed data missing for happy-resto');

    const orderResult = await ordersService.createOrder(venue.id, admin.id, { serviceMode: 'table', tableId: table.id });
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    const orderId = orderResult.value.id;

    const starterAdd = await orderItemsService.addItem(venue.id, admin.id, orderId, { menuItemId: starter.id, quantity: 1 });
    const mainAdd = await orderItemsService.addItem(venue.id, admin.id, orderId, { menuItemId: main.id, quantity: 1 });
    expect(starterAdd.ok && mainAdd.ok).toBe(true);

    const sendResult = await lifecycleService.sendItems(venue.id, admin.id, orderId, { courseNumber: 1 });
    expect(sendResult.ok).toBe(true);
    if (sendResult.ok) {
      expect(sendResult.value.kitchen.count).toBe(1);
      expect(sendResult.value.kitchen.items[0].name).toBe('Bruschetta');
    }

    const order = await ordersService.getOrder(venue.id, orderId);
    const starterItem = order!.items.find(i => i.itemNameSnapshot === 'Bruschetta')!;
    const mainItem = order!.items.find(i => i.itemNameSnapshot === 'Pasta Carbonara')!;
    expect(starterItem.status).toBe('sent');
    expect(mainItem.status).toBe('pending');

    // Cleanup — cancel (something was sent, so this needs the admin actor's
    // implicit order.cancel_sent). Cancelling frees the table to 'dirty' by
    // design (a real table needs bussing before reuse), so explicitly reset
    // it to 'free' too — this test borrows a shared seed venue and shouldn't
    // leave it in a different state than it found it.
    const cancelResult = await lifecycleService.cancelOrder(venue.id, admin.id, 'admin', orderId, 'test cleanup');
    expect(cancelResult.ok).toBe(true);
    await prisma.restaurantTable.update({ where: { id: table.id }, data: { status: 'free' } });
  });
});

describe("Send with destination 'none'", () => {
  it('skips the sent state and goes straight to served, and is excluded from the kitchen/bar summary', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[1] });
    if (!orderResult.ok) throw new Error('setup failed');
    const orderId = orderResult.value.id;

    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId: fx.napkinsId, quantity: 1 });
    if (!addResult.ok) throw new Error('setup failed');

    const sendResult = await lifecycleService.sendItems(fx.venueId, fx.adminUserId, orderId, {});
    expect(sendResult.ok).toBe(true);
    if (sendResult.ok) {
      expect(sendResult.value.kitchen.count).toBe(0);
      expect(sendResult.value.bar.count).toBe(0);
    }

    const order = await ordersService.getOrder(fx.venueId, orderId);
    expect(order!.items[0].status).toBe('served');
    expect(order!.status).toBe('served'); // the only item skipped straight to served
  });
});

describe('Transfer with the flag on and off', () => {
  it('rejects transfer with 403 TRANSFER_DISABLED when allow_table_transfer is false', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { allowTableTransfer: false } });

    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[2] });
    if (!orderResult.ok) throw new Error('setup failed');

    const result = await lifecycleService.transferOrder(fx.venueId, fx.adminUserId, orderResult.value.id, fx.tableIds[3]);
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'TRANSFER_DISABLED', message: 'Table transfer is not allowed for this venue' },
    });

    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { allowTableTransfer: true } });
    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderResult.value.id, 'cleanup');
  });

  it('moves the order to the new table, freeing the old one, when the flag is true', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[2] });
    if (!orderResult.ok) throw new Error('setup failed');
    const orderId = orderResult.value.id;

    const result = await lifecycleService.transferOrder(fx.venueId, fx.adminUserId, orderId, fx.tableIds[3]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.tableId).toBe(fx.tableIds[3]);

    const oldTable = await prisma.restaurantTable.findUnique({ where: { id: fx.tableIds[2] } });
    const newTable = await prisma.restaurantTable.findUnique({ where: { id: fx.tableIds[3] } });
    expect(oldTable!.status).toBe('dirty');
    expect(newTable!.status).toBe('occupied');

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });

  it('rejects transferring to a table that already has an active order', async () => {
    const orderA = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[2] });
    const orderB = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[3] });
    if (!orderA.ok || !orderB.ok) throw new Error('setup failed');

    const result = await lifecycleService.transferOrder(fx.venueId, fx.adminUserId, orderA.value.id, fx.tableIds[3]);
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'TABLE_ALREADY_HAS_ACTIVE_ORDER', message: 'This table already has an active order' },
    });

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderA.value.id, 'cleanup');
    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderB.value.id, 'cleanup');
  });
});

describe('Close blocked by unserved items', () => {
  it('rejects closing with 409 ORDER_HAS_UNSERVED_ITEMS while a pending item remains', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[4] });
    if (!orderResult.ok) throw new Error('setup failed');
    const orderId = orderResult.value.id;

    await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId: fx.burgerId, quantity: 1 });

    const result = await lifecycleService.closeOrder(fx.venueId, fx.adminUserId, orderId);
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'ORDER_HAS_UNSERVED_ITEMS', message: 'All non-cancelled items must be served before closing this order' },
    });

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});

describe('Waiter cancel allowed before send and denied after', () => {
  it('allows a waiter to cancel an order with no items ever sent', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');

    const result = await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'waiter', orderResult.value.id, 'guest left');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('cancelled');
  });

  it('denies a waiter cancelling an order once anything has been sent, but allows admin', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const orderId = orderResult.value.id;

    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId: fx.burgerId, quantity: 1 });
    if (!addResult.ok) throw new Error('setup failed');
    await lifecycleService.sendItems(fx.venueId, fx.adminUserId, orderId, {});

    const waiterAttempt = await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'waiter', orderId, 'guest left');
    expect(waiterAttempt).toEqual({
      ok: false,
      error: { status: 403, code: 'CANCEL_AFTER_SEND_NOT_ALLOWED', message: 'Cancelling an order after anything has been sent is not allowed' },
    });

    const adminAttempt = await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'kitchen error');
    expect(adminAttempt.ok).toBe(true);
    if (adminAttempt.ok) expect(adminAttempt.value.status).toBe('cancelled');
  });

  it('requires a reason to cancel', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');

    const result = await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'waiter', orderResult.value.id, undefined);
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'CANCEL_REASON_REQUIRED', message: 'A reason is required to cancel this order' },
    });

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'waiter', orderResult.value.id, 'cleanup');
  });
});

describe('Send idempotency', () => {
  it('the same key returns the original summary instead of re-sending', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const orderId = orderResult.value.id;
    await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId: fx.burgerId, quantity: 1 });

    const key = `send-key-${Date.now()}`;
    const first = await lifecycleService.sendItems(fx.venueId, fx.adminUserId, orderId, {}, key);
    const second = await lifecycleService.sendItems(fx.venueId, fx.adminUserId, orderId, {}, key);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value).toEqual(second.value);

    const eventCount = await prisma.orderEvent.count({ where: { orderId, eventType: 'order.sent' } });
    expect(eventCount).toBe(1);

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});
