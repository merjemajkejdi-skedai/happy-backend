import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { businessDateFor } from '../menu/stockService';
import { Prisma, type Payment, type PaymentMethod } from '../../generated/prisma/client';

export type PaymentResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

const ORDER_NOT_MODIFIABLE = (status: string) => err(409, 'ORDER_NOT_MODIFIABLE', `Cannot modify an order with status '${status}'`);

// Sums every non-voided payment on the order into amount_paid, and derives
// amount_due as whatever's left of grand_total — clamped at 0 rather than
// going negative, since a cash overpayment can legitimately push amount_paid
// past grand_total (the excess became change, not unaccounted debt).
export async function recomputeOrderPayments(tx: Tx, venueId: string, orderId: string) {
  const [order, payments] = await Promise.all([
    tx.order.findUniqueOrThrow({ where: { id: orderId } }),
    tx.payment.findMany({ where: { orderId, venueId, isVoided: false } }),
  ]);
  const amountPaid = payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const amountDue = Prisma.Decimal.max(order.grandTotal.minus(amountPaid), new Prisma.Decimal(0));
  return tx.order.update({ where: { id: orderId }, data: { amountPaid, amountDue } });
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreatePaymentInput {
  method: PaymentMethod;
  amount: number | string;
  tipAmount?: number | string | null;
  reference?: string | null;
  receivedAmount?: number | string | null;
}

// `amount` is always exactly what this payment contributes to amount_paid —
// never server-capped. For every method except cash, amount may not exceed
// amount_due (422 PAYMENT_EXCEEDS_DUE). Cash is the one exception ("overpayment
// allowed only for cash" — 2g-i.md section 2): a cash amount may legitimately
// exceed amount_due, and when received_amount is also given, change_amount =
// received_amount - amount. In the common case a waiter enters amount equal to
// what's actually owed and received_amount equal to what was physically
// handed over, so change_amount comes out correctly without amount itself
// ever exceeding amount_due at all — the "overpayment" carve-out only matters
// when amount itself is submitted above amount_due.
export async function createPayment(
  venueId: string,
  actorUserId: string,
  orderId: string,
  input: CreatePaymentInput,
): Promise<PaymentResult<Payment>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (order.status === 'closed' || order.status === 'cancelled' || order.status === 'merged') {
    return { ok: false, error: ORDER_NOT_MODIFIABLE(order.status) };
  }

  const amount = new Prisma.Decimal(input.amount);
  if (!amount.greaterThan(0)) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'amount must be greater than 0') };
  const tipAmount = input.tipAmount != null ? new Prisma.Decimal(input.tipAmount) : new Prisma.Decimal(0);
  if (tipAmount.lessThan(0)) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'tip_amount must not be negative') };

  const { venue, settings } = await getVenueAndSettings(venueId);
  const enabledMethods = Array.isArray(settings.paymentMethodsEnabled) ? (settings.paymentMethodsEnabled as string[]) : [];
  if (!enabledMethods.includes(input.method)) {
    return { ok: false, error: err(422, 'PAYMENT_METHOD_DISABLED', `Payment method '${input.method}' is not enabled for this venue`) };
  }

  const isCash = input.method === 'cash';
  let receivedAmount: Prisma.Decimal | null = null;
  let changeAmount: Prisma.Decimal | null = null;
  if (input.receivedAmount != null) {
    if (!isCash) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'received_amount is only applicable to cash payments') };
    receivedAmount = new Prisma.Decimal(input.receivedAmount);
    if (receivedAmount.lessThan(amount)) {
      return { ok: false, error: err(422, 'VALIDATION_ERROR', 'received_amount must be at least amount') };
    }
    changeAmount = receivedAmount.minus(amount);
  }

  if (!isCash && amount.greaterThan(order.amountDue)) {
    return { ok: false, error: err(422, 'PAYMENT_EXCEEDS_DUE', 'This payment exceeds the amount due') };
  }

  if (!settings.allowPartialPayment && amount.lessThan(order.amountDue)) {
    return { ok: false, error: err(422, 'PARTIAL_PAYMENT_NOT_ALLOWED', 'This venue requires a single payment to settle the full amount due') };
  }

  const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
  // order.business_date is never actually populated anywhere in this
  // codebase (a pre-existing gap, unrelated to this session — see
  // docs/phase2/SESSION-2f-i.md) and payments.business_date is NOT NULL, so
  // copying it straight from the order isn't viable. Computed independently
  // instead, the same way 2e's stock module already does for its own daily
  // resets (menu/stockService.ts's businessDateFor) — always resets by
  // calendar day in the venue's own timezone, unconditionally.
  const businessDate = businessDateFor(venue.timezone);

  const payment = await scopedPrisma.$transaction(async tx => {
    const created = await tx.payment.create({
      data: {
        venueId,
        orderId,
        shiftId: order.shiftId,
        businessDate,
        method: input.method,
        amount,
        tipAmount,
        receivedAmount,
        changeAmount,
        reference: input.reference ?? null,
        takenByUserId: actorUserId,
        takenByName: actor?.fullName ?? '',
      },
    });

    await recomputeOrderPayments(tx, venueId, orderId);

    await tx.orderEvent.create({
      data: {
        venueId,
        orderId,
        eventType: 'payment.taken',
        actorUserId,
        payload: {
          paymentId: created.id,
          method: created.method,
          amount: Number(amount),
          tipAmount: Number(tipAmount),
          changeAmount: changeAmount ? Number(changeAmount) : null,
        },
      },
    });

    return created;
  });

  return { ok: true, value: payment };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listPayments(venueId: string, orderId: string): Promise<PaymentResult<Payment[]>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const payments = await scopedPrisma.payment.findMany({ where: { orderId, venueId }, orderBy: { createdAt: 'asc' } });
  return { ok: true, value: payments };
}

// ── Void ─────────────────────────────────────────────────────────────────────

// Sets is_voided, records the reason and actor, and recomputes the order.
// Never deletes the row — payments is a cash-drawer log, not a mutable ledger.
export async function voidPayment(
  venueId: string,
  actorUserId: string,
  orderId: string,
  paymentId: string,
  reason: string,
): Promise<PaymentResult<Payment>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const payment = await scopedPrisma.payment.findFirst({ where: { id: paymentId, orderId, venueId } });
  if (!payment) return { ok: false, error: err(404, 'NOT_FOUND', 'Payment not found') };
  if (payment.isVoided) return { ok: false, error: err(409, 'PAYMENT_ALREADY_VOIDED', 'This payment has already been voided') };
  if (!reason) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'reason is required to void a payment') };

  const updated = await scopedPrisma.$transaction(async tx => {
    const voided = await tx.payment.update({
      where: { id: paymentId },
      data: { isVoided: true, voidedByUserId: actorUserId, voidedReason: reason },
    });

    await recomputeOrderPayments(tx, venueId, orderId);

    await tx.orderEvent.create({
      data: { venueId, orderId, eventType: 'payment.voided', actorUserId, payload: { paymentId, reason } },
    });

    return voided;
  });

  return { ok: true, value: updated };
}
