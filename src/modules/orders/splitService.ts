import { scopedPrisma } from '../../middleware/venueScope';
import { err, getVenueAndSettings, type OrderDomainError } from './validation';
import { allocateNumbers, formatTicketNumber } from './ticketNumbering';
import { recomputeOrder } from './ordersService';
import { Prisma, type Order } from '../../generated/prisma/client';

export type SplitResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

// Floors each child's share to the cent, then hands the leftover (always
// < 1 cent per child, so < ways cents total) to child 1 — the sum is exact
// by construction, never a rounding approximation. Working in integer cents
// throughout avoids any float/Decimal rounding-mode surprises.
function computeEqualShares(total: Prisma.Decimal, ways: number): Prisma.Decimal[] {
  const totalCents = total.times(100).toDecimalPlaces(0);
  const baseCents = totalCents.dividedToIntegerBy(ways);
  const remainderCents = totalCents.minus(baseCents.times(ways));

  const shares: Prisma.Decimal[] = [];
  for (let i = 0; i < ways; i++) {
    const cents = i === 0 ? baseCents.plus(remainderCents) : baseCents;
    shares.push(cents.dividedBy(100));
  }
  return shares;
}

// ── Split (equal) ────────────────────────────────────────────────────────────
//
// Items stay on the parent — its own subtotal/tax/service/grand_total are
// never touched by splitting. Each child gets exactly one synthetic line
// item representing its share; the child ORDER's own totals are assigned
// directly from that share rather than derived through recomputeOrder's
// usual tax-rate/service-charge formula, which would double-apply
// service_charge_percent on top of an amount that already includes it (the
// parent's grand_total is already fully taxed/service-charged before it's
// divided). See docs/phase2/SESSION-2f-i.md.
export async function splitEqual(venueId: string, actorUserId: string, orderId: string, ways: number): Promise<SplitResult<Order[]>> {
  const parent = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!parent) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (parent.status === 'closed' || parent.status === 'cancelled') {
    return { ok: false, error: err(409, 'ORDER_NOT_MODIFIABLE', `Cannot split an order with status '${parent.status}'`) };
  }

  const { venue, settings } = await getVenueAndSettings(venueId);
  if (!settings.splitBillEnabled || !settings.splitEqualEnabled) {
    return { ok: false, error: err(403, 'SPLIT_MODE_DISABLED', 'Equal split is not enabled for this venue') };
  }
  if (!Number.isInteger(ways) || ways < 2 || ways > settings.splitMaxWays) {
    return { ok: false, error: err(422, 'SPLIT_WAYS_INVALID', `ways must be an integer between 2 and ${settings.splitMaxWays}`) };
  }
  if (parent.amountPaid.greaterThan(0)) {
    return { ok: false, error: err(409, 'ORDER_ALREADY_PAID', 'This order has already been paid, at least partially, and cannot be split') };
  }

  const shares = computeEqualShares(parent.grandTotal, ways);
  const needsTicket = parent.serviceMode === 'counter';

  const children = await scopedPrisma.$transaction(async tx => {
    const created: Order[] = [];
    for (let i = 0; i < ways; i++) {
      const { orderNumber, ticketCounterValue } = await allocateNumbers(tx, venueId, venue.timezone, settings.ticketNumberReset, needsTicket);
      const ticketNumber = needsTicket ? formatTicketNumber(settings.ticketNumberPrefix, ticketCounterValue!) : null;
      const share = shares[i];

      const child = await tx.order.create({
        data: {
          venueId,
          orderNumber,
          serviceMode: parent.serviceMode,
          tableId: parent.tableId,
          ticketNumber,
          status: 'served', // a synthetic payment-line item, never needs kitchen/bar prep
          openedByUserId: actorUserId,
          parentOrderId: parent.id,
          splitType: 'equal',
          splitSequence: i + 1,
          shiftId: parent.shiftId,
          businessDate: parent.businessDate,
          subtotal: share,
          taxTotal: 0,
          serviceChargeTotal: 0,
          discountTotal: 0,
          grandTotal: share,
        },
      });

      await tx.orderItem.create({
        data: {
          orderId: child.id,
          venueId,
          menuItemId: null,
          itemNameSnapshot: `Split ${i + 1} of ${ways}`,
          categoryNameSnapshot: 'Split',
          unitPriceSnapshot: share,
          destinationSnapshot: 'none',
          taxRateSnapshot: 0,
          quantity: 1,
          modifiersTotal: 0,
          lineTotal: share,
          status: 'served',
          servedAt: new Date(),
          addedByUserId: actorUserId,
        },
      });

      created.push(child);
    }

    // One event on the parent for the whole split — not one per child. A
    // child-scoped order_event would block merge-back's hard delete later
    // (OrderEvent.orderId has no onDelete: Cascade, and order_events is
    // append-only, so deleting the event row first to unblock it is not an
    // option). Recording the split as a single state change on the parent,
    // with every child's id/share in the payload, satisfies "append an
    // event for every state change" without that problem.
    await tx.orderEvent.create({
      data: {
        venueId,
        orderId: parent.id,
        eventType: 'order.split',
        actorUserId,
        payload: {
          splitType: 'equal',
          ways,
          children: created.map((c, i) => ({ id: c.id, orderNumber: c.orderNumber, grandTotal: Number(shares[i]) })),
        },
      },
    });

    return created;
  });

  return { ok: true, value: children };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listSplits(venueId: string, orderId: string): Promise<SplitResult<Order[]>> {
  const parent = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!parent) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const children = await scopedPrisma.order.findMany({ where: { venueId, parentOrderId: orderId }, orderBy: { splitSequence: 'asc' } });
  return { ok: true, value: children };
}

// ── Merge back (undo) ───────────────────────────────────────────────────────

export async function mergeBackSplit(venueId: string, actorUserId: string, orderId: string, childId: string): Promise<SplitResult<null>> {
  const parent = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!parent) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const child = await scopedPrisma.order.findFirst({ where: { id: childId, venueId, parentOrderId: orderId } });
  if (!child) return { ok: false, error: err(404, 'NOT_FOUND', 'Split child order not found') };

  if (child.amountPaid.greaterThan(0)) {
    return { ok: false, error: err(409, 'ORDER_ALREADY_PAID', 'This split cannot be merged back once it has been paid') };
  }

  await scopedPrisma.$transaction(async tx => {
    // The synthetic order_item cascades with the order itself
    // (OrderItem.orderId is onDelete: Cascade) — no separate delete needed.
    await tx.order.delete({ where: { id: childId } });

    await tx.orderEvent.create({
      data: {
        venueId,
        orderId: parent.id,
        eventType: 'order.split_merged_back',
        actorUserId,
        payload: { childOrderId: childId, splitSequence: child.splitSequence, grandTotal: Number(child.grandTotal) },
      },
    });

    // Parent's own items/totals were never touched by the split, so this is
    // a no-op in practice — called because the session spec says merge-back
    // "recomputes the parent," and recomputeOrder is the one place that's
    // ever allowed to happen.
    await recomputeOrder(tx, venueId, parent.id);
  });

  return { ok: true, value: null };
}
