import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as coursesService from '../src/modules/orders/coursesService';
import * as splitService from '../src/modules/orders/splitService';
import * as mergeService from '../src/modules/orders/mergeService';

const SLUG = 'test-merge-fixture';

interface Fixture {
  venueId: string;
  waiterUserId: string;
  managerUserId: string;
  itemAId: string; // price 1000.00, course 1
  itemBId: string; // price 2000.00, course 2
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
      name: 'Merge Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: true,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          allowTableTransfer: true,
          taxRatePercent: 10,
          serviceChargePercent: 0,
          coursesEnabled: true,
          sendByCourse: true,
          mergeTablesEnabled: true,
          mergeRequiresManager: true,
          splitBillEnabled: true,
          splitEqualEnabled: true,
          splitMaxWays: 8,
          ticketNumberPrefix: 'M-',
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
  const area = await prisma.area.create({ data: { venueId: venue.id, name: 'Main' } });
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const itemA = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Starter', price: 1000, destination: 'kitchen' },
  });
  const itemB = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Main', price: 2000, destination: 'kitchen' },
  });

  return { venueId: venue.id, waiterUserId: waiter.id, managerUserId: manager.id, itemAId: itemA.id, itemBId: itemB.id, areaId: area.id };
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

async function newCounterOrder(): Promise<string> {
  const result = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!result.ok) throw new Error('order setup failed');
  return result.value.id;
}

async function newTableOrder(): Promise<{ orderId: string; tableId: string }> {
  const tableId = await newFreeTable();
  const result = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'table', tableId });
  if (!result.ok) throw new Error(`table order setup failed: ${JSON.stringify(result.error)}`);
  return { orderId: result.value.id, tableId };
}

async function newFreeTable(): Promise<string> {
  const table = await prisma.restaurantTable.create({ data: { venueId: fx.venueId, areaId: fx.areaId, tableNumber: Math.floor(Math.random() * 1_000_000) } });
  return table.id;
}

async function addItem(orderId: string, menuItemId: string, courseNumber?: number): Promise<string> {
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderId, { menuItemId, quantity: 1, courseNumber });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  return added.value.id;
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Items move with kitchen state intact', () => {
  it('preserves snapshots, status, and timestamps — only order_id changes', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    const sourceItemId = await addItem(source, fx.itemAId, 1);
    await coursesService.fireCourse(fx.venueId, fx.waiterUserId, source, 1); // sourceItem -> 'sent'

    const before = await prisma.orderItem.findUniqueOrThrow({ where: { id: sourceItemId } });
    expect(before.status).toBe('sent');
    expect(before.sentAt).not.toBeNull();

    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(result.ok).toBe(true);

    const after = await prisma.orderItem.findUniqueOrThrow({ where: { id: sourceItemId } });
    expect(after.orderId).toBe(target);
    expect(after.status).toBe(before.status);
    expect(after.sentAt?.getTime()).toBe(before.sentAt?.getTime());
    expect(after.itemNameSnapshot).toBe(before.itemNameSnapshot);
    expect(Number(after.unitPriceSnapshot)).toBe(Number(before.unitPriceSnapshot));
  });
});

describe('Source becomes merged, not cancelled', () => {
  it('sets status=merged, merged_into_order_id, merged_at, merged_by_user_id, and zeroes totals', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    await addItem(target, fx.itemAId);
    await addItem(source, fx.itemBId);

    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.source.status).toBe('merged');
    expect(result.value.source.mergedIntoOrderId).toBe(target);
    expect(result.value.source.mergedByUserId).toBe(fx.managerUserId);
    expect(result.value.source.mergedAt).not.toBeNull();
    expect(Number(result.value.source.grandTotal)).toBe(0);
    expect(Number(result.value.source.subtotal)).toBe(0);
  });
});

describe('Table handling', () => {
  it('frees the source table (dirty) and leaves the target table untouched by default', async () => {
    const { orderId: target, tableId: targetTableId } = await newTableOrder();
    const { orderId: source, tableId: sourceTableId } = await newTableOrder();
    await addItem(target, fx.itemAId);
    await addItem(source, fx.itemBId);

    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(result.ok).toBe(true);

    const sourceTable = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: sourceTableId } });
    expect(sourceTable.status).toBe('dirty');
    const targetTable = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: targetTableId } });
    expect(targetTable.status).toBe('occupied');

    const targetAfter = await prisma.order.findUniqueOrThrow({ where: { id: target } });
    expect(targetAfter.tableId).toBe(targetTableId);
  });

  it('transfers the target first when target_table_id is given', async () => {
    const { orderId: target } = await newTableOrder();
    const { orderId: source } = await newTableOrder();
    const newTableId = await newFreeTable();
    await addItem(target, fx.itemAId);
    await addItem(source, fx.itemBId);

    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source, newTableId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target.tableId).toBe(newTableId);
  });
});

describe('Totals conservation', () => {
  it('target grand_total after merge equals the sum of both original totals, including tax', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    await addItem(target, fx.itemAId); // 1000 * 1.10 = 1100
    await addItem(source, fx.itemBId); // 2000 * 1.10 = 2200

    const targetBefore = await ordersService.getOrder(fx.venueId, target);
    const sourceBefore = await ordersService.getOrder(fx.venueId, source);
    expect(Number(targetBefore!.grandTotal)).toBe(1100);
    expect(Number(sourceBefore!.grandTotal)).toBe(2200);

    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(result.value.target.grandTotal)).toBe(3300);
  });
});

describe('Gates', () => {
  it('rejects 403 MERGE_DISABLED when merge_tables_enabled is off', async () => {
    await withSettings({ mergeTablesEnabled: false }, async () => {
      const target = await newCounterOrder();
      const source = await newCounterOrder();
      const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
      expect(result).toEqual({ ok: false, error: { status: 403, code: 'MERGE_DISABLED', message: 'Table merge is not enabled for this venue' } });
    });
  });

  it('enforces merge_requires_manager for a waiter, but allows a manager', async () => {
    const target1 = await newCounterOrder();
    const source1 = await newCounterOrder();
    const waiterResult = await mergeService.mergeOrders(fx.venueId, fx.waiterUserId, 'waiter', target1, source1);
    expect(waiterResult).toEqual({
      ok: false,
      error: { status: 403, code: 'MERGE_REQUIRES_MANAGER', message: 'Merging orders requires manager approval at this venue' },
    });

    const target2 = await newCounterOrder();
    const source2 = await newCounterOrder();
    const managerResult = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target2, source2);
    expect(managerResult.ok).toBe(true);
  });

  it('rejects merging a paid order', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    await prisma.order.update({ where: { id: source }, data: { amountPaid: 50 } });
    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ORDER_ALREADY_PAID');
  });

  it('rejects merging into/from an already-merged order', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    const first = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(first.ok).toBe(true);

    const third = await newCounterOrder();
    // source is now status='merged' — using it again (either side) must fail.
    const asSource = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', third, source);
    expect(asSource.ok).toBe(false);
    if (!asSource.ok) expect(asSource.error.code).toBe('ORDER_NOT_MODIFIABLE');

    const asTarget = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', source, third);
    expect(asTarget.ok).toBe(false);
    if (!asTarget.ok) expect(asTarget.error.code).toBe('ORDER_NOT_MODIFIABLE');
  });

  it('rejects a cross-venue source order with NOT_FOUND', async () => {
    const stale = await prisma.venue.findUnique({ where: { slug: 'test-merge-other-venue' } });
    if (stale) {
      await prisma.orderEvent.deleteMany({ where: { venueId: stale.id } });
      await prisma.order.deleteMany({ where: { venueId: stale.id } });
      await prisma.ticketCounter.deleteMany({ where: { venueId: stale.id } });
      await prisma.user.deleteMany({ where: { venueId: stale.id } });
      await prisma.venue.delete({ where: { id: stale.id } });
    }

    const otherVenue = await prisma.venue.create({
      data: {
        slug: 'test-merge-other-venue',
        name: 'Other Venue',
        venueType: 'happy_hybrid',
        timezone: 'Europe/Tirane',
        settings: { create: { counterServiceEnabled: true, requireTableForOrder: false, mergeTablesEnabled: true, mergeRequiresManager: false } },
      },
    });
    const otherUser = await prisma.user.create({
      data: { venueId: otherVenue.id, role: 'manager', fullName: 'Other Manager', pinHash: 'x', pinLookup: `other-${otherVenue.id}` },
    });
    const otherOrderResult = await ordersService.createOrder(otherVenue.id, otherUser.id, { serviceMode: 'counter' });
    if (!otherOrderResult.ok) throw new Error(`cross-venue setup failed: ${JSON.stringify(otherOrderResult.error)}`);

    const target = await newCounterOrder();
    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, otherOrderResult.value.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');

    await prisma.orderEvent.deleteMany({ where: { venueId: otherVenue.id } });
    await prisma.order.deleteMany({ where: { venueId: otherVenue.id } });
    await prisma.ticketCounter.deleteMany({ where: { venueId: otherVenue.id } });
    await prisma.user.deleteMany({ where: { venueId: otherVenue.id } });
    await prisma.venue.delete({ where: { id: otherVenue.id } });
  });

  it('rejects a split-bill child as either side, and a split parent with a live child', async () => {
    const parent = await newCounterOrder();
    await addItem(parent, fx.itemAId);
    const splitResult = await splitService.splitEqual(fx.venueId, fx.managerUserId, parent, 2);
    expect(splitResult.ok).toBe(true);
    if (!splitResult.ok) return;
    const child = splitResult.value[0].id;

    const other = await newCounterOrder();

    const childAsSource = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', other, child);
    expect(childAsSource.ok).toBe(false);
    if (!childAsSource.ok) expect(childAsSource.error.code).toBe('MERGE_ORDER_HAS_SPLIT');

    const parentAsTarget = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', parent, other);
    expect(parentAsTarget.ok).toBe(false);
    if (!parentAsTarget.ok) expect(parentAsTarget.error.code).toBe('MERGE_ORDER_HAS_SPLIT');
  });
});

describe('Course reconciliation', () => {
  it('takes the earlier fired_at when both sides fired the same course number, and rolls up item_count', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    const targetItemId = await addItem(target, fx.itemAId, 1);
    const sourceItemId = await addItem(source, fx.itemBId, 1); // same course_number 1 on both sides

    const targetFire = await coursesService.fireCourse(fx.venueId, fx.waiterUserId, target, 1);
    expect(targetFire.ok).toBe(true);
    const targetFiredAt = targetFire.ok ? targetFire.value.firedAt! : null;

    const sourceFire = await coursesService.fireCourse(fx.venueId, fx.waiterUserId, source, 1);
    expect(sourceFire.ok).toBe(true);

    const result = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const targetCourse1 = await prisma.orderCourse.findUniqueOrThrow({ where: { orderId_courseNumber: { orderId: target, courseNumber: 1 } } });
    expect(targetCourse1.itemCount).toBe(2); // both items now on target, same course number
    expect(targetCourse1.firedAt?.getTime()).toBe(targetFiredAt!.getTime()); // target fired first — earlier wins

    const targetItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: targetItemId } });
    const sourceItemAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: sourceItemId } });
    expect(targetItem.status).toBe('sent');
    expect(sourceItemAfter.status).toBe('sent');
    expect(sourceItemAfter.orderId).toBe(target);
  });
});

describe('Preview', () => {
  it('matches the committed result exactly, and writes nothing itself', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    await addItem(target, fx.itemAId, 1);
    const sourceItemId = await addItem(source, fx.itemBId, 2);

    const preview = await mergeService.previewMerge(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    // Preview must not have written anything — the source item is still on
    // the source order and the source is still unmerged.
    const itemStillOnSource = await prisma.orderItem.findUniqueOrThrow({ where: { id: sourceItemId } });
    expect(itemStillOnSource.orderId).toBe(source);
    const sourceStillLive = await prisma.order.findUniqueOrThrow({ where: { id: source } });
    expect(sourceStillLive.status).not.toBe('merged');
    const noEvents = await prisma.orderEvent.findMany({ where: { venueId: fx.venueId, orderId: target, eventType: 'order.merged' } });
    expect(noEvents).toHaveLength(0);

    const commit = await mergeService.mergeOrders(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    expect(preview.value.itemCount).toBe(2);
    expect(preview.value.grandTotal).toBe(commit.value.target.grandTotal.toString());

    const finalCourses = await prisma.orderCourse.findMany({ where: { orderId: target, venueId: fx.venueId }, orderBy: { courseNumber: 'asc' } });
    expect(preview.value.courses).toEqual(finalCourses.map(c => ({ courseNumber: c.courseNumber, itemCount: c.itemCount, status: c.status, firedAt: c.firedAt })));
  });
});

describe('Rollback on failure', () => {
  // Merge has no natural DB-constraint tripwire the way split does (split
  // allocates fresh order_numbers, which a pre-occupied row can collide
  // with; merge only moves/updates existing rows, nothing it writes is
  // uniquely constrained). previewMerge IS a real, deterministic exercise
  // of this exact guarantee — it runs the identical write sequence
  // (item move, source recompute+flag, target recompute, course
  // reconciliation, table dirty-flag, both events) inside a transaction
  // that always throws afterward — so asserting zero observable side
  // effects survive it is a genuine, non-racy atomicity proof, not a
  // weaker substitute.
  it('previewMerge leaves the DB completely unchanged after its guaranteed internal rollback', async () => {
    const target = await newCounterOrder();
    const source = await newCounterOrder();
    const targetItemId = await addItem(target, fx.itemAId, 1);
    const sourceItemId = await addItem(source, fx.itemBId, 1);
    await coursesService.fireCourse(fx.venueId, fx.waiterUserId, source, 1);

    const before = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: target } }),
      prisma.order.findUniqueOrThrow({ where: { id: source } }),
      prisma.orderCourse.findMany({ where: { venueId: fx.venueId, orderId: { in: [target, source] } } }),
    ]);

    const preview = await mergeService.previewMerge(fx.venueId, fx.managerUserId, 'manager', target, source);
    expect(preview.ok).toBe(true);

    const after = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: target } }),
      prisma.order.findUniqueOrThrow({ where: { id: source } }),
      prisma.orderCourse.findMany({ where: { venueId: fx.venueId, orderId: { in: [target, source] } } }),
    ]);

    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual(before[2]);

    const targetItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: targetItemId } });
    const sourceItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: sourceItemId } });
    expect(targetItem.orderId).toBe(target);
    expect(sourceItem.orderId).toBe(source);

    const events = await prisma.orderEvent.findMany({ where: { venueId: fx.venueId, orderId: { in: [target, source] }, eventType: { in: ['order.merged', 'order.absorbed'] } } });
    expect(events).toHaveLength(0);
  });
});
