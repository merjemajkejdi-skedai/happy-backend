import { scopedPrisma } from '../../middleware/venueScope';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { allocateNumbers, formatTicketNumber } from './ticketNumbering';
import { recomputeOrder } from './ordersService';
import { Prisma, type Order, type OrderItem, type RestaurantSettings, type Venue } from '../../generated/prisma/client';

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

// ── Split by item / by seat ──────────────────────────────────────────────────
//
// Unlike equal split, items MOVE — the existing order_item row is updated
// in place (order_id changes; every snapshot, status, and timestamp is left
// untouched so a moved item's kitchen state survives exactly as it was).
// split_from_order_id always records the order the item most recently moved
// out of; original_order_item_id is set once, the first time an item ever
// moves, and never overwritten again — it stays the lineage root across any
// number of future moves (a later split of this same child would just carry
// the value forward via the `?? item.id` fallback below finding it already set).

export interface SplitAllocation {
  orderItemIds: string[];
  label?: string | null;
}

async function createChildOrderShell(
  tx: Tx,
  venue: Venue,
  settings: RestaurantSettings,
  parent: Order,
  actorUserId: string,
  splitType: 'by_item' | 'by_seat',
  sequence: number,
): Promise<Order> {
  const needsTicket = parent.serviceMode === 'counter';
  const { orderNumber, ticketCounterValue } = await allocateNumbers(tx, parent.venueId, venue.timezone, settings.ticketNumberReset, needsTicket);
  const ticketNumber = needsTicket ? formatTicketNumber(settings.ticketNumberPrefix, ticketCounterValue!) : null;

  return tx.order.create({
    data: {
      venueId: parent.venueId,
      orderNumber,
      serviceMode: parent.serviceMode,
      tableId: parent.tableId,
      ticketNumber,
      status: 'draft', // recomputed below the moment its items are attached
      openedByUserId: actorUserId,
      parentOrderId: parent.id,
      splitType,
      splitSequence: sequence,
      shiftId: parent.shiftId,
      businessDate: parent.businessDate,
    },
  });
}

async function checkAllocationSplitGate(venueId: string, orderId: string): Promise<SplitResult<{ parent: Order; venue: Venue; settings: RestaurantSettings }>> {
  const parent = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!parent) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (parent.status === 'closed' || parent.status === 'cancelled') {
    return { ok: false, error: err(409, 'ORDER_NOT_MODIFIABLE', `Cannot split an order with status '${parent.status}'`) };
  }

  const { venue, settings } = await getVenueAndSettings(venueId);
  // by_seat is "a convenience over by_item, not a separate flag" per
  // 2f-ii.md section 3 — both types share this one gate.
  if (!settings.splitBillEnabled || !settings.splitByItemEnabled) {
    return { ok: false, error: err(403, 'SPLIT_MODE_DISABLED', 'Item/seat split is not enabled for this venue') };
  }
  if (parent.amountPaid.greaterThan(0)) {
    return { ok: false, error: err(409, 'ORDER_ALREADY_PAID', 'This order has already been paid, at least partially, and cannot be split') };
  }
  return { ok: true, value: { parent, venue, settings } };
}

async function moveItemsIntoChildren(
  venueId: string,
  actorUserId: string,
  parent: Order,
  venue: Venue,
  settings: RestaurantSettings,
  splitType: 'by_item' | 'by_seat',
  allocations: SplitAllocation[],
  itemById: Map<string, OrderItem>,
): Promise<Order[]> {
  return scopedPrisma.$transaction(async tx => {
    const created: Order[] = [];
    const moves: { childId: string; itemIds: string[]; label?: string | null }[] = [];

    for (let i = 0; i < allocations.length; i++) {
      const child = await createChildOrderShell(tx, venue, settings, parent, actorUserId, splitType, i + 1);
      moves.push({ childId: child.id, itemIds: allocations[i].orderItemIds, label: allocations[i].label ?? null });

      for (const itemId of allocations[i].orderItemIds) {
        const item = itemById.get(itemId)!;
        await tx.orderItem.update({
          where: { id: itemId },
          data: { orderId: child.id, splitFromOrderId: parent.id, originalOrderItemId: item.originalOrderItemId ?? item.id },
        });
      }

      // Recomputes the child's own totals from the items it now holds
      // (their real tax_rate_snapshot, unlike equal split) and lazily
      // creates whatever order_courses rows those items' course_number
      // values need. Push the RECOMPUTED row, not the pre-recompute shell —
      // the shell's totals are all still zero at creation time.
      const recomputedChild = await recomputeOrder(tx, venueId, child.id);
      created.push(recomputedChild);
    }

    // Recomputes the parent from whatever items it has left — essential,
    // not optional: skipping this would leave the parent's totals stale and
    // silently double-count the tax/subtotal of every item that just moved.
    await recomputeOrder(tx, venueId, parent.id);

    // "drop empty course rows on the parent only if they were auto-created"
    // (2f-ii.md section 5). Every order_courses row in this codebase is
    // lazily auto-created by recomputeOrder's own course roll-up the moment
    // an item first carries that course_number — there is no other creation
    // path — so a row that's both empty (item_count 0, per the recompute
    // just above) and never fired is pure bookkeeping with no history worth
    // keeping. A row that WAS fired stays, even if now empty, since it
    // represents real kitchen activity.
    await tx.orderCourse.deleteMany({ where: { venueId, orderId: parent.id, itemCount: 0, firedAt: null } });

    await tx.orderEvent.create({
      data: { venueId, orderId: parent.id, eventType: 'order.split', actorUserId, payload: { splitType, allocations: moves } },
    });

    return created;
  });
}

export async function splitByItem(venueId: string, actorUserId: string, orderId: string, allocations: SplitAllocation[]): Promise<SplitResult<Order[]>> {
  const gate = await checkAllocationSplitGate(venueId, orderId);
  if (!gate.ok) return gate;
  const { parent, venue, settings } = gate.value;

  if (allocations.length === 0 || allocations.length > settings.splitMaxWays) {
    return { ok: false, error: err(422, 'SPLIT_WAYS_INVALID', `Number of allocations must be between 1 and ${settings.splitMaxWays}`) };
  }
  for (const a of allocations) {
    if (!Array.isArray(a.orderItemIds) || a.orderItemIds.length === 0) {
      return { ok: false, error: err(422, 'VALIDATION_ERROR', 'Each allocation must list at least one order_item_id') };
    }
  }

  const allItemIds = allocations.flatMap(a => a.orderItemIds);
  const uniqueItemIds = new Set(allItemIds);
  if (uniqueItemIds.size !== allItemIds.length) {
    return { ok: false, error: err(422, 'SPLIT_ITEM_DOUBLE_ALLOCATED', 'An item cannot appear in more than one allocation') };
  }

  const items = await scopedPrisma.orderItem.findMany({ where: { id: { in: [...uniqueItemIds] }, orderId, venueId } });
  const itemById = new Map(items.map(i => [i.id, i]));
  for (const id of uniqueItemIds) {
    if (!itemById.has(id)) return { ok: false, error: err(422, 'SPLIT_ITEM_NOT_IN_ORDER', `Item ${id} does not belong to this order`) };
  }
  for (const item of items) {
    if (item.status === 'cancelled') {
      return { ok: false, error: err(422, 'SPLIT_ITEM_CANCELLED', `Item ${item.id} has been cancelled and cannot be allocated`) };
    }
  }

  const children = await moveItemsIntoChildren(venueId, actorUserId, parent, venue, settings, 'by_item', allocations, itemById);
  return { ok: true, value: children };
}

// Items with no seat assigned stay on the parent — grouping only ever
// considers active (non-cancelled) items, so a cancelled item never drags a
// seat's other items into a move, and never gets moved itself. Zero distinct
// seats among the order's active items is a no-op success (nothing to
// split), matching this codebase's established idempotent-no-op convention
// for "nothing to do" (e.g. re-firing an already-fired course).
export async function splitBySeat(venueId: string, actorUserId: string, orderId: string): Promise<SplitResult<Order[]>> {
  const gate = await checkAllocationSplitGate(venueId, orderId);
  if (!gate.ok) return gate;
  const { parent, venue, settings } = gate.value;

  const items = await scopedPrisma.orderItem.findMany({
    where: { orderId, venueId, status: { not: 'cancelled' }, seatNumber: { not: null } },
  });
  const bySeat = new Map<number, string[]>();
  for (const item of items) {
    const seat = item.seatNumber!;
    const list = bySeat.get(seat) ?? [];
    list.push(item.id);
    bySeat.set(seat, list);
  }
  const seats = [...bySeat.keys()].sort((a, b) => a - b);
  if (seats.length === 0) return { ok: true, value: [] };
  if (seats.length > settings.splitMaxWays) {
    return { ok: false, error: err(422, 'SPLIT_WAYS_INVALID', `Number of distinct seats (${seats.length}) exceeds split_max_ways (${settings.splitMaxWays})`) };
  }

  const allocations: SplitAllocation[] = seats.map(seat => ({ orderItemIds: bySeat.get(seat)!, label: `Seat ${seat}` }));
  const itemById = new Map(items.map(i => [i.id, i]));
  const children = await moveItemsIntoChildren(venueId, actorUserId, parent, venue, settings, 'by_seat', allocations, itemById);
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
