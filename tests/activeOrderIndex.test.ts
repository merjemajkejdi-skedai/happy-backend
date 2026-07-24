// Phase 2 session 2a-i, section 6: the Phase 1 partial unique index
// enforcing "one active order per table" was relaxed to exclude split-bill
// child orders (parent_order_id IS NOT NULL). These two tests are the
// explicit acceptance criteria for that change — written before the
// migration lands, per this session's TESTS FIRST rule. Uses a dedicated,
// disposable venue (never the shared dev-seed venues) so failures/successes
// here can't corrupt data other manual testing relies on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import { Prisma } from '../src/generated/prisma/client';

const TEST_VENUE_SLUG = 'test-active-order-index-fixture';

let venueId: string;
let userId: string;
let orderNumberSeq = 0;
let tableNumberSeq = 0;

async function destroyFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: TEST_VENUE_SLUG } });
  if (!venue) return;
  await prisma.order.deleteMany({ where: { venueId: venue.id } }); // cascades order_items
  await prisma.restaurantTable.deleteMany({ where: { venueId: venue.id } });
  await prisma.user.deleteMany({ where: { venueId: venue.id } });
  await prisma.venue.delete({ where: { id: venue.id } }); // cascades restaurant_settings
}

// A fresh table per test — sharing one table across tests would make a
// leftover order from an earlier test collide with this index on an
// unrelated assertion.
async function createTable() {
  tableNumberSeq += 1;
  const table = await prisma.restaurantTable.create({
    data: { venueId, tableNumber: tableNumberSeq, seats: 4 },
  });
  return table.id;
}

async function createOrder(opts: { tableId: string; status: string; parentOrderId?: string | null }) {
  orderNumberSeq += 1;
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: orderNumberSeq,
      serviceMode: 'table',
      tableId: opts.tableId,
      status: opts.status as Prisma.OrderCreateInput['status'],
      openedByUserId: userId,
      parentOrderId: opts.parentOrderId ?? null,
    },
  });
}

beforeAll(async () => {
  await destroyFixture();
  const venue = await prisma.venue.create({
    data: {
      slug: TEST_VENUE_SLUG,
      name: 'Test Active Order Index Fixture',
      venueType: 'happy_hybrid',
      settings: { create: {} },
    },
  });
  venueId = venue.id;

  const user = await prisma.user.create({
    data: { venueId, role: 'waiter', fullName: 'Fixture Waiter', pinHash: 'x', pinLookup: 'fixture-lookup' },
  });
  userId = user.id;
});

afterAll(async () => {
  await destroyFixture();
});

describe('orders_active_table_key (relaxed for split-bill in Phase 2)', () => {
  it('a) still rejects two independent active orders on the same table', async () => {
    const tableId = await createTable();
    await createOrder({ tableId, status: 'open' });

    await expect(createOrder({ tableId, status: 'open' })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('b) permits a parent order plus multiple child orders on the same table', async () => {
    const tableId = await createTable();
    const parent = await createOrder({ tableId, status: 'open' });

    const child1 = await createOrder({ tableId, status: 'open', parentOrderId: parent.id });
    const child2 = await createOrder({ tableId, status: 'open', parentOrderId: parent.id });
    const child3 = await createOrder({ tableId, status: 'sent', parentOrderId: parent.id });

    expect(child1.parentOrderId).toBe(parent.id);
    expect(child2.parentOrderId).toBe(parent.id);
    expect(child3.parentOrderId).toBe(parent.id);

    // A second *independent* (parentless) order is still rejected even with
    // children present — the parent itself still occupies the index slot.
    await expect(createOrder({ tableId, status: 'open' })).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});
