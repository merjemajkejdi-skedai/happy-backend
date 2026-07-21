import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as menuItemsService from '../src/modules/menu/itemsService';
import * as displaysService from '../src/modules/displays/service';

const SLUG = 'test-displays-fixture';

interface Fixture {
  venueId: string;
  adminUserId: string;
  tableId: string;
  categoryId: string;
  kitchenItemId: string; // course 1
  kitchenItem2Id: string; // course 2
  barItemId: string;
}

let fx: Fixture;

async function destroyDisplaysFixture() {
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

async function setupDisplaysFixture(): Promise<Fixture> {
  await destroyDisplaysFixture();

  const venue = await prisma.venue.create({
    data: {
      slug: SLUG,
      name: 'Displays Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          coursesEnabled: true,
          tablesEnabled: true,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          kitchenDisplayEnabled: true,
          barDisplayEnabled: true,
          displayWarnAfterMinutes: 15,
          displayAutoRefreshSeconds: 10,
        },
      },
    },
  });

  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Fixture Admin', pinHash: 'x', pinLookup: `displays-${venue.id}` },
  });

  const area = await prisma.area.create({ data: { venueId: venue.id, name: 'Main' } });
  const table = await prisma.restaurantTable.create({ data: { venueId: venue.id, areaId: area.id, tableNumber: 1 } });

  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const kitchenItem = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen', courseNumber: 1 },
  });
  const kitchenItem2 = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Cake', price: 500, destination: 'kitchen', courseNumber: 2 },
  });
  const barItem = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Mojito', price: 700, destination: 'bar' },
  });

  return {
    venueId: venue.id,
    adminUserId: admin.id,
    tableId: table.id,
    categoryId: category.id,
    kitchenItemId: kitchenItem.id,
    kitchenItem2Id: kitchenItem2.id,
    barItemId: barItem.id,
  };
}

async function createSentOrder(itemIds: string[]) {
  const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
  if (!orderResult.ok) throw new Error('setup failed');
  const orderId = orderResult.value.id;
  for (const menuItemId of itemIds) {
    const added = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId, quantity: 1 });
    if (!added.ok) throw new Error(`setup failed adding ${menuItemId}: ${JSON.stringify(added.error)}`);
  }
  const sendResult = await lifecycleService.sendItems(fx.venueId, fx.adminUserId, orderId, {});
  if (!sendResult.ok) throw new Error('setup failed sending');
  return orderId;
}

beforeAll(async () => {
  fx = await setupDisplaysFixture();
});
afterAll(async () => {
  await destroyDisplaysFixture();
});

describe('Hybrid venue routing items to the correct display by destination_snapshot', () => {
  it('kitchen items appear only on /kitchen, bar items only on /bar', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId, fx.barItemId]);

    const kitchen = await displaysService.getDisplay(fx.venueId, 'kitchen', {});
    expect(kitchen.ok).toBe(true);
    if (kitchen.ok) {
      const ticket = kitchen.value.tickets.find(t => t.order_id === orderId)!;
      const names = ticket.courses.flatMap(c => c.items.map(i => i.item_name));
      expect(names).toEqual(['Burger']);
    }

    const bar = await displaysService.getDisplay(fx.venueId, 'bar', {});
    expect(bar.ok).toBe(true);
    if (bar.ok) {
      const ticket = bar.value.tickets.find(t => t.order_id === orderId)!;
      const names = ticket.courses.flatMap(c => c.items.map(i => i.item_name));
      expect(names).toEqual(['Mojito']);
    }

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});

describe('Bar display 403 on happy-restaurant, kitchen display 403 on happy-bar', () => {
  it('happy-resto (no bar display) rejects GET /displays/bar', async () => {
    const venue = await prisma.venue.findUnique({ where: { slug: 'happy-resto' } });
    const result = await displaysService.getDisplay(venue!.id, 'bar', {});
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'DISPLAY_DISABLED', message: 'The bar display is not enabled for this venue' },
    });
  });

  it('happy-bar (no kitchen display) rejects GET /displays/kitchen', async () => {
    const venue = await prisma.venue.findUnique({ where: { slug: 'happy-bar' } });
    const result = await displaysService.getDisplay(venue!.id, 'kitchen', {});
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'DISPLAY_DISABLED', message: 'The kitchen display is not enabled for this venue' },
    });
  });
});

describe('Course grouping on and off', () => {
  it('groups items into separate course buckets when courses are enabled', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId, fx.kitchenItem2Id]);

    const kitchen = await displaysService.getDisplay(fx.venueId, 'kitchen', {});
    expect(kitchen.ok).toBe(true);
    if (kitchen.ok) {
      const ticket = kitchen.value.tickets.find(t => t.order_id === orderId)!;
      expect(ticket.courses.map(c => c.course_number)).toEqual([1, 2]);
      expect(ticket.courses[0].items[0].item_name).toBe('Burger');
      expect(ticket.courses[1].items[0].item_name).toBe('Cake');
    }

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });

  it('collapses to a single null-numbered course when courses are disabled venue-wide', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { coursesEnabled: false } });

    // Neither menu item has a courseNumber default of null set explicitly,
    // but with courses disabled the venue's own items were seeded with
    // course_number 1/2 above — use a course-less item instead to avoid
    // colliding with COURSES_DISABLED validation on add.
    const orderId = await createSentOrder([fx.barItemId]);

    const bar = await displaysService.getDisplay(fx.venueId, 'bar', {});
    expect(bar.ok).toBe(true);
    if (bar.ok) {
      const ticket = bar.value.tickets.find(t => t.order_id === orderId)!;
      expect(ticket.courses).toHaveLength(1);
      expect(ticket.courses[0].course_number).toBeNull();
    }

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { coursesEnabled: true } });
  });
});

describe('Elapsed/warning computation', () => {
  it('computes elapsed_seconds from first_sent_at/sent_at and flags is_warning past the configured minutes', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId]);

    // Backdate first_sent_at/sent_at 20 minutes into the past — venue's
    // display_warn_after_minutes is 15, so this should trip is_warning.
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
    await prisma.order.update({ where: { id: orderId }, data: { firstSentAt: twentyMinAgo } });
    await prisma.orderItem.updateMany({ where: { orderId }, data: { sentAt: twentyMinAgo } });

    const kitchen = await displaysService.getDisplay(fx.venueId, 'kitchen', {});
    expect(kitchen.ok).toBe(true);
    if (kitchen.ok) {
      const ticket = kitchen.value.tickets.find(t => t.order_id === orderId)!;
      expect(ticket.elapsed_seconds).toBeGreaterThanOrEqual(1195);
      expect(ticket.elapsed_seconds).toBeLessThanOrEqual(1210);
      expect(ticket.is_warning).toBe(true);
      const item = ticket.courses[0].items[0];
      expect(item.elapsed_seconds).toBeGreaterThanOrEqual(1195);
    }

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });

  it('does not flag is_warning for a freshly sent item', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId]);

    const kitchen = await displaysService.getDisplay(fx.venueId, 'kitchen', {});
    expect(kitchen.ok).toBe(true);
    if (kitchen.ok) {
      const ticket = kitchen.value.tickets.find(t => t.order_id === orderId)!;
      expect(ticket.is_warning).toBe(false);
    }

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});

describe('Bulk bump atomicity', () => {
  it('fails the whole batch if any targeted item is not sent/preparing, leaving all items unchanged', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId, fx.kitchenItem2Id]);
    const order = await ordersService.getOrder(fx.venueId, orderId);
    const [item1, item2] = order!.items;

    // Move item2 to 'ready' so it becomes an ineligible target.
    await displaysService.updateItemStatus(fx.venueId, fx.adminUserId, item2.id, 'ready');

    const result = await displaysService.bumpItems(fx.venueId, fx.adminUserId, { orderItemIds: [item1.id, item2.id] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');

    const item1After = await prisma.orderItem.findUnique({ where: { id: item1.id } });
    expect(item1After!.status).toBe('sent'); // untouched — the batch never partially applied

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });

  it('bumps every eligible item in one call when all targets are valid', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId, fx.kitchenItem2Id]);
    const order = await ordersService.getOrder(fx.venueId, orderId);
    const itemIds = order!.items.map(i => i.id);

    const result = await displaysService.bumpItems(fx.venueId, fx.adminUserId, { orderItemIds: itemIds });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bumped).toBe(2);

    const after = await prisma.orderItem.findMany({ where: { orderId } });
    expect(after.every(i => i.status === 'ready')).toBe(true);

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});

describe('Recall window boundary', () => {
  it('includes items readied within 30 minutes and excludes items readied earlier', async () => {
    const insideOrderId = await createSentOrder([fx.kitchenItemId]);
    const outsideOrderId = await createSentOrder([fx.kitchenItemId]);

    const insideOrder = await ordersService.getOrder(fx.venueId, insideOrderId);
    const outsideOrder = await ordersService.getOrder(fx.venueId, outsideOrderId);
    const insideItemId = insideOrder!.items[0].id;
    const outsideItemId = outsideOrder!.items[0].id;

    await prisma.orderItem.update({ where: { id: insideItemId }, data: { status: 'ready', readyAt: new Date(Date.now() - 29 * 60 * 1000) } });
    await prisma.orderItem.update({ where: { id: outsideItemId }, data: { status: 'ready', readyAt: new Date(Date.now() - 31 * 60 * 1000) } });

    const recall = await displaysService.getRecallDisplay(fx.venueId);
    const recalledOrderIds = recall.tickets.map(t => t.order_id);
    expect(recalledOrderIds).toContain(insideOrderId);
    expect(recalledOrderIds).not.toContain(outsideOrderId);

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', insideOrderId, 'cleanup');
    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', outsideOrderId, 'cleanup');
  });
});

describe('Snapshot-only field sourcing', () => {
  it('reflects the item name as it was when sent, not the current menu item name/price', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId]);

    await menuItemsService.updateItem(fx.venueId, fx.kitchenItemId, { name: 'Renamed Burger', price: 9999 });

    const kitchen = await displaysService.getDisplay(fx.venueId, 'kitchen', {});
    expect(kitchen.ok).toBe(true);
    if (kitchen.ok) {
      const ticket = kitchen.value.tickets.find(t => t.order_id === orderId)!;
      expect(ticket.courses[0].items[0].item_name).toBe('Burger'); // not 'Renamed Burger'
    }

    await menuItemsService.updateItem(fx.venueId, fx.kitchenItemId, { name: 'Burger', price: 1000 });
    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});

describe('Single-item status transition and recall', () => {
  it('rejects an invalid transition with 409 INVALID_STATUS_TRANSITION', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId]);
    const order = await ordersService.getOrder(fx.venueId, orderId);
    const itemId = order!.items[0].id;

    await displaysService.updateItemStatus(fx.venueId, fx.adminUserId, itemId, 'ready');

    const result = await displaysService.updateItemStatus(fx.venueId, fx.adminUserId, itemId, 'preparing');
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'INVALID_STATUS_TRANSITION', message: "Cannot move an item from 'ready' to 'preparing'" },
    });

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });

  it('recallItem moves ready back to preparing and clears ready_at', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId]);
    const order = await ordersService.getOrder(fx.venueId, orderId);
    const itemId = order!.items[0].id;
    await displaysService.updateItemStatus(fx.venueId, fx.adminUserId, itemId, 'ready');

    const result = await displaysService.recallItem(fx.venueId, fx.adminUserId, itemId);
    expect(result.ok).toBe(true);

    const after = await prisma.orderItem.findUnique({ where: { id: itemId } });
    expect(after!.status).toBe('preparing');
    expect(after!.readyAt).toBeNull();

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });

  it('rejects recalling an item that is not ready', async () => {
    const orderId = await createSentOrder([fx.kitchenItemId]);
    const order = await ordersService.getOrder(fx.venueId, orderId);
    const itemId = order!.items[0].id;

    const result = await displaysService.recallItem(fx.venueId, fx.adminUserId, itemId);
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'INVALID_STATUS_TRANSITION', message: "Cannot recall an item with status 'sent'" },
    });

    await lifecycleService.cancelOrder(fx.venueId, fx.adminUserId, 'admin', orderId, 'cleanup');
  });
});
