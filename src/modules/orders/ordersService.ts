import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { computeDisplayLabel } from '../tables/service';
import { err, getVenueAndSettings, type OrderDomainError, type Tx } from './validation';
import { allocateNumbers, formatTicketNumber } from './ticketNumbering';
import {
  Prisma,
  type Order,
  type OrderItem,
  type OrderItemModifier,
  type OrderStatus,
  type ServiceMode,
} from '../../generated/prisma/client';

export type OrderResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

function isConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

// ── Totals — server-side, Decimal-only math, recomputed and persisted on
// every mutation that can affect them. Shared by ordersService and
// orderItemsService so there is exactly one place this formula lives.
export async function recomputeOrderTotals(tx: Tx, venueId: string, orderId: string): Promise<Order> {
  const items = await tx.orderItem.findMany({ where: { orderId, venueId, status: { not: 'cancelled' } } });
  const settings = await tx.restaurantSettings.findUnique({ where: { venueId } });
  if (!settings) throw new Error(`restaurant_settings missing for venue ${venueId}`);

  let subtotal = new Prisma.Decimal(0);
  let taxTotal = new Prisma.Decimal(0);
  for (const item of items) {
    subtotal = subtotal.plus(item.lineTotal);
    taxTotal = taxTotal.plus(item.lineTotal.times(item.taxRateSnapshot).dividedBy(100));
  }
  const serviceChargeTotal = subtotal.times(settings.serviceChargePercent).dividedBy(100);
  const discountTotal = new Prisma.Decimal(0); // stays 0 in Phase 1
  const grandTotal = subtotal.plus(taxTotal).plus(serviceChargeTotal).minus(discountTotal);

  return tx.order.update({
    where: { id: orderId },
    data: { subtotal, taxTotal, serviceChargeTotal, discountTotal, grandTotal },
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
  idempotencyKey?: string,
): Promise<OrderResult<Order>> {
  if (idempotencyKey) {
    const existing = await scopedPrisma.order.findFirst({ where: { venueId, idempotencyKey } });
    if (existing) return { ok: true, value: existing };
  }

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
          idempotencyKey: idempotencyKey ?? null,
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
    if (isConflict(e)) {
      // Two distinct unique constraints could have fired here: the
      // idempotency-key replay race, or the one-active-order-per-table
      // guarantee. Re-check the idempotency case first (a legitimate
      // successful replay, not an error) before falling back to the table
      // conflict this route explicitly promises to report.
      if (idempotencyKey) {
        const existing = await scopedPrisma.order.findFirst({ where: { venueId, idempotencyKey } });
        if (existing) return { ok: true, value: existing };
      }
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
  limit?: number;
}

export async function listOrders(venueId: string, actorUserId: string, params: ListOrdersParams) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
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
    scopedPrisma.order.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    scopedPrisma.order.count({ where }),
  ]);

  return { orders, page, limit, total };
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
