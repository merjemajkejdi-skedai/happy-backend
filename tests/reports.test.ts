import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as voidService from '../src/modules/orders/voidService';
import * as splitService from '../src/modules/orders/splitService';
import * as mergeService from '../src/modules/orders/mergeService';
import * as paymentsService from '../src/modules/orders/paymentsService';
import * as shiftsService from '../src/modules/shifts/shiftsService';
import * as reportService from '../src/modules/reports/reportService';
import { businessDateWindowStart } from '../src/modules/shifts/businessDate';
import type { Shift } from '../src/generated/prisma/client';

const SLUG = 'test-reports-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  waiter2UserId: string;
  managerUserId: string;
  itemAId: string; // price 1000.00, kitchen
  itemBId: string; // price 2000.00, bar
  itemCId: string; // price 10000.00, kitchen — top_items sort-flip test only
}

let fx: Fixture;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;
  await prisma.shiftReport.deleteMany({ where: { venueId: venue.id } });
  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.payment.deleteMany({ where: { venueId: venue.id } });
  await prisma.approvalRequest.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantVoidLog.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } });
  await prisma.shift.deleteMany({ where: { venueId: venue.id } });
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
      name: 'Reports Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          taxRatePercent: 10,
          serviceChargePercent: 0,
          paymentMethodsEnabled: ['cash', 'card'],
          shiftsEnabled: true,
          businessDayStartHour: 5,
          shiftAutoCloseHours: 24,
          splitBillEnabled: true,
          splitEqualEnabled: true,
          splitByItemEnabled: true,
          splitMaxWays: 8,
          mergeTablesEnabled: true,
          mergeRequiresManager: false,
          voidReasonRequired: false,
          voidRequiresApproval: false,
          ticketNumberPrefix: 'R-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });
  const waiter = await prisma.user.create({
    data: { venueId: venue.id, role: 'waiter', fullName: 'Ana Waiter', pinHash: 'x', pinLookup: `waiter-${venue.id}` },
  });
  const waiter2 = await prisma.user.create({
    data: { venueId: venue.id, role: 'waiter', fullName: 'Ben Waiter', pinHash: 'x', pinLookup: `waiter2-${venue.id}` },
  });
  const manager = await prisma.user.create({
    data: { venueId: venue.id, role: 'manager', fullName: 'Manager Mo', pinHash: 'x', pinLookup: `manager-${venue.id}` },
  });
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const itemA = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen' },
  });
  const itemB = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Mojito', price: 2000, destination: 'bar' },
  });
  const itemC = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Caviar', price: 10000, destination: 'kitchen' },
  });

  return {
    venueId: venue.id,
    waiterUserId: waiter.id,
    waiter2UserId: waiter2.id,
    managerUserId: manager.id,
    itemAId: itemA.id,
    itemBId: itemB.id,
    itemCId: itemC.id,
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

async function withShift<T>(fn: (shift: Shift) => Promise<T>, openingFloat = 0): Promise<T> {
  const opened = await shiftsService.openShift(fx.venueId, fx.managerUserId, { openingFloat });
  if (!opened.ok) throw new Error(`shift open failed: ${JSON.stringify(opened.error)}`);
  try {
    return await fn(opened.value);
  } finally {
    // Pure test hygiene: openShift's own sweep-in-active-orders behavior
    // (2g-ii) would otherwise pull this shift's still-open orders into the
    // NEXT test's shift, contaminating its counts/revenue. Force them
    // terminal directly — bypassing the real close-order flow, which these
    // orders were never meant to go through anyway.
    await prisma.order.updateMany({
      where: { venueId: fx.venueId, shiftId: opened.value.id, status: { notIn: ['closed', 'cancelled', 'merged'] } },
      data: { status: 'closed', closedAt: new Date() },
    });
    await shiftsService.closeShift(fx.venueId, fx.managerUserId, {}, true);
  }
}

async function newOrder(actorUserId: string, guestCount?: number): Promise<string> {
  const result = await ordersService.createOrder(fx.venueId, actorUserId, { serviceMode: 'counter', guestCount: guestCount ?? null });
  if (!result.ok) throw new Error(`order setup failed: ${JSON.stringify(result.error)}`);
  return result.value.id;
}

async function addItem(orderId: string, menuItemId: string, quantity = 1): Promise<string> {
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId, quantity });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  return added.value.id;
}

async function reportForShift(shift: Shift, shiftId?: string) {
  return reportService.computeReport(fx.venueId, shift.openedAt, shift.closedAt ?? new Date(), shiftId ?? shift.id);
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Reconciliation against independently computed raw data', () => {
  it('revenue, orders, covers, waiters, and payments match hand-computed expectations', async () => {
    await withShift(async shift => {
      const order1 = await newOrder(fx.waiterUserId); // guestCount null -> covers 1
      await addItem(order1, fx.itemAId); // 1000
      await addItem(order1, fx.itemBId); // 2000 -> subtotal 3000, tax 300, grand 3300
      const paid1 = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, order1, { method: 'cash', amount: 3300, tipAmount: 50 });
      expect(paid1.ok).toBe(true);

      const order2 = await newOrder(fx.waiter2UserId, 4);
      await addItem(order2, fx.itemAId, 2); // 2000 -> subtotal 2000, tax 200, grand 2200
      const paid2 = await paymentsService.createPayment(fx.venueId, fx.waiter2UserId, order2, { method: 'card', amount: 2200 });
      expect(paid2.ok).toBe(true);

      const report = await reportForShift(shift);

      expect(report.revenue.net_sales).toBe(5000);
      expect(report.revenue.tax_total).toBe(500);
      expect(report.revenue.grand_total).toBe(5500);
      expect(report.revenue.gross_sales).toBe(5000); // no voids this scenario
      expect(report.revenue.tips_total).toBe(50);

      expect(report.orders.count).toBe(2);
      expect(report.orders.cancelled).toBe(0);
      expect(report.orders.merged).toBe(0);
      expect(report.orders.average_value).toBe(2750); // (3300+2200)/2

      expect(report.covers.total).toBe(5); // 1 (null->1) + 4
      expect(report.covers.average_per_order).toBe(2.5);
      expect(report.covers.revenue_per_cover).toBe(1000); // 5000/5

      expect(report.payments.total_captured).toBe(5500);
      const byMethod = Object.fromEntries(report.payments.by_method.map(m => [m.method, m]));
      expect(byMethod.cash).toEqual({ method: 'cash', count: 1, amount: 3300 });
      expect(byMethod.card).toEqual({ method: 'card', count: 1, amount: 2200 });

      const waitersByName = Object.fromEntries(report.waiters.map(w => [w.name, w]));
      expect(waitersByName['Ana Waiter']).toMatchObject({ orders: 1, covers: 1, gross_sales: 3000, tips_total: 50 });
      expect(waitersByName['Ben Waiter']).toMatchObject({ orders: 1, covers: 4, gross_sales: 2000, tips_total: 0 });
    });
  });
});

describe('Cancelled and merged orders', () => {
  it('are excluded from revenue but counted in orders{}', async () => {
    await withShift(async shift => {
      const cancelledOrder = await newOrder(fx.waiterUserId);
      await addItem(cancelledOrder, fx.itemAId);
      const cancelled = await lifecycleService.cancelOrder(fx.venueId, fx.waiterUserId, 'waiter', cancelledOrder, 'test cancel');
      expect(cancelled.ok).toBe(true);

      const target = await newOrder(fx.waiterUserId);
      await addItem(target, fx.itemAId); // 1000
      const source = await newOrder(fx.waiterUserId);
      await addItem(source, fx.itemAId); // 1000
      const merged = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
      expect(merged.ok).toBe(true);

      const report = await reportForShift(shift);
      expect(report.orders.cancelled).toBe(1);
      expect(report.orders.merged).toBe(1);
      expect(report.orders.count).toBe(3); // cancelledOrder + target + source(now merged)
      // Net sales: the cancelled order contributes 0 (excluded); target
      // absorbed source's item via the merge, so 2000 total (1000 + 1000),
      // counted exactly once through the target order alone.
      expect(report.revenue.net_sales).toBe(2000);
    });
  });
});

describe('Equal split', () => {
  it('excludes synthetic child items from sales — only the parent counts', async () => {
    await withShift(async shift => {
      const parent = await newOrder(fx.waiterUserId);
      await addItem(parent, fx.itemAId); // 1000 -> grand 1100
      const split = await splitService.splitEqual(fx.venueId, fx.waiterUserId, parent, 2);
      expect(split.ok).toBe(true);

      const report = await reportForShift(shift);
      expect(report.orders.count).toBe(3); // parent + 2 equal-split children
      expect(report.revenue.net_sales).toBe(1000); // parent only, not tripled
      expect(report.revenue.grand_total).toBe(1100);

      const itemA = report.top_items.find(i => i.menu_item_id === fx.itemAId);
      expect(itemA?.quantity).toBe(1);
      expect(itemA?.revenue).toBe(1000);
    });
  });
});

describe('by_item split', () => {
  it('counts parent and child exactly once each, summing to the original', async () => {
    await withShift(async shift => {
      const parent = await newOrder(fx.waiterUserId);
      await addItem(parent, fx.itemAId); // 1000
      const itemBOrderItemId = await addItem(parent, fx.itemBId); // 2000 -> subtotal 3000, tax 300, grand 3300
      const split = await splitService.splitByItem(fx.venueId, fx.waiterUserId, parent, [{ orderItemIds: [itemBOrderItemId] }]);
      expect(split.ok).toBe(true);

      const report = await reportForShift(shift);
      expect(report.orders.count).toBe(2); // parent + by_item child, both real
      expect(report.revenue.grand_total).toBe(3300); // 1100 (parent, itemA) + 2200 (child, itemB)
      expect(report.revenue.net_sales).toBe(3000);
    });
  });
});

describe('Voids', () => {
  it('matches restaurant_void_log exactly, including a rejection', async () => {
    await withShift(async shift => {
      const orderId = await newOrder(fx.waiterUserId);
      const itemAOrderItemId = await addItem(orderId, fx.itemAId);
      const itemBOrderItemId = await addItem(orderId, fx.itemBId);
      await lifecycleService.sendItems(fx.venueId, fx.waiterUserId, orderId, {});

      await withSettings({ voidRequiresApproval: true }, async () => {
        const req1 = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemAOrderItemId, { reasonText: 'wrong item' });
        expect(req1.ok).toBe(true);
        if (!req1.ok) return;
        const approved = await voidService.approveVoid(fx.venueId, fx.managerUserId, req1.value.voidLog.id);
        expect(approved.ok).toBe(true);

        const req2 = await voidService.requestVoid(fx.venueId, fx.waiterUserId, 'waiter', orderId, itemBOrderItemId, { reasonText: 'guest changed mind' });
        expect(req2.ok).toBe(true);
        if (!req2.ok) return;
        const rejected = await voidService.rejectVoid(fx.venueId, fx.managerUserId, req2.value.voidLog.id, 'no');
        expect(rejected.ok).toBe(true);
      });

      const report = await reportForShift(shift);
      expect(report.voids.count).toBe(2); // includes the rejection
      expect(report.voids.rejected_count).toBe(1);
      expect(report.voids.after_send).toBe(2);
      expect(report.voids.before_send).toBe(0);
      expect(report.voids.value).toBe(1000); // only the approved void's value
      expect(report.revenue.voids_value).toBe(1000);

      // itemB stayed live (void rejected) — order's net sales reflect that.
      expect(report.revenue.net_sales).toBe(2000); // itemB only; itemA cancelled

      const byUser = report.voids.by_user.find(u => u.user_id === fx.waiterUserId);
      expect(byUser?.count).toBe(2);
      expect(byUser?.value).toBe(1000);
    });
  });
});

describe('Top items ranking', () => {
  it('ranks correctly by both quantity and revenue, which disagree here by design', async () => {
    await withShift(async shift => {
      const orderId = await newOrder(fx.waiterUserId);
      await addItem(orderId, fx.itemAId, 5); // quantity 5, revenue 5000
      await addItem(orderId, fx.itemCId, 1); // quantity 1, revenue 10000

      const report = await reportForShift(shift);
      const byQuantity = [...report.top_items].sort((a, b) => b.quantity - a.quantity);
      const byRevenue = [...report.top_items].sort((a, b) => b.revenue - a.revenue);

      expect(byQuantity[0].menu_item_id).toBe(fx.itemAId); // 5 > 1
      expect(byRevenue[0].menu_item_id).toBe(fx.itemCId); // 10000 > 5000
    });
  });
});

describe('Snapshot discipline — CRITICAL', () => {
  it('a prior period report is byte-identical after the menu item price and a modifier option price both change', async () => {
    const group = await prisma.modifierGroup.create({ data: { venueId: fx.venueId, name: 'Extras', type: 'multiple', pricingMode: 'fixed' } });
    const option = await prisma.modifierOption.create({ data: { groupId: group.id, name: 'Extra cheese', priceDelta: 150 } });
    await prisma.menuItemModifierGroup.create({ data: { menuItemId: fx.itemAId, groupId: group.id } });

    let shiftId = '';
    await withShift(async shift => {
      shiftId = shift.id;
      const orderId = await newOrder(fx.waiterUserId);
      const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, {
        menuItemId: fx.itemAId,
        quantity: 1,
        modifierOptionIds: [option.id],
      });
      if (!added.ok) throw new Error('setup failed');
    });
    // withShift's finally already closed the shift — openedAt/closedAt are
    // now stable, so both computeReport calls below use the identical
    // period regardless of real wall-clock time between them.
    const shiftRow = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });

    const before = await reportService.computeReport(fx.venueId, shiftRow.openedAt, shiftRow.closedAt!, shiftId);

    // Change both prices after the fact.
    await prisma.menuItem.update({ where: { id: fx.itemAId }, data: { price: 999999 } });
    await prisma.modifierOption.update({ where: { id: option.id }, data: { priceDelta: 999999 } });

    const after = await reportService.computeReport(fx.venueId, shiftRow.openedAt, shiftRow.closedAt!, shiftId);

    expect(after).toEqual(before);

    // Restore for any later test relying on itemA's original price.
    await prisma.menuItem.update({ where: { id: fx.itemAId }, data: { price: 1000 } });
    await prisma.modifierGroup.delete({ where: { id: group.id } }).catch(() => {});
  });
});

describe('Materialization', () => {
  it('a finalized shift report is unchanged after new orders land in its business date', async () => {
    let shiftId = '';
    await withShift(async shift => {
      shiftId = shift.id;
      const orderId = await newOrder(fx.waiterUserId);
      await addItem(orderId, fx.itemAId);
    });
    // withShift's finally already force-closed the shift, materializing it.

    const first = await reportService.getShiftReport(fx.venueId, shiftId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // New, unrelated activity happening after the shift closed.
    const laterOrder = await newOrder(fx.waiterUserId);
    await addItem(laterOrder, fx.itemBId);

    const second = await reportService.getShiftReport(fx.venueId, shiftId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual(first.value);
  });
});

describe('Business-date boundary', () => {
  it('a 02:00 order (business_day_start_hour=5) is placed on the prior business date', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderResult.value.id, { menuItemId: fx.itemAId, quantity: 1 });
    if (!added.ok) throw new Error('setup failed');

    // Force this order onto a specific, far-past business date as if it had
    // been opened at 02:00 local on that date — the same rule
    // shifts/businessDate.ts's own unit tests already prove in isolation;
    // this proves computeReport's own date-range filtering picks it up on
    // the correct (prior) business date, not the literal calendar date.
    const priorDate = new Date('2020-06-14T00:00:00.000Z'); // the "02:00" business date
    await prisma.order.update({ where: { id: orderResult.value.id }, data: { businessDate: priorDate, shiftId: null } });

    // businessDateWindowStart, not hand-rolled UTC-midnight boundaries — a
    // naive midnight-UTC instant is itself only ~02:00 local in this
    // fixture's timezone in June (UTC+2), i.e. BEFORE the 05:00 threshold,
    // which would incorrectly resolve to the previous business date again.
    const start = businessDateWindowStart('2020-06-14', 'Europe/Tirane', 5);
    const end = new Date(businessDateWindowStart('2020-06-15', 'Europe/Tirane', 5).getTime() - 1000);
    const report = await reportService.computeReport(fx.venueId, start, end);
    expect(report.orders.count).toBe(1);
    expect(report.period.business_dates).toEqual(['2020-06-14']);

    // The following (real) calendar date must NOT include it.
    const wrongStart = businessDateWindowStart('2020-06-15', 'Europe/Tirane', 5);
    const wrongEnd = new Date(businessDateWindowStart('2020-06-16', 'Europe/Tirane', 5).getTime() - 1000);
    const wrongReport = await reportService.computeReport(fx.venueId, wrongStart, wrongEnd);
    expect(wrongReport.orders.count).toBe(0);
  });
});
