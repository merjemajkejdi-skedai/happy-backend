import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma';
import * as ordersService from '../src/modules/orders/ordersService';
import * as orderItemsService from '../src/modules/orders/orderItemsService';
import * as lifecycleService from '../src/modules/orders/lifecycleService';
import * as splitService from '../src/modules/orders/splitService';
import * as paymentsService from '../src/modules/orders/paymentsService';
import { roleHasPermission } from '../src/shared/permissions';
import { businessDateFor } from '../src/modules/menu/stockService';

const SLUG = 'test-payments-fixture';

interface Fixture {
  venueId: string;
  venueTimezone: string;
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
      name: 'Payments Fixture',
      venueType: 'happy_hybrid',
      timezone: 'Europe/Tirane',
      settings: {
        create: {
          tablesEnabled: false,
          counterServiceEnabled: true,
          requireTableForOrder: false,
          taxRatePercent: 0,
          serviceChargePercent: 0,
          paymentMethodsEnabled: ['cash', 'card', 'room_charge'],
          allowPartialPayment: true,
          requirePaymentToClose: false,
          splitBillEnabled: true,
          splitEqualEnabled: true,
          splitMaxWays: 8,
          ticketNumberPrefix: 'P-',
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

  return { venueId: venue.id, venueTimezone: venue.timezone, waiterUserId: waiter.id, managerUserId: manager.id, itemId: item.id };
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

// grand_total lands at exactly 1000.00 — tax/service charge are zeroed in the fixture.
async function newOrderWithItem(): Promise<string> {
  const orderResult = await ordersService.createOrder(fx.venueId, fx.waiterUserId, { serviceMode: 'counter' });
  if (!orderResult.ok) throw new Error('order setup failed');
  const added = await orderItemsService.addItem(fx.venueId, fx.waiterUserId, orderResult.value.id, { menuItemId: fx.itemId, quantity: 1 });
  if (!added.ok) throw new Error(`addItem failed: ${JSON.stringify(added.error)}`);
  return orderResult.value.id;
}

beforeAll(async () => {
  fx = await setupFixture();
});
afterAll(async () => {
  await destroyFixture();
});

describe('Disabled method', () => {
  it('rejects a method not in payment_methods_enabled', async () => {
    const orderId = await newOrderWithItem();
    const result = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'voucher', amount: 1000 });
    expect(result).toEqual({
      ok: false,
      error: { status: 422, code: 'PAYMENT_METHOD_DISABLED', message: "Payment method 'voucher' is not enabled for this venue" },
    });
  });
});

describe('Overpayment', () => {
  it('cash: computes change_amount from received_amount', async () => {
    const orderId = await newOrderWithItem();
    const result = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, {
      method: 'cash',
      amount: 1000,
      receivedAmount: 1200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number(result.value.changeAmount)).toBe(200);

    const order = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(order!.amountPaid)).toBe(1000);
    expect(Number(order!.amountDue)).toBe(0);
  });

  it('cash: amount itself may exceed amount_due', async () => {
    const orderId = await newOrderWithItem();
    const result = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1200 });
    expect(result.ok).toBe(true);
  });

  it('card: exceeding amount_due is rejected', async () => {
    const orderId = await newOrderWithItem();
    const result = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'card', amount: 1200 });
    expect(result).toEqual({ ok: false, error: { status: 422, code: 'PAYMENT_EXCEEDS_DUE', message: 'This payment exceeds the amount due' } });
  });
});

describe('Partial payments', () => {
  it('accumulate correctly across two payments', async () => {
    const orderId = await newOrderWithItem();
    const first = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 400 });
    expect(first.ok).toBe(true);
    let order = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(order!.amountPaid)).toBe(400);
    expect(Number(order!.amountDue)).toBe(600);

    const second = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'card', amount: 600 });
    expect(second.ok).toBe(true);
    order = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(order!.amountPaid)).toBe(1000);
    expect(Number(order!.amountDue)).toBe(0);
  });

  it('allow_partial_payment=false rejects a payment that would leave a balance', async () => {
    await withSettings({ allowPartialPayment: false }, async () => {
      const orderId = await newOrderWithItem();
      const partial = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 400 });
      expect(partial).toEqual({
        ok: false,
        error: { status: 422, code: 'PARTIAL_PAYMENT_NOT_ALLOWED', message: 'This venue requires a single payment to settle the full amount due' },
      });

      const full = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
      expect(full.ok).toBe(true);
    });
  });
});

describe('require_payment_to_close', () => {
  it('blocks close while unpaid, then permits it once settled', async () => {
    await withSettings({ requirePaymentToClose: true }, async () => {
      const orderId = await newOrderWithItem();
      // Push straight to 'served' — closeOrder's unserved-items gate reads
      // item status directly, not the order's own denormalized status.
      await prisma.orderItem.updateMany({ where: { orderId }, data: { status: 'served', servedAt: new Date() } });

      const blocked = await lifecycleService.closeOrder(fx.venueId, fx.managerUserId, orderId);
      expect(blocked).toEqual({
        ok: false,
        error: { status: 409, code: 'ORDER_NOT_SETTLED', message: 'This order must be fully paid before it can be closed' },
      });

      const paid = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
      expect(paid.ok).toBe(true);

      const closed = await lifecycleService.closeOrder(fx.venueId, fx.managerUserId, orderId);
      expect(closed.ok).toBe(true);
      if (closed.ok) expect(closed.value.status).toBe('closed');
    });
  });
});

describe('Void', () => {
  it('is gated to manager+ by the permission matrix, and recomputes the order on void', async () => {
    expect(roleHasPermission('waiter', 'order.payment_void')).toBe(false);
    expect(roleHasPermission('manager', 'order.payment_void')).toBe(true);

    const orderId = await newOrderWithItem();
    const created = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let order = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(order!.amountPaid)).toBe(1000);
    expect(Number(order!.amountDue)).toBe(0);

    const voided = await paymentsService.voidPayment(fx.venueId, fx.managerUserId, orderId, created.value.id, 'entered in error');
    expect(voided.ok).toBe(true);
    if (voided.ok) {
      expect(voided.value.isVoided).toBe(true);
      expect(voided.value.voidedReason).toBe('entered in error');
      expect(voided.value.voidedByUserId).toBe(fx.managerUserId);
    }

    order = await ordersService.getOrder(fx.venueId, orderId);
    expect(Number(order!.amountPaid)).toBe(0);
    expect(Number(order!.amountDue)).toBe(1000);

    // Row survives — never deleted.
    const stillThere = await prisma.payment.findUnique({ where: { id: created.value.id } });
    expect(stillThere).not.toBeNull();
  });

  it('rejects voiding an already-voided payment', async () => {
    const orderId = await newOrderWithItem();
    const created = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
    if (!created.ok) throw new Error('setup failed');
    await paymentsService.voidPayment(fx.venueId, fx.managerUserId, orderId, created.value.id, 'a');

    const second = await paymentsService.voidPayment(fx.venueId, fx.managerUserId, orderId, created.value.id, 'b');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('PAYMENT_ALREADY_VOIDED');
  });
});

describe('Shift and business date', () => {
  it('attaches shift_id from the order and computes business_date independently', async () => {
    const orderId = await newOrderWithItem();
    const order = await ordersService.getOrder(fx.venueId, orderId);
    const result = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shiftId).toBe(order!.shiftId); // both null today — order.shift_id is never populated
    expect(result.value.businessDate.getTime()).toBe(businessDateFor(fx.venueTimezone).getTime());
  });
});

describe('Split children pay independently', () => {
  it('paying a child does not settle the parent, and the other child stays unpaid', async () => {
    const parentId = await newOrderWithItem();
    const split = await splitService.splitEqual(fx.venueId, fx.waiterUserId, parentId, 2);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const [child1, child2] = split.value;

    const paid = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, child1.id, { method: 'cash', amount: 500 });
    expect(paid.ok).toBe(true);

    const child1After = await ordersService.getOrder(fx.venueId, child1.id);
    const child2After = await ordersService.getOrder(fx.venueId, child2.id);
    const parentAfter = await ordersService.getOrder(fx.venueId, parentId);
    expect(Number(child1After!.amountPaid)).toBe(500);
    expect(Number(child2After!.amountPaid)).toBe(0);
    expect(Number(parentAfter!.amountPaid)).toBe(0);
  });

  it('paying the parent blocks further splitting (the 2f-i guard)', async () => {
    const orderId = await newOrderWithItem();
    const paid = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'cash', amount: 1000 });
    expect(paid.ok).toBe(true);

    const split = await splitService.splitEqual(fx.venueId, fx.waiterUserId, orderId, 2);
    expect(split.ok).toBe(false);
    if (!split.ok) expect(split.error.code).toBe('ORDER_ALREADY_PAID');
  });
});

describe('room_charge', () => {
  it('is a tender label only — writes no pms_* field', async () => {
    const orderId = await newOrderWithItem();
    const result = await paymentsService.createPayment(fx.venueId, fx.waiterUserId, orderId, { method: 'room_charge', amount: 1000 });
    expect(result.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.pmsFolioId).toBeNull();
    expect(order.pmsRoomNumber).toBeNull();
    expect(order.pmsPostedAt).toBeNull();
  });
});
