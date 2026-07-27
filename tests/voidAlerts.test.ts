import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as coursesService from '../src/modules/orders/coursesService';
import * as voidService from '../src/modules/orders/voidService';
import * as displaysService from '../src/modules/displays/service';

const SLUG = 'test-void-alerts-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  managerUserId: string;
  kitchenItemId: string;
  barItemId: string;
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
      name: 'Void Alerts Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          kitchenDisplayEnabled: true,
          barDisplayEnabled: true,
          sendByCourse: true,
          autoFireFirstCourse: false,
          voidAlertsKitchen: true,
          voidReasonRequired: false,
          voidBeforeSendRequiresApproval: false,
          voidRequiresApproval: false,
          voidApprovalRole: 'manager',
          ticketNumberPrefix: 'VA-',
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
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const kitchenItem = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Ribeye 300g', price: 3000, destination: 'kitchen' },
  });
  const barItem = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Mojito', price: 800, destination: 'bar' },
  });

  return { venueId: venue.id, waiterUserId: waiter.id, managerUserId: manager.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id };
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

// Creates an order with one item, optionally sent (after_send) or left
// pending (before_send).
async function newItem(menuItemId: string, courseNumber: number, sent: boolean) {
  const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!orderResult.ok) throw new Error('order setup failed');
  const orderId = orderResult.value.id;
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId, courseNumber });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  if (sent) {
    const sendResult = await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, { itemIds: [added.value.id] });
    if (!sendResult.ok) throw new Error(`send failed: ${JSON.stringify(sendResult.error)}`);
  }
  return { orderId, itemId: added.value.id };
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Alert only after send', () => {
  it('a before-send void produces no alert', async () => {
    const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, false);
    const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;
    expect(voided.value.voidLog.stage).toBe('before_send');

    const alerts = await displaysService.getVoidAlerts(fx.venueId);
    expect(alerts.some(a => a.id === voided.value.voidLog.id)).toBe(false);
  });

  it('an after-send auto-approved void produces an alert', async () => {
    const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, true);
    const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;
    expect(voided.value.voidLog.stage).toBe('after_send');

    const alerts = await displaysService.getVoidAlerts(fx.venueId);
    expect(alerts.some(a => a.id === voided.value.voidLog.id)).toBe(true);
  });
});

describe('void_alerts_kitchen off', () => {
  it('suppresses the alert entirely', async () => {
    await withSettings({ voidAlertsKitchen: false }, async () => {
      const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, true);
      const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
      expect(voided.ok).toBe(true);
      if (!voided.ok) return;

      const alerts = await displaysService.getVoidAlerts(fx.venueId);
      expect(alerts).toEqual([]);
    });
  });
});

describe('Pending vs approved', () => {
  it('no alert while pending_approval; one appears once approved', async () => {
    await withSettings({ voidRequiresApproval: true }, async () => {
      const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, true);
      const requested = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;
      expect(requested.value.pending).toBe(true);

      const beforeApproval = await displaysService.getVoidAlerts(fx.venueId);
      expect(beforeApproval.some(a => a.id === requested.value.voidLog.id)).toBe(false);

      await voidService.approveVoid(fx.venueId, fx.managerUserId, requested.value.voidLog.id);

      const afterApproval = await displaysService.getVoidAlerts(fx.venueId);
      expect(afterApproval.some(a => a.id === requested.value.voidLog.id)).toBe(true);
    });
  });
});

describe('Routing by destination', () => {
  it('a voided bar item never appears on the kitchen display, and vice versa', async () => {
    const kitchen = await newItem(fx.kitchenItemId, 1, true);
    const bar = await newItem(fx.barItemId, 1, true);
    const voidedKitchen = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', kitchen.orderId, kitchen.itemId, { reasonText: 'x' });
    const voidedBar = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', bar.orderId, bar.itemId, { reasonText: 'x' });
    expect(voidedKitchen.ok && voidedBar.ok).toBe(true);
    if (!voidedKitchen.ok || !voidedBar.ok) return;

    const kitchenAlerts = await displaysService.getEmbeddedVoidAlerts(fx.venueId, 'kitchen');
    expect(kitchenAlerts.some(a => a.id === voidedKitchen.value.voidLog.id)).toBe(true);
    expect(kitchenAlerts.some(a => a.id === voidedBar.value.voidLog.id)).toBe(false);

    const barAlerts = await displaysService.getEmbeddedVoidAlerts(fx.venueId, 'bar');
    expect(barAlerts.some(a => a.id === voidedBar.value.voidLog.id)).toBe(true);
    expect(barAlerts.some(a => a.id === voidedKitchen.value.voidLog.id)).toBe(false);
  });
});

describe('Ack', () => {
  it('removes the alert and is idempotent', async () => {
    const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, true);
    const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;

    const before = await displaysService.getVoidAlerts(fx.venueId);
    expect(before.some(a => a.id === voided.value.voidLog.id)).toBe(true);

    const ack1 = await displaysService.ackVoidAlert(fx.venueId, voided.value.voidLog.id);
    expect(ack1.ok).toBe(true);
    const after1 = await displaysService.getVoidAlerts(fx.venueId);
    expect(after1.some(a => a.id === voided.value.voidLog.id)).toBe(false);

    // Idempotent: acking an already-acked alert succeeds, no error.
    const ack2 = await displaysService.ackVoidAlert(fx.venueId, voided.value.voidLog.id);
    expect(ack2.ok).toBe(true);
  });
});

describe('kitchen_notified_at', () => {
  it('is set once on first surfacing and never overwritten', async () => {
    const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, true);
    const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;

    const freshLog = await voidService.getVoid(fx.venueId, voided.value.voidLog.id);
    expect(freshLog!.kitchenNotifiedAt).toBeNull();

    await displaysService.getVoidAlerts(fx.venueId); // first surface
    const afterFirst = await voidService.getVoid(fx.venueId, voided.value.voidLog.id);
    expect(afterFirst!.kitchenNotifiedAt).not.toBeNull();
    const firstStamp = afterFirst!.kitchenNotifiedAt!.getTime();

    await displaysService.getVoidAlerts(fx.venueId); // second surface
    const afterSecond = await voidService.getVoid(fx.venueId, voided.value.voidLog.id);
    expect(afterSecond!.kitchenNotifiedAt!.getTime()).toBe(firstStamp);
  });
});

describe('Fire and void alerts coexist', () => {
  it('one kitchen display response carries both, correctly typed', async () => {
    // Fire alert: fire course 1 on a fresh order.
    const fireOrder = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
    if (!fireOrder.ok) throw new Error('setup failed');
    const fireItem = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, fireOrder.value.id, {
      menuItemId: fx.kitchenItemId,
      courseNumber: 1,
    });
    if (!fireItem.ok) throw new Error('setup failed');
    const fired = await coursesService.fireCourse(fx.venueId, fx.waiterUserId, fireOrder.value.id, 1);
    expect(fired.ok).toBe(true);

    // Void alert: void an after-send item.
    const { orderId, itemId } = await newItem(fx.kitchenItemId, 1, true);
    const voided = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemId, { reasonText: 'x' });
    expect(voided.ok).toBe(true);
    if (!voided.ok || !fired.ok) return;

    const display = await displaysService.getDisplay(fx.venueId, 'kitchen', {});
    expect(display.ok).toBe(true);
    if (!display.ok) return;

    const fireAlert = display.value.fireAlerts.find(a => a.id === fired.value.id);
    expect(fireAlert).toBeTruthy();
    expect(fireAlert!.type).toBe('fire');

    const voidAlert = display.value.voidAlerts.find(a => a.id === voided.value.voidLog.id);
    expect(voidAlert).toBeTruthy();
    expect(voidAlert!.type).toBe('void');
    expect(voidAlert!.headline).toBe('VOID — Ribeye 300g — Ticket ' + (await ordersService.getOrder(fx.venueId, orderId))!.ticketNumber);
  });
});
