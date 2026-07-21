import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as menuItemsService from '../src/modules/menu/itemsService';

const SLUG = 'test-orders-fixture';

interface Fixture {
  venueId: string;
  adminUserId: string;
  tableIds: string[];
  categoryId: string;
  itemId: string; // price 1000, no item-level tax override -> inherits settings 10%
  lowTaxItemId: string; // price 500, item-level taxRatePercent 5%
  groupId: string; // required, single, min 1 max 1
  cheeseOptionId: string; // priceDelta 100
  baconOptionId: string; // priceDelta 200
}

let fx: Fixture;

// Orders/order_items/order_item_modifiers/order_events aren't cascade-safe
// through a plain venue delete (several of the relevant FKs are RESTRICT,
// not CASCADE — see docs/SCHEMA.md) — tear down in dependency order.
async function destroyOrdersFixture() {
  const venue = await prisma.venue.findUnique({ where: { slug: SLUG } });
  if (!venue) return;

  await prisma.orderEvent.deleteMany({ where: { venueId: venue.id } });
  await prisma.order.deleteMany({ where: { venueId: venue.id } }); // cascades order_items, order_item_modifiers
  await prisma.ticketCounter.deleteMany({ where: { venueId: venue.id } });

  const groups = await prisma.modifierGroup.findMany({ where: { venueId: venue.id } });
  const items = await prisma.menuItem.findMany({ where: { venueId: venue.id } });
  await prisma.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: items.map(i => i.id) } } });
  await prisma.modifierOption.deleteMany({ where: { groupId: { in: groups.map(g => g.id) } } });
  await prisma.modifierGroup.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuItem.deleteMany({ where: { venueId: venue.id } });
  await prisma.menuCategory.deleteMany({ where: { venueId: venue.id } });
  await prisma.restaurantTable.deleteMany({ where: { venueId: venue.id } });
  await prisma.area.deleteMany({ where: { venueId: venue.id } });
  await prisma.user.deleteMany({ where: { venueId: venue.id } });
  await prisma.venue.delete({ where: { id: venue.id } }); // cascades restaurant_settings
}

async function setupOrdersFixture(): Promise<Fixture> {
  await destroyOrdersFixture();

  const venue = await prisma.venue.create({
    data: {
      slug: SLUG,
      name: 'Orders Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          coursesEnabled: true,
          tablesEnabled: true,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          allowFreeTextNotes: true,
          requireReasonOnVoid: true,
          allowItemVoidAfterSend: false,
          autoSendOnAdd: false,
          taxRatePercent: 10,
          serviceChargePercent: 5,
          ticketNumberPrefix: 'T-',
          ticketNumberReset: 'daily',
        },
      },
    },
  });

  const admin = await prisma.user.create({
    data: { venueId: venue.id, role: 'admin', fullName: 'Fixture Admin', pinHash: 'x', pinLookup: `fixture-${venue.id}` },
  });

  const area = await prisma.area.create({ data: { venueId: venue.id, name: 'Main' } });
  const tableIds: string[] = [];
  for (let n = 1; n <= 6; n++) {
    const table = await prisma.restaurantTable.create({ data: { venueId: venue.id, areaId: area.id, tableNumber: n } });
    tableIds.push(table.id);
  }

  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Mains', defaultDestination: 'kitchen' } });
  const item = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Burger', price: 1000, destination: 'kitchen' },
  });
  const lowTaxItem = await prisma.menuItem.create({
    data: { venueId: venue.id, categoryId: category.id, name: 'Side Salad', price: 500, destination: 'kitchen', taxRatePercent: 5 },
  });

  const group = await prisma.modifierGroup.create({
    data: { venueId: venue.id, name: 'Toppings', type: 'single', isRequired: true, minSelect: 1, maxSelect: 1 },
  });
  const cheese = await prisma.modifierOption.create({ data: { groupId: group.id, name: 'Cheese', priceDelta: 100 } });
  const bacon = await prisma.modifierOption.create({ data: { groupId: group.id, name: 'Bacon', priceDelta: 200 } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: item.id, groupId: group.id } });

  return {
    venueId: venue.id,
    adminUserId: admin.id,
    tableIds,
    categoryId: category.id,
    itemId: item.id,
    lowTaxItemId: lowTaxItem.id,
    groupId: group.id,
    cheeseOptionId: cheese.id,
    baconOptionId: bacon.id,
  };
}

beforeAll(async () => {
  fx = await setupOrdersFixture();
});
afterAll(async () => {
  await destroyOrdersFixture();
});

describe('Numbering under concurrent creation', () => {
  it('never assigns a duplicate order_number to concurrent counter-service creates', async () => {
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' })),
    );
    for (const r of results) expect(r.ok).toBe(true);

    const orderNumbers = results.map(r => (r.ok ? r.value.orderNumber : -1));
    expect(new Set(orderNumbers).size).toBe(N); // all unique — no duplicate allocation under a race

    const ticketNumbers = results.map(r => (r.ok ? r.value.ticketNumber : null));
    expect(new Set(ticketNumbers).size).toBe(N); // ticket numbers are unique too
    expect(ticketNumbers.every(t => t?.startsWith('T-'))).toBe(true);
  });
});

describe('One-active-order-per-table constraint', () => {
  it('rejects a second order on a table that already has an active one with 409 TABLE_ALREADY_HAS_ACTIVE_ORDER', async () => {
    const tableId = fx.tableIds[0];
    const first = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId });
    expect(first.ok).toBe(true);

    const second = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId });
    expect(second).toEqual({
      ok: false,
      error: { status: 409, code: 'TABLE_ALREADY_HAS_ACTIVE_ORDER', message: 'This table already has an active order' },
    });
  });

  it('sets the table to occupied on order creation', async () => {
    const tableId = fx.tableIds[1];
    await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId });
    const table = await prisma.restaurantTable.findUnique({ where: { id: tableId } });
    expect(table!.status).toBe('occupied');
  });
});

describe('Counter orders with no table', () => {
  it('creates a counter-service order with a generated ticket_number and a null table_id', async () => {
    const result = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tableId).toBeNull();
    expect(result.value.ticketNumber).toMatch(/^T-\d{4}$/);
  });

  it('rejects table_id being supplied on a counter-service order', async () => {
    const result = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter', tableId: fx.tableIds[2] });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_ID_NOT_ALLOWED', message: 'table_id must be omitted for a counter-service order' },
    });
  });

  it('rejects counter mode when require_table_for_order is true', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { requireTableForOrder: true } });
    const result = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'TABLE_REQUIRED_FOR_ORDER', message: 'This venue requires a table for every order' },
    });
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { requireTableForOrder: false } });
  });

  it('rejects counter mode when counter_service_enabled is false', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { counterServiceEnabled: false } });
    const result = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'COUNTER_SERVICE_DISABLED', message: 'Counter service is not enabled for this venue' },
    });
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { counterServiceEnabled: true } });
  });
});

describe('Snapshot immutability after a menu price change', () => {
  it('leaves an existing order item and its line totals untouched when the menu price changes', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[3] });
    expect(orderResult.ok).toBe(true);
    if (!orderResult.ok) return;
    const orderId = orderResult.value.id;

    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.itemId,
      quantity: 1,
      modifierOptionIds: [fx.cheeseOptionId],
    });
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;

    expect(Number(addResult.value.unitPriceSnapshot)).toBe(1000);
    expect(Number(addResult.value.lineTotal)).toBe(1100); // (1000 + 100) * 1

    const priceChange = await menuItemsService.updateItem(fx.venueId, fx.itemId, { price: 999999 });
    expect(priceChange.ok).toBe(true);

    const orderAfter = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(orderAfter!.items[0].unitPriceSnapshot)).toBe(1000);
    expect(Number(orderAfter!.items[0].lineTotal)).toBe(1100);
    expect(Number(orderAfter!.subtotal)).toBe(1100);

    // Revert for the other tests in this file.
    await menuItemsService.updateItem(fx.venueId, fx.itemId, { price: 1000 });
  });
});

describe('Modifier validation matrix', () => {
  let orderId: string;

  beforeAll(async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'table', tableId: fx.tableIds[4] });
    orderId = orderResult.ok ? orderResult.value.id : '';
  });

  it('rejects zero selections for a required group', async () => {
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, { menuItemId: fx.itemId, modifierOptionIds: [] });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_SELECTION_INVALID', message: '"Toppings" requires at least 1 selection(s)' },
    });
  });

  it('rejects two selections for a single-type group', async () => {
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.itemId,
      modifierOptionIds: [fx.cheeseOptionId, fx.baconOptionId],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_SELECTION_INVALID', message: '"Toppings" allows only one selection' },
    });
  });

  it('rejects an option id that does not exist', async () => {
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.itemId,
      modifierOptionIds: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'MODIFIER_SELECTION_INVALID', message: 'One or more selected modifier options are invalid' },
    });
  });

  it('accepts exactly one selection for the required single group', async () => {
    const result = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.itemId,
      modifierOptionIds: [fx.baconOptionId],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Number(result.value.modifiersTotal)).toBe(200);
  });
});

describe('Void rules with the flag on and off', () => {
  it('lets any actor void a pending item without special permission', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderResult.value.id, {
      menuItemId: fx.itemId,
      modifierOptionIds: [fx.cheeseOptionId],
    });
    if (!addResult.ok) throw new Error('setup failed');

    const result = await orderItemsService.voidItem(
      fx.venueId, fx.adminUserId, 'waiter', orderResult.value.id, addResult.value.id, { reason: 'changed mind' },
    );
    expect(result.ok).toBe(true);

    const order = await ordersService.getOrder(fx.venueId, orderResult.value.id);
    expect(Number(order!.subtotal)).toBe(0); // cancelled items are excluded from totals
  });

  it('requires a reason when require_reason_on_void is true', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderResult.value.id, {
      menuItemId: fx.itemId,
      modifierOptionIds: [fx.cheeseOptionId],
    });
    if (!addResult.ok) throw new Error('setup failed');

    const result = await orderItemsService.voidItem(fx.venueId, fx.adminUserId, 'waiter', orderResult.value.id, addResult.value.id, {});
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'VOID_REASON_REQUIRED', message: 'A reason is required to void this item' },
    });
  });

  it('rejects voiding a sent item when allow_item_void_after_send is false, even for admin', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderResult.value.id, {
      menuItemId: fx.itemId,
      modifierOptionIds: [fx.cheeseOptionId],
    });
    if (!addResult.ok) throw new Error('setup failed');
    await prisma.orderItem.update({ where: { id: addResult.value.id }, data: { status: 'sent' } });

    const result = await orderItemsService.voidItem(
      fx.venueId, fx.adminUserId, 'admin', orderResult.value.id, addResult.value.id, { reason: 'kitchen error' },
    );
    expect(result).toEqual({
      ok: false,
      error: { status: 403, code: 'VOID_AFTER_SEND_NOT_ALLOWED', message: 'Voiding an item after it has been sent is not allowed' },
    });
  });

  it('allows an admin (with the flag on) to void a sent item, but denies a waiter the same action', async () => {
    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { allowItemVoidAfterSend: true } });

    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const addResult = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderResult.value.id, {
      menuItemId: fx.itemId,
      modifierOptionIds: [fx.cheeseOptionId],
    });
    if (!addResult.ok) throw new Error('setup failed');
    await prisma.orderItem.update({ where: { id: addResult.value.id }, data: { status: 'sent' } });

    const waiterAttempt = await orderItemsService.voidItem(
      fx.venueId, fx.adminUserId, 'waiter', orderResult.value.id, addResult.value.id, { reason: 'kitchen error' },
    );
    expect(waiterAttempt).toEqual({
      ok: false,
      error: { status: 403, code: 'VOID_AFTER_SEND_NOT_ALLOWED', message: 'Voiding an item after it has been sent is not allowed' },
    });

    const adminAttempt = await orderItemsService.voidItem(
      fx.venueId, fx.adminUserId, 'admin', orderResult.value.id, addResult.value.id, { reason: 'kitchen error' },
    );
    expect(adminAttempt.ok).toBe(true);

    await prisma.restaurantSettings.update({ where: { venueId: fx.venueId }, data: { allowItemVoidAfterSend: false } });
  });
});

describe('Totals math with modifiers and mixed tax rates', () => {
  it('computes subtotal/tax/service-charge/grand totals across items with different tax rates', async () => {
    const orderResult = await ordersService.createOrder(fx.venueId, fx.adminUserId, { serviceMode: 'counter' });
    if (!orderResult.ok) throw new Error('setup failed');
    const orderId = orderResult.value.id;

    // Item 1: 1000, qty 2, +100 modifier -> line_total = (1000+100)*2 = 2200, tax @ 10% (venue default) = 220
    const item1 = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.itemId, quantity: 2, modifierOptionIds: [fx.cheeseOptionId],
    });
    expect(item1.ok).toBe(true);

    // Item 2: 500, qty 1, no modifiers -> line_total = 500, tax @ item-level 5% override = 25
    const item2 = await orderItemsService.addItem(fx.venueId, fx.adminUserId, orderId, {
      menuItemId: fx.lowTaxItemId, quantity: 1,
    });
    expect(item2.ok).toBe(true);

    const order = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(order!.subtotal)).toBe(2700); // 2200 + 500
    expect(Number(order!.taxTotal)).toBe(245); // 220 + 25
    expect(Number(order!.serviceChargeTotal)).toBe(135); // 2700 * 5%
    expect(Number(order!.grandTotal)).toBe(3080); // 2700 + 245 + 135 - 0
  });
});

// Idempotency-Key handling itself moved to a generic lib/idempotency.ts store
// in Prompt 10 — see tests/idempotency.test.ts.
