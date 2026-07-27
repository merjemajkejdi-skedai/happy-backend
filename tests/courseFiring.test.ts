import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as coursesService from '../src/modules/orders/coursesService';
import * as displaysService from '../src/modules/displays/service';

const HYBRID_SLUG = 'test-course-firing-hybrid';
const BAR_SLUG = 'test-course-firing-bar';

interface HybridFixture {
  venueId: string;
  adminUserId: string;
  starterId: string; // destination kitchen, no fixed course (set per-order via add-item)
  mainId: string;
  cocktailId: string; // destination bar
}

let hybrid: HybridFixture;
let barVenueId: string;
let barAdminUserId: string;

async function destroyVenue(slug: string) {
  const venue = await prisma.venue.findUnique({ where: { slug } });
  if (!venue) return;
  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } }); // cascades order_items/order_item_modifiers/order_courses
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantTable.deleteMany({ where: { venueId: venue.id } });
  await prisma.area.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuItem.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuCategory.deleteMany({ where: { venueId: venue.id } });
  await prisma.user.deleteMany({ where: { venueId: venue.id } });
  await prisma.venue.delete({ where: { id: venue.id } }); // cascades restaurant_settings
}

async function setupHybrid(): Promise<HybridFixture> {
  await destroyVenue(HYBRID_SLUG);
  const venue = await prisma.venue.create({
    data: {
      slug: HYBRID_SLUG,
      name: 'Course Firing Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          coursesEnabled: true,
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          allowFreeTextNotes: true,
          autoSendOnAdd: false,
          sendByCourse: true,
          autoFireFirstCourse: false,
          courseFireRequiresPreviousServed: false,
          showFireAlertSeconds: 30,
          ticketNumberPrefix: 'F-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });
  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Fixture Admin', pinHash: 'x', pinLookup: `fixture-${venue.id}` },
  });
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const starter = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Starter Dish', price: 500, destination: 'kitchen' },
  });
  const main = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Main Dish', price: 1200, destination: 'kitchen' },
  });
  const cocktail = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Cocktail', price: 800, destination: 'bar' },
  });
  return { venueId: venue.id, adminUserId: admin.id, starterId: starter.id, mainId: main.id, cocktailId: cocktail.id };
}

async function setupBar(): Promise<{ venueId: string; adminUserId: string }> {
  await destroyVenue(BAR_SLUG);
  const venue = await prisma.venue.create({
    data: {
      slug: BAR_SLUG,
      name: 'Bar Fixture',
      venueType: 'happy_bar',
      timezone: 'Europe/Tirane',
      settings: {
        create: { tablesEnabled: false, counterServiceEnabled: true, requireTableForOrder: false, ticketNumberPrefix: 'B-', ticketNumberReset: 'daily' },
      },
    },
  });
  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Bar Admin', pinHash: 'x', pinLookup: `fixture-${venue.id}` },
  });
  return { venueId: venue.id, adminUserId: admin.id };
}

async function withSetting<T>(venueId: string, data: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const before = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId } });
  await prisma.restaurantSettings.update({ where: { venueId }, data });
  try {
    return await fn();
  } finally {
    const revert: Record<string, unknown> = {};
    for (const key of Object.keys(data)) revert[key] = (before as Record<string, unknown>)[key];
    await prisma.restaurantSettings.update({ where: { venueId }, data: revert });
  }
}

async function newOrder(venueId: string, adminUserId: string) {
  const result = await ordersService.createOrder(venueId, adminUserId, { serviceMode: 'counter' });
  if (!result.ok) throw new Error('order setup failed');
  return result.value.id;
}

async function addItem(orderId: string, menuItemId: string, courseNumber: number) {
  const result = await orderItemsService.addItem(hybrid.venueId, hybrid.adminUserId, orderId, { menuItemId, courseNumber });
  if (!result.ok) throw new Error(`addItem failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeAll(async () => {
  hybrid = await setupHybrid();
  const bar = await setupBar();
  barVenueId = bar.venueId;
  barAdminUserId = bar.adminUserId;
});
afterAll(async () => {
  await destroyVenue(HYBRID_SLUG);
  await destroyVenue(BAR_SLUG);
});

describe('Availability gate', () => {
  it('403 COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE on a happy_bar venue', async () => {
    const orderId = await newOrder(barVenueId, barAdminUserId);
    const result = await coursesService.fireCourse(barVenueId, barAdminUserId, orderId, 1);
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE', message: 'Course firing is not available for a happy_bar venue' },
    });
  });

  it('403 COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE when send_by_course is false', async () => {
    await withSetting(hybrid.venueId, { sendByCourse: false }, async () => {
      const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
      const result = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
      expect(result).toEqual({
        ok: false,
        error: { status: 403, code: 'COURSES_NOT_AVAILABLE_FOR_VENUE_TYPE', message: 'Course firing is not enabled for this venue' },
      });
    });
  });
});

describe('Fire moves only that course items', () => {
  it('fires course 1 items, leaves course 2 items pending', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const s1 = await addItem(orderId, hybrid.starterId, 1);
    const s2 = await addItem(orderId, hybrid.starterId, 1);
    const m1 = await addItem(orderId, hybrid.mainId, 2);

    const result = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('fired');
      expect(result.value.itemCount).toBe(2);
    }

    const order = await ordersService.getOrder(hybrid.venueId, orderId);
    const byId = new Map(order!.items.map(i => [i.id, i]));
    expect(byId.get(s1.id)!.status).toBe('sent');
    expect(byId.get(s2.id)!.status).toBe('sent');
    expect(byId.get(m1.id)!.status).toBe('pending');
    expect(order!.currentCourseFired).toBe(1);
  });
});

describe('destination=none items skip sent', () => {
  it('fires straight to served for a none-destination item', async () => {
    const category = await prisma.menuCategory.create({ data: { venueId: hybrid.venueId, name: 'Skip Probe', defaultDestination: 'none' } });
    const noneItem = await prisma.menuItem.create({
      data: { venueId: hybrid.venueId, categoryId: category.id, name: 'No-Dest Item', price: 100, destination: 'none' },
    });
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const added = await addItem(orderId, noneItem.id, 1);

    const result = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(result.ok).toBe(true);

    const order = await ordersService.getOrder(hybrid.venueId, orderId);
    const item = order!.items.find(i => i.id === added.id)!;
    expect(item.status).toBe('served');
    expect(item.servedAt).not.toBeNull();

    await prisma.menuCategory.update({ where: { id: category.id }, data: { deletedAt: new Date() } });
  });
});

describe('Empty course fires as no-op', () => {
  it('firing course 3 on an order with nothing assigned there succeeds and marks it fired', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const result = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('fired');
      expect(result.value.itemCount).toBe(0);
    }
  });

  it('re-firing an already-fired course is an idempotent no-op success', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const first = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    const second = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.firedAt).toEqual(first.value.firedAt);
  });
});

describe('course_name_snapshot survives a course rename', () => {
  it('keeps the name captured at row creation after settings.course_names changes', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    await addItem(orderId, hybrid.starterId, 1);
    const fired = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    expect(fired.value.courseNameSnapshot).toBe('Starters');

    await prisma.restaurantSettings.update({ where: { venueId: hybrid.venueId }, data: { courseNames: ['Renamed Course'] } });
    const courses = await coursesService.listCourses(hybrid.venueId, orderId);
    expect(courses.ok).toBe(true);
    if (courses.ok) expect(courses.value.find(c => c.courseNumber === 1)!.courseNameSnapshot).toBe('Starters');

    await prisma.restaurantSettings.update({ where: { venueId: hybrid.venueId }, data: { courseNames: ['Starters', 'Mains', 'Desserts'] } });
  });
});

describe('Item moved between courses', () => {
  it('allowed while pending, blocked after firing', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const item = await addItem(orderId, hybrid.starterId, 1);

    const moved = await coursesService.moveItemCourse(hybrid.venueId, hybrid.adminUserId, orderId, item.id, 2);
    expect(moved.ok).toBe(true);
    const afterMove = await ordersService.getOrder(hybrid.venueId, orderId);
    expect(afterMove!.items.find(i => i.id === item.id)!.courseNumber).toBe(2);

    const fired = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 2);
    expect(fired.ok).toBe(true);

    const blocked = await coursesService.moveItemCourse(hybrid.venueId, hybrid.adminUserId, orderId, item.id, 1);
    expect(blocked).toEqual({
      ok: false,
      error: { status: 409, code: 'ITEM_ALREADY_SENT', message: 'This item has already been sent and can no longer be moved between courses' },
    });
  });
});

describe('Previous-served gate', () => {
  it('on: blocks firing course 2 until course 1 is fully served', async () => {
    await withSetting(hybrid.venueId, { courseFireRequiresPreviousServed: true }, async () => {
      const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
      const c1 = await addItem(orderId, hybrid.starterId, 1);
      await addItem(orderId, hybrid.mainId, 2);

      await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
      const blocked = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 2);
      expect(blocked).toEqual({
        ok: false,
        error: { status: 409, code: 'PREVIOUS_COURSE_NOT_SERVED', message: 'Course 1 must be fully served before firing course 2' },
      });

      // Walk c1 through the real kitchen workflow (sent -> preparing ->
      // ready -> served) so all_served_at gets set the same way it would in
      // production, rather than poking status columns directly.
      await displaysService.updateItemStatus(hybrid.venueId, hybrid.adminUserId, c1.id, 'preparing');
      await displaysService.updateItemStatus(hybrid.venueId, hybrid.adminUserId, c1.id, 'ready');
      await lifecycleService.serveItem(hybrid.venueId, hybrid.adminUserId, orderId, c1.id);

      const allowed = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 2);
      expect(allowed.ok).toBe(true);
    });
  });

  it('off: firing course 2 before course 1 is served succeeds', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    await addItem(orderId, hybrid.starterId, 1);
    await addItem(orderId, hybrid.mainId, 2);
    const result = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 2);
    expect(result.ok).toBe(true);
  });
});

describe('Hold', () => {
  it('reverts a fired-but-untouched course back to pending', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const item = await addItem(orderId, hybrid.starterId, 1);
    await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);

    const held = await coursesService.holdCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(held.ok).toBe(true);
    if (held.ok) {
      expect(held.value.status).toBe('pending');
      expect(held.value.firedAt).toBeNull();
    }

    const order = await ordersService.getOrder(hybrid.venueId, orderId);
    expect(order!.items.find(i => i.id === item.id)!.status).toBe('pending');
  });

  it('blocked once an item has moved past sent (409 COURSE_ALREADY_STARTED)', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const item = await addItem(orderId, hybrid.starterId, 1);
    await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    await prisma.orderItem.update({ where: { id: item.id }, data: { status: 'preparing', preparingAt: new Date() } });

    const result = await coursesService.holdCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(result).toEqual({
      ok: false,
      error: { status: 409, code: 'COURSE_ALREADY_STARTED', message: 'Course 1 has already started and can no longer be held' },
    });
  });
});

describe('auto_fire_first_course', () => {
  it('on: the first plain POST /orders/:id/send fires only course 1', async () => {
    await withSetting(hybrid.venueId, { autoFireFirstCourse: true }, async () => {
      const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
      const s1 = await addItem(orderId, hybrid.starterId, 1);
      const m1 = await addItem(orderId, hybrid.mainId, 2);

      const result = await lifecycleService.sendItems(hybrid.venueId, hybrid.adminUserId, orderId, {});
      expect(result.ok).toBe(true);

      const order = await ordersService.getOrder(hybrid.venueId, orderId);
      const byId = new Map(order!.items.map(i => [i.id, i]));
      expect(byId.get(s1.id)!.status).toBe('sent');
      expect(byId.get(m1.id)!.status).toBe('pending');
      expect(order!.currentCourseFired).toBe(1);

      const courses = await coursesService.listCourses(hybrid.venueId, orderId);
      expect(courses.ok).toBe(true);
      if (courses.ok) expect(courses.value.find(c => c.courseNumber === 1)!.status).toBe('fired');
    });
  });

  it('off: the first plain POST /orders/:id/send sends every pending item regardless of course', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const s1 = await addItem(orderId, hybrid.starterId, 1);
    const m1 = await addItem(orderId, hybrid.mainId, 2);

    const result = await lifecycleService.sendItems(hybrid.venueId, hybrid.adminUserId, orderId, {});
    expect(result.ok).toBe(true);

    const order = await ordersService.getOrder(hybrid.venueId, orderId);
    const byId = new Map(order!.items.map(i => [i.id, i]));
    expect(byId.get(s1.id)!.status).toBe('sent');
    expect(byId.get(m1.id)!.status).toBe('sent');
  });
});

describe('Fire alerts', () => {
  it('headline correct for a table order and a counter order', async () => {
    // Table order.
    const area = await prisma.area.create({ data: { venueId: hybrid.venueId, name: 'Main' } });
    const table = await prisma.restaurantTable.create({ data: { venueId: hybrid.venueId, areaId: area.id, tableNumber: 9 } });
    const tableOrderResult = await ordersService.createOrder(hybrid.venueId, hybrid.adminUserId, { serviceMode: 'table', tableId: table.id });
    if (!tableOrderResult.ok) throw new Error('setup failed');
    const tableOrderId = tableOrderResult.value.id;
    await addItem(tableOrderId, hybrid.starterId, 1);
    await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, tableOrderId, 1);

    const alertsAfterTable = await displaysService.getFireAlerts(hybrid.venueId);
    expect(alertsAfterTable.ok).toBe(true);
    if (alertsAfterTable.ok) {
      const alert = alertsAfterTable.value.find(a => a.order_number === tableOrderResult.value.orderNumber)!;
      expect(alert.headline).toBe('FIRE STARTERS — TABLE 9');
      expect(alert.table_label).toBe('Table 9');
      expect(alert.course_name).toBe('Starters');
      expect(alert.type).toBe('fire');
      expect(alert.acknowledged).toBe(false);
    }

    // Counter order — course 2 ("Mains" per settings.course_names[1]).
    const counterOrderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    const counterOrder = await ordersService.getOrder(hybrid.venueId, counterOrderId);
    await addItem(counterOrderId, hybrid.mainId, 2);
    await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, counterOrderId, 2);

    const alertsAfterCounter = await displaysService.getFireAlerts(hybrid.venueId);
    expect(alertsAfterCounter.ok).toBe(true);
    if (alertsAfterCounter.ok) {
      const alert = alertsAfterCounter.value.find(a => a.order_number === counterOrder!.orderNumber)!;
      expect(alert.headline).toBe(`FIRE MAINS — TICKET ${counterOrder!.ticketNumber}`);
      expect(alert.table_label).toBeNull();
    }
  });

  it('expires after the configured seconds', async () => {
    await withSetting(hybrid.venueId, { showFireAlertSeconds: 5 }, async () => {
      const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
      await addItem(orderId, hybrid.starterId, 1);
      const fired = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
      expect(fired.ok).toBe(true);
      if (!fired.ok) return;

      const fresh = await displaysService.getFireAlerts(hybrid.venueId);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(fresh.value.some(a => a.id === fired.value.id)).toBe(true);

      // Simulate the alert having fired 10s ago (> the 5s window) instead of
      // sleeping in the test.
      await prisma.orderCourse.update({ where: { id: fired.value.id }, data: { firedAt: new Date(Date.now() - 10_000) } });

      const expired = await displaysService.getFireAlerts(hybrid.venueId);
      expect(expired.ok).toBe(true);
      if (expired.ok) expect(expired.value.some(a => a.id === fired.value.id)).toBe(false);
    });
  });

  it('ack removes it from the feed', async () => {
    const orderId = await newOrder(hybrid.venueId, hybrid.adminUserId);
    await addItem(orderId, hybrid.starterId, 1);
    const fired = await coursesService.fireCourse(hybrid.venueId, hybrid.adminUserId, orderId, 1);
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;

    const before = await displaysService.getFireAlerts(hybrid.venueId);
    expect(before.ok && before.value.some(a => a.id === fired.value.id)).toBe(true);

    const ack = await displaysService.ackFireAlert(hybrid.venueId, fired.value.id);
    expect(ack.ok).toBe(true);

    const after = await displaysService.getFireAlerts(hybrid.venueId);
    expect(after.ok && after.value.some(a => a.id === fired.value.id)).toBe(false);
  });

  it('embedded fire_alerts on GET /displays/kitchen is empty for a happy_bar venue', async () => {
    const alerts = await displaysService.getEmbeddedFireAlerts(barVenueId);
    expect(alerts).toEqual([]);
  });
});
