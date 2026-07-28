import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as shiftsService from '../src/modules/shifts/shiftsService';
import * as paymentsService from '../src/modules/orders/paymentsService';
import { computeBusinessDate } from '../src/modules/shifts/businessDate';

describe('computeBusinessDate — pure function, no DB', () => {
  const TZ = 'Europe/Tirane';

  it('a timestamp before the start hour belongs to the previous calendar date', () => {
    // 2026-07-24 02:00 local (Europe/Tirane is UTC+2 in July, CEST) -> 2026-07-24T00:00:00Z
    const result = computeBusinessDate(new Date('2026-07-24T00:00:00.000Z'), TZ, 5);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-23');
  });

  it('boundary: 04:59 local is still the previous day, 05:00 local is today', () => {
    // 04:59 local = 02:59Z (UTC+2 in July)
    const before = computeBusinessDate(new Date('2026-07-24T02:59:00.000Z'), TZ, 5);
    expect(before.toISOString().slice(0, 10)).toBe('2026-07-23');

    // 05:00 local = 03:00Z
    const at = computeBusinessDate(new Date('2026-07-24T03:00:00.000Z'), TZ, 5);
    expect(at.toISOString().slice(0, 10)).toBe('2026-07-24');
  });

  it('handles a DST spring-forward transition correctly (Europe/Tirane, 2026-03-29)', () => {
    // Before the 01:00Z transition: CET (UTC+1) -> local 01:30, hour 1 < 5 -> previous day.
    const preTransition = computeBusinessDate(new Date('2026-03-29T00:30:00.000Z'), TZ, 5);
    expect(preTransition.toISOString().slice(0, 10)).toBe('2026-03-28');

    // After the transition: CEST (UTC+2) -> local 04:30, hour 4 still < 5 -> previous day.
    const postTransitionStillEarly = computeBusinessDate(new Date('2026-03-29T02:30:00.000Z'), TZ, 5);
    expect(postTransitionStillEarly.toISOString().slice(0, 10)).toBe('2026-03-28');

    // After the transition: CEST -> local 06:30, hour 6 >= 5 -> the transition day itself.
    const postTransitionPastStart = computeBusinessDate(new Date('2026-03-29T04:30:00.000Z'), TZ, 5);
    expect(postTransitionPastStart.toISOString().slice(0, 10)).toBe('2026-03-29');
  });
});

const SLUG = 'test-shifts-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  managerUserId: string;
  itemId: string; // price 1000.00
}

let fx: Fixture;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;
  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.payment.deleteMany({ where: { venueId: venue.id } });
  await prisma.shiftReport.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } });
  await prisma.shift.deleteMany({ where: { venueId: venue.id } });
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
      name: 'Shifts Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          taxRatePercent: 0,
          serviceChargePercent: 0,
          paymentMethodsEnabled: ['cash', 'card'],
          shiftsEnabled: true,
          shiftAutoCloseHours: 24,
          businessDayStartHour: 5,
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
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const item = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen' },
  });

  return { venueId: venue.id, waiterUserId: waiter.id, managerUserId: manager.id, itemId: item.id };
}

async function newCounterOrder(): Promise<string> {
  const result = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!result.ok) throw new Error(`order setup failed: ${JSON.stringify(result.error)}`);
  return result.value.id;
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

// Runs first, deliberately, before any test in this file ever opens a shift —
// proves order creation never blocks on a missing shift.
describe('Order creation with no open shift', () => {
  it('succeeds with shift_id null', async () => {
    const orderId = await newCounterOrder();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.shiftId).toBeNull();
    expect(order.businessDate).not.toBeNull(); // set unconditionally regardless of shift tracking

    // Terminal, so later tests' shift-open sweeps never pick it up.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'cancelled' } });
  });
});

describe('One open shift enforced', () => {
  it('rejects a second open attempt, then allows one after closing', async () => {
    const first = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(first.ok).toBe(true);

    const second = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(second).toEqual({ ok: false, error: { status: 409, code: 'SHIFT_ALREADY_OPEN', message: 'A shift is already open for this venue' } });

    const closed = await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
    expect(closed.ok).toBe(true);
  });
});

describe('Orders attach to the open shift', () => {
  it('sets shift_id to the currently open shift', async () => {
    const opened = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const orderId = await newCounterOrder();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.shiftId).toBe(opened.value.id);

    await prisma.order.update({ where: { id: orderId }, data: { status: 'cancelled' } });
    await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
  });
});

describe('Close with open orders', () => {
  it('is blocked listing the open orders, then succeeds with force=true', async () => {
    const opened = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const orderId = await newCounterOrder();

    const blocked = await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, false);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('SHIFT_HAS_OPEN_ORDERS');
      expect(blocked.openOrders?.map(o => o.id)).toContain(orderId);
    }

    const forced = await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
    expect(forced.ok).toBe(true);

    // The order itself is untouched by the force-close — still open, still
    // pointing at the now-closed shift, until the next shift open sweeps it.
    const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(orderAfter.status).not.toBe('closed');
    expect(orderAfter.shiftId).toBe(opened.value.id);

    // The next open sweeps it in.
    const reopened = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const orderAfterSweep = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(orderAfterSweep.shiftId).toBe(reopened.value.id);

    await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
  });
});

describe('Cash variance', () => {
  it('is zero for an exact count, positive when over, negative when short', async () => {
    async function cycle(closingCashCounted: number, expectedVariance: number) {
      const opened = await shiftsService.openShift(fx.venueId, fx.managerUserId, { openingFloat: 100 });
      if (!opened.ok) throw new Error('setup failed');

      const orderId = await newCounterOrder();
      const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId: fx.itemId, quantity: 1 });
      if (!added.ok) throw new Error('setup failed');

      const paid = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
      if (!paid.ok) throw new Error(`payment setup failed: ${JSON.stringify(paid.error)}`);

      const closed = await shiftsService.closeShift(fx.venueId, fx.managerUserId, { closingCashCounted }, true);
      expect(closed.ok).toBe(true);
      if (closed.ok) expect(Number(closed.value.cashVariance)).toBe(expectedVariance);
    }

    // opening_float 100 + cash payments 1000 = expected 1100.
    await cycle(1100, 0); // exact
    await cycle(1150, 50); // over
    await cycle(1080, -20); // short
  });
});

describe('Long-running shift', () => {
  it('is flagged in GET /shifts/current, never auto-closed', async () => {
    const opened = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // shift_auto_close_hours is 24 — backdate opened_at past that threshold.
    await prisma.shift.update({ where: { id: opened.value.id }, data: { openedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });

    const current = await shiftsService.getCurrentShift(fx.venueId);
    expect(current.flagged).toBe(true);
    expect(current.shift?.status).toBe('open'); // flagged, not auto-closed

    await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
  });
});

describe('Shift reports', () => {
  it('closing writes a shift_reports row', async () => {
    const opened = await shiftsService.openShift(fx.venueId, fx.managerUserId, {});
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const closed = await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    const report = await prisma.shiftReport.findFirst({ where: { shiftId: closed.value.id } });
    expect(report).not.toBeNull();
    expect(report!.isFinal).toBe(true);
    expect(report!.periodStart.getTime()).toBe(opened.value.openedAt.getTime());
  });
});
