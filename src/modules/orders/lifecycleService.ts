import { scopedPrisma } from '../../middleware/venueScope';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { recomputeOrder } from './ordersService';
import { courseNameFromSettings } from './statusMachine';
import { hasPendingVoid } from './voidService';
import { roleHasPermission } from '../../shared/permissions';
import { Prisma, type Order, type OrderItem, type UserRole } from '../../generated/prisma/client';

export type LifecycleResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

function isConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

const ORDER_NOT_MODIFIABLE = (status: string) => err(409, 'ORDER_NOT_MODIFIABLE', `Cannot modify an order with status '${status}'`);

// ── Send ─────────────────────────────────────────────────────────────────────

export interface DestinationSummary {
  count: number;
  items: { id: string; name: string }[];
}
export interface SendSummary {
  kitchen: DestinationSummary;
  bar: DestinationSummary;
}

function buildSendSummary(items: OrderItem[]): SendSummary {
  const kitchen = items.filter(i => i.destinationSnapshot === 'kitchen');
  const bar = items.filter(i => i.destinationSnapshot === 'bar');
  return {
    kitchen: { count: kitchen.length, items: kitchen.map(i => ({ id: i.id, name: i.itemNameSnapshot })) },
    bar: { count: bar.length, items: bar.map(i => ({ id: i.id, name: i.itemNameSnapshot })) },
  };
}

// Transaction-internal core: marks the given (already-validated, already
// venue/order-scoped) pending items sent — or, for destination 'none' items
// that need no preparation, straight to served — and recomputes the order.
// Shared by the POST /:id/send route AND addItem's auto_send_on_add path, so
// there is exactly one place that logic lives (per the orders-core
// TODO left for this prompt).
export async function sendItemsCore(tx: Tx, venueId: string, orderId: string, actorUserId: string, itemIds: string[]): Promise<OrderItem[]> {
  const now = new Date();
  const sent: OrderItem[] = [];
  for (const id of itemIds) {
    const current = await tx.orderItem.findUniqueOrThrow({ where: { id } });
    const toStatus = current.destinationSnapshot === 'none' ? 'served' : 'sent';
    const data: Prisma.OrderItemUpdateInput = { status: toStatus };
    if (toStatus === 'sent') data.sentAt = now;
    if (toStatus === 'served') data.servedAt = now;
    const updated = await tx.orderItem.update({ where: { id }, data });
    sent.push(updated);

    await tx.orderEvent.create({
      data: { venueId, orderId, orderItemId: id, eventType: 'item.status_changed', actorUserId, payload: { from: current.status, to: toStatus } },
    });
  }

  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const extraData: Prisma.OrderUpdateInput = order.firstSentAt ? {} : { firstSentAt: now };
  await recomputeOrder(tx, venueId, orderId, { extraData });

  return sent;
}

export interface SendItemsInput {
  courseNumber?: number;
  itemIds?: string[];
}

export async function sendItems(
  venueId: string,
  actorUserId: string,
  orderId: string,
  input: SendItemsInput,
): Promise<LifecycleResult<SendSummary>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const { venue, settings } = await getVenueAndSettings(venueId);

  // Phase 2, session 2c: a plain "send everything" call (no explicit
  // course_number/item_ids) on a venue's very first send auto-fires course 1
  // instead, when auto_fire_first_course is on. Implemented inline here
  // (mirroring coursesService.fireCourse's course-1 case) rather than
  // importing coursesService, to avoid a lifecycleService <-> coursesService
  // circular import (coursesService already depends on sendItemsCore below).
  const isPlainSend = input.courseNumber == null && !input.itemIds;
  const shouldAutoFireCourse1 =
    isPlainSend && !order.firstSentAt && settings.sendByCourse && settings.autoFireFirstCourse && venue.venueType !== 'happy_bar';

  const pendingItems = await scopedPrisma.orderItem.findMany({ where: { orderId, venueId, status: 'pending' } });
  let eligible = pendingItems;
  if (shouldAutoFireCourse1) {
    eligible = eligible.filter(i => i.courseNumber === 1);
  } else if (input.courseNumber != null && settings.coursesEnabled) {
    eligible = eligible.filter(i => i.courseNumberSnapshot === input.courseNumber);
  } else if (input.itemIds) {
    const idSet = new Set(input.itemIds);
    eligible = eligible.filter(i => idSet.has(i.id));
  }
  // An auto-fired empty course 1 is a no-op success, not an error — same
  // convention as explicitly firing an empty course via the courses routes.
  if (eligible.length === 0 && !shouldAutoFireCourse1) {
    return { ok: false, error: err(422, 'NO_PENDING_ITEMS', 'There are no pending items to send') };
  }

  const summary = await scopedPrisma.$transaction(async tx => {
    const sentItems = await sendItemsCore(tx, venueId, orderId, actorUserId, eligible.map(i => i.id));
    const result = buildSendSummary(sentItems);
    await tx.orderEvent.create({
      data: { venueId, orderId, eventType: 'order.sent', actorUserId, payload: result as unknown as Prisma.InputJsonValue },
    });

    if (shouldAutoFireCourse1) {
      const now = new Date();
      if (eligible.length > 0) {
        await tx.orderItem.updateMany({ where: { id: { in: eligible.map(i => i.id) }, venueId }, data: { courseFiredAt: now } });
      }
      const course =
        (await tx.orderCourse.findUnique({ where: { orderId_courseNumber: { orderId, courseNumber: 1 } } })) ??
        (await tx.orderCourse.create({
          data: { venueId, orderId, courseNumber: 1, courseNameSnapshot: courseNameFromSettings(settings.courseNames, 1) },
        }));
      await tx.orderCourse.update({ where: { id: course.id }, data: { status: 'fired', firedAt: now, firedByUserId: actorUserId } });

      const currentOrder = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      await tx.order.update({ where: { id: orderId }, data: { currentCourseFired: Math.max(currentOrder.currentCourseFired ?? 0, 1) } });

      await tx.orderEvent.create({
        data: { venueId, orderId, eventType: 'course.fired', actorUserId, payload: { courseNumber: 1, itemIds: eligible.map(i => i.id), auto: true } },
      });
    }

    return result;
  });
  return { ok: true, value: summary };
}

// ── Transfer ─────────────────────────────────────────────────────────────────

export async function transferOrder(venueId: string, actorUserId: string, orderId: string, newTableId: string): Promise<LifecycleResult<Order>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (order.status === 'closed' || order.status === 'cancelled') return { ok: false, error: ORDER_NOT_MODIFIABLE(order.status) };

  const { settings } = await getVenueAndSettings(venueId);
  if (!settings.allowTableTransfer) return { ok: false, error: err(403, 'TRANSFER_DISABLED', 'Table transfer is not allowed for this venue') };

  const targetTable = await scopedPrisma.restaurantTable.findFirst({ where: { id: newTableId, venueId, deletedAt: null } });
  if (!targetTable) return { ok: false, error: err(404, 'NOT_FOUND', 'Table not found') };
  if (!targetTable.isActive) return { ok: false, error: err(422, 'TABLE_INACTIVE', 'This table is inactive') };

  const oldTableId = order.tableId;

  try {
    const updated = await scopedPrisma.$transaction(async tx => {
      const result = await tx.order.update({
        where: { id: orderId },
        data: { tableId: newTableId, serviceMode: 'table' },
      });

      if (oldTableId) {
        await tx.restaurantTable.update({ where: { id: oldTableId }, data: { status: 'dirty' } });
      }
      await tx.restaurantTable.update({ where: { id: newTableId }, data: { status: 'occupied' } });

      await tx.orderEvent.create({
        data: {
          venueId, orderId, eventType: 'order.transferred', actorUserId,
          payload: { fromTableId: oldTableId, toTableId: newTableId, fromServiceMode: order.serviceMode },
        },
      });

      return result;
    });
    return { ok: true, value: updated };
  } catch (e) {
    if (isConflict(e)) return { ok: false, error: err(409, 'TABLE_ALREADY_HAS_ACTIVE_ORDER', 'This table already has an active order') };
    throw e;
  }
}

// ── Serve ────────────────────────────────────────────────────────────────────

async function serveItemsCore(tx: Tx, venueId: string, orderId: string, actorUserId: string, itemIds: string[]): Promise<void> {
  const now = new Date();
  for (const id of itemIds) {
    await tx.orderItem.update({ where: { id }, data: { status: 'served', servedAt: now } });
    await tx.orderEvent.create({
      data: { venueId, orderId, orderItemId: id, eventType: 'item.status_changed', actorUserId, payload: { from: 'ready', to: 'served' } },
    });
  }
  await recomputeOrder(tx, venueId, orderId);
}

export async function serveItem(venueId: string, actorUserId: string, orderId: string, itemId: string): Promise<LifecycleResult<null>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, orderId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };
  if (item.status !== 'ready') {
    return { ok: false, error: err(409, 'INVALID_STATUS_TRANSITION', `Cannot mark an item with status '${item.status}' as served`) };
  }

  await scopedPrisma.$transaction(tx => serveItemsCore(tx, venueId, orderId, actorUserId, [itemId]));
  return { ok: true, value: null };
}

export async function serveItems(venueId: string, actorUserId: string, orderId: string, itemIds?: string[]): Promise<LifecycleResult<{ served: number }>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const readyItems = await scopedPrisma.orderItem.findMany({ where: { orderId, venueId, status: 'ready' } });
  let eligible = readyItems;
  if (itemIds) {
    const idSet = new Set(itemIds);
    eligible = eligible.filter(i => idSet.has(i.id));
  }
  if (eligible.length === 0) return { ok: false, error: err(422, 'NO_READY_ITEMS', 'There are no ready items to serve') };

  await scopedPrisma.$transaction(tx => serveItemsCore(tx, venueId, orderId, actorUserId, eligible.map(i => i.id)));
  return { ok: true, value: { served: eligible.length } };
}

// ── Close ────────────────────────────────────────────────────────────────────

export async function closeOrder(venueId: string, actorUserId: string, orderId: string): Promise<LifecycleResult<Order>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (order.status === 'closed' || order.status === 'cancelled') {
    return { ok: false, error: err(409, 'INVALID_STATUS_TRANSITION', `Cannot close an order with status '${order.status}'`) };
  }

  if (await hasPendingVoid(venueId, orderId)) {
    return { ok: false, error: err(409, 'ORDER_HAS_PENDING_VOID', 'This order has a void request awaiting approval and cannot be closed yet') };
  }

  const items = await scopedPrisma.orderItem.findMany({ where: { orderId, venueId, status: { not: 'cancelled' } } });
  if (items.some(i => i.status !== 'served')) {
    return { ok: false, error: err(409, 'ORDER_HAS_UNSERVED_ITEMS', 'All non-cancelled items must be served before closing this order') };
  }

  // Phase 2, session 2g-i. Checked last, after the pending-void and
  // unserved-items gates, so a caller failing more than one guard always
  // sees the same blocking condition first — deterministic per 2g-i.md
  // section 3's explicit requirement. amount_due is read straight off the
  // already-fetched order row rather than recomputed here: every payment
  // mutation (paymentsService.ts) keeps it current as a side effect, so
  // there's nothing stale to refresh at close time.
  const { settings } = await getVenueAndSettings(venueId);
  if (settings.requirePaymentToClose && order.amountDue.greaterThan(0)) {
    return { ok: false, error: err(409, 'ORDER_NOT_SETTLED', 'This order must be fully paid before it can be closed') };
  }

  const updated = await scopedPrisma.$transaction(async tx => {
    const result = await recomputeOrder(tx, venueId, orderId, {
      explicitFlag: 'closed',
      extraData: { closedAt: new Date(), closedByUserId: actorUserId },
    });

    if (order.tableId) {
      await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'dirty' } });
    }

    await tx.orderEvent.create({ data: { venueId, orderId, eventType: 'order.closed', actorUserId, payload: {} } });

    return result;
  });

  return { ok: true, value: updated };
}

// ── Cancel ───────────────────────────────────────────────────────────────────

export async function cancelOrder(
  venueId: string,
  actorUserId: string,
  actorRole: UserRole,
  orderId: string,
  reason: string | undefined,
): Promise<LifecycleResult<Order>> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };
  if (order.status === 'closed' || order.status === 'cancelled') {
    return { ok: false, error: err(409, 'INVALID_STATUS_TRANSITION', `Cannot cancel an order with status '${order.status}'`) };
  }
  if (!reason?.trim()) return { ok: false, error: err(422, 'CANCEL_REASON_REQUIRED', 'A reason is required to cancel this order') };

  if (order.firstSentAt && !roleHasPermission(actorRole, 'order.cancel_sent')) {
    return { ok: false, error: err(403, 'CANCEL_AFTER_SEND_NOT_ALLOWED', 'Cancelling an order after anything has been sent is not allowed') };
  }

  const updated = await scopedPrisma.$transaction(async tx => {
    const now = new Date();
    const activeItems = await tx.orderItem.findMany({ where: { orderId, venueId, status: { not: 'cancelled' } } });
    for (const item of activeItems) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { status: 'cancelled', cancelledAt: now, cancelReason: reason, voidByUserId: actorUserId },
      });
    }

    const result = await recomputeOrder(tx, venueId, orderId, {
      explicitFlag: 'cancelled',
      extraData: { cancelledAt: now, cancelReason: reason },
    });

    if (order.tableId) {
      await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'dirty' } });
    }

    await tx.orderEvent.create({
      data: { venueId, orderId, eventType: 'order.cancelled', actorUserId, payload: { reason, cancelledItemIds: activeItems.map(i => i.id) } },
    });

    return result;
  });

  return { ok: true, value: updated };
}
