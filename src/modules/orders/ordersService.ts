import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { computeDisplayLabel } from '../tables/service';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { allocateNumbers, formatTicketNumber } from './ticketNumbering';
import { deriveOrderStatus, type ExplicitOrderFlag } from './statusMachine';
import {
  Prisma,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderItemModifier,
  type OrderStatus,
  type ServiceMode,
} from '../../generated/prisma/client';

export type OrderResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

// Narrowed to the specific partial unique index this check exists for
// (orders_active_table_key on orders(table_id) WHERE status IN active...).
// A bare `code === 'P2002'` would also match the unrelated
// orders_venue_id_order_number_key constraint and mislabel that as a table
// conflict — this is exactly the bug that made every create-order call fail
// with TABLE_ALREADY_HAS_ACTIVE_ORDER after the venue's first business day,
// before order_number allocation was fixed to never repeat (ticketNumbering.ts).
function isTableConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const cause = (e.meta as { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } } | undefined)
    ?.driverAdapterError?.cause;
  const fields = cause?.constraint?.fields;
  return Array.isArray(fields) && fields.length === 1 && fields[0] === 'table_id';
}

// ── Totals + status — server-side, Decimal-only math, recomputed and
// persisted on every mutation that can affect them. Shared by ordersService,
// orderItemsService, and lifecycleService so there is exactly one place
// either the totals formula or the status derivation lives — no scattered
// status assignments anywhere else in this module.
//
// explicitFlag/extraData let close/cancel fold their own lifecycle fields
// (closed_at, closed_by_user_id, ...) into this same update instead of
// issuing a second write.
export async function recomputeOrder(
  tx: Tx,
  venueId: string,
  orderId: string,
  options?: { explicitFlag?: ExplicitOrderFlag; extraData?: Prisma.OrderUncheckedUpdateInput },
): Promise<Order> {
  const items = await tx.orderItem.findMany({ where: { orderId, venueId } });
  const settings = await tx.restaurantSettings.findUnique({ where: { venueId } });
  if (!settings) throw new Error(`restaurant_settings missing for venue ${venueId}`);

  let subtotal = new Prisma.Decimal(0);
  let taxTotal = new Prisma.Decimal(0);
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    subtotal = subtotal.plus(item.lineTotal);
    taxTotal = taxTotal.plus(item.lineTotal.times(item.taxRateSnapshot).dividedBy(100));
  }
  const serviceChargeTotal = subtotal.times(settings.serviceChargePercent).dividedBy(100);
  const discountTotal = new Prisma.Decimal(0); // stays 0 in Phase 1
  const grandTotal = subtotal.plus(taxTotal).plus(serviceChargeTotal).minus(discountTotal);

  const status = deriveOrderStatus(items, options?.explicitFlag);

  return tx.order.update({
    where: { id: orderId },
    data: { subtotal, taxTotal, serviceChargeTotal, discountTotal, grandTotal, status, ...options?.extraData },
  });
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  serviceMode: ServiceMode;
  tableId?: string | null;
  guestCount?: number | null;
  customerName?: string | null;
  notes?: string | null;
}

export async function createOrder(
  venueId: string,
  actorUserId: string,
  input: CreateOrderInput,
): Promise<OrderResult<Order>> {
  if (input.serviceMode !== 'table' && input.serviceMode !== 'counter') {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', "service_mode must be 'table' or 'counter'") };
  }

  const { venue, settings } = await getVenueAndSettings(venueId);

  if (input.serviceMode === 'counter') {
    if (settings.requireTableForOrder) {
      return { ok: false, error: err(422, 'TABLE_REQUIRED_FOR_ORDER', 'This venue requires a table for every order') };
    }
    if (!settings.counterServiceEnabled) {
      return { ok: false, error: err(422, 'COUNTER_SERVICE_DISABLED', 'Counter service is not enabled for this venue') };
    }
    if (input.tableId) {
      return { ok: false, error: err(422, 'TABLE_ID_NOT_ALLOWED', 'table_id must be omitted for a counter-service order') };
    }
  } else {
    if (!input.tableId) {
      return { ok: false, error: err(422, 'TABLE_ID_REQUIRED', 'table_id is required for a table-service order') };
    }
    const table = await scopedPrisma.restaurantTable.findFirst({ where: { id: input.tableId, venueId, deletedAt: null } });
    if (!table) return { ok: false, error: err(404, 'NOT_FOUND', 'Table not found') };
    if (!table.isActive) return { ok: false, error: err(422, 'TABLE_INACTIVE', 'This table is inactive') };
  }

  const needsTicket = input.serviceMode === 'counter';

  try {
    const order = await scopedPrisma.$transaction(async tx => {
      const { orderNumber, ticketCounterValue } = await allocateNumbers(
        tx, venueId, venue.timezone, settings.ticketNumberReset, needsTicket,
      );
      const ticketNumber = needsTicket ? formatTicketNumber(settings.ticketNumberPrefix, ticketCounterValue!) : null;

      const created = await tx.order.create({
        data: {
          venueId,
          orderNumber,
          serviceMode: input.serviceMode,
          tableId: input.serviceMode === 'table' ? input.tableId : null,
          ticketNumber,
          guestCount: input.guestCount ?? null,
          customerName: input.customerName ?? null,
          notes: input.notes ?? null,
          status: 'draft',
          openedByUserId: actorUserId,
        },
      });

      if (input.serviceMode === 'table' && input.tableId) {
        await tx.restaurantTable.update({ where: { id: input.tableId }, data: { status: 'occupied' } });
      }

      await tx.orderEvent.create({
        data: {
          venueId,
          orderId: created.id,
          eventType: 'order.created',
          actorUserId,
          payload: { serviceMode: created.serviceMode, tableId: created.tableId, ticketNumber: created.ticketNumber },
        },
      });

      return created;
    });
    return { ok: true, value: order };
  } catch (e) {
    if (isTableConflict(e)) {
      return { ok: false, error: err(409, 'TABLE_ALREADY_HAS_ACTIVE_ORDER', 'This table already has an active order') };
    }
    throw e;
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface ListOrdersParams {
  status?: OrderStatus;
  tableId?: string;
  serviceMode?: ServiceMode;
  mine?: boolean;
  date?: string; // YYYY-MM-DD
  page?: number;
  perPage?: number;
}

export async function listOrders(venueId: string, actorUserId: string, params: ListOrdersParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));
  const where: Prisma.OrderWhereInput = { venueId };
  if (params.status) where.status = params.status;
  if (params.tableId) where.tableId = params.tableId;
  if (params.serviceMode) where.serviceMode = params.serviceMode;
  if (params.mine) where.openedByUserId = actorUserId;
  if (params.date) {
    const start = new Date(`${params.date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    where.openedAt = { gte: start, lt: end };
  }

  const [orders, total] = await Promise.all([
    scopedPrisma.order.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.order.count({ where }),
  ]);

  return { orders, page, perPage, total };
}

export interface OrderWithDetails extends Order {
  items: (OrderItem & { modifiers: OrderItemModifier[] })[];
  tableDisplayLabel: string | null;
  openedByName: string;
}

// Flat queries + in-memory joins throughout, not nested `include` — see
// menu/treeService.ts for why (relation shapes don't reliably survive the
// venueScope extension's $allOperations wrapper).
export async function getOrder(venueId: string, orderId: string): Promise<OrderWithDetails | null> {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return null;

  const [items, openedByUser, table, settings] = await Promise.all([
    scopedPrisma.orderItem.findMany({ where: { orderId, venueId }, orderBy: { createdAt: 'asc' } }),
    prisma.user.findUnique({ where: { id: order.openedByUserId } }),
    order.tableId ? scopedPrisma.restaurantTable.findFirst({ where: { id: order.tableId, venueId } }) : Promise.resolve(null),
    prisma.restaurantSettings.findUnique({ where: { venueId } }),
  ]);

  const itemIds = items.map(i => i.id);
  const modifiers = itemIds.length
    ? await prisma.orderItemModifier.findMany({ where: { orderItemId: { in: itemIds } } })
    : [];
  const modifiersByItem = new Map<string, OrderItemModifier[]>();
  for (const m of modifiers) {
    const list = modifiersByItem.get(m.orderItemId) ?? [];
    list.push(m);
    modifiersByItem.set(m.orderItemId, list);
  }

  return {
    ...order,
    items: items.map(item => ({ ...item, modifiers: modifiersByItem.get(item.id) ?? [] })),
    tableDisplayLabel: table && settings ? computeDisplayLabel(settings.tableNamingMode, table.tableNumber, table.tableName) : null,
    openedByName: openedByUser?.fullName ?? '',
  };
}

// ── Update ───────────────────────────────────────────────────────────────────

export interface UpdateOrderInput {
  guestCount?: number | null;
  customerName?: string | null;
  notes?: string | null;
}

export async function updateOrder(
  venueId: string,
  actorUserId: string,
  orderId: string,
  input: UpdateOrderInput,
): Promise<OrderResult<Order>> {
  const existing = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Order not found') };

  const data: Prisma.OrderUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (input.guestCount !== undefined) {
    data.guestCount = input.guestCount;
    before.guestCount = existing.guestCount;
    after.guestCount = input.guestCount;
  }
  if (input.customerName !== undefined) {
    data.customerName = input.customerName;
    before.customerName = existing.customerName;
    after.customerName = input.customerName;
  }
  if (input.notes !== undefined) {
    data.notes = input.notes;
    before.notes = existing.notes;
    after.notes = input.notes;
  }

  const updated = await scopedPrisma.order.update({ where: { id: orderId }, data });

  if (Object.keys(after).length > 0) {
    await prisma.orderEvent.create({
      data: { venueId, orderId, eventType: 'order.updated', actorUserId, payload: { before, after } as Prisma.InputJsonValue },
    });
  }

  return { ok: true, value: updated };
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface OrderEventWithActor extends OrderEvent {
  actorName: string | null;
}

export interface ListOrderEventsParams {
  page?: number;
  perPage?: number;
}

export async function listOrderEvents(venueId: string, orderId: string, params: ListOrderEventsParams) {
  const order = await scopedPrisma.order.findFirst({ where: { id: orderId, venueId } });
  if (!order) return null;

  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));

  const [events, total] = await Promise.all([
    prisma.orderEvent.findMany({
      where: { orderId, venueId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.orderEvent.count({ where: { orderId, venueId } }),
  ]);

  const actorIds = [...new Set(events.map(e => e.actorUserId).filter((id): id is string => !!id))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } } }) : [];
  const nameById = new Map(actors.map(a => [a.id, a.fullName]));

  const withActor: OrderEventWithActor[] = events.map(e => ({ ...e, actorName: e.actorUserId ? nameById.get(e.actorUserId) ?? null : null }));
  return { events: withActor, page, perPage, total };
}
