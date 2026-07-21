import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { computeDisplayLabel } from '../tables/service';
import { err, type OrderDomainError } from '../orders/validation';
import { recomputeOrder } from '../orders/ordersService';
import { buildTicket, buildMeta, type DisplayTicketDTO, type DisplayMetaDTO } from './serializers';
import { Prisma, type OrderItem, type OrderItemModifier, type OrderItemStatus, type Destination } from '../../generated/prisma/client';

export type DisplayResult<T> = { ok: true; value: T } | { ok: false; error: OrderDomainError };

const RECALL_WINDOW_MINUTES = 30;

async function getSettings(venueId: string) {
  const settings = await prisma.restaurantSettings.findUnique({ where: { venueId } });
  if (!settings) throw new Error(`restaurant_settings missing for venue ${venueId}`);
  return settings;
}

// Shared by kitchen/bar/recall — the only difference between them is the
// order_item WHERE filter. Flat queries + in-memory joins throughout, not
// nested `include` (see menu/treeService.ts for why).
async function buildTickets(venueId: string, itemWhere: Prisma.OrderItemWhereInput, now: Date): Promise<DisplayTicketDTO[]> {
  const items = await scopedPrisma.orderItem.findMany({ where: { venueId, ...itemWhere } });
  if (items.length === 0) return [];

  const orderIds = [...new Set(items.map(i => i.orderId))];
  const orders = await scopedPrisma.order.findMany({ where: { id: { in: orderIds }, venueId } });
  const ordersById = new Map(orders.map(o => [o.id, o]));

  const itemIds = items.map(i => i.id);
  const modifiers = await prisma.orderItemModifier.findMany({ where: { orderItemId: { in: itemIds } } });
  const modifiersByItem = new Map<string, OrderItemModifier[]>();
  for (const m of modifiers) {
    const list = modifiersByItem.get(m.orderItemId) ?? [];
    list.push(m);
    modifiersByItem.set(m.orderItemId, list);
  }

  const userIds = [...new Set(orders.map(o => o.openedByUserId))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } } }) : [];
  const nameById = new Map(users.map(u => [u.id, u.fullName]));

  const tableIds = [...new Set(orders.map(o => o.tableId).filter((x): x is string => !!x))];
  const tables = tableIds.length ? await scopedPrisma.restaurantTable.findMany({ where: { id: { in: tableIds }, venueId } }) : [];
  const tableById = new Map(tables.map(t => [t.id, t]));

  const settings = await getSettings(venueId);

  const itemsByOrder = new Map<string, (OrderItem & { modifiers: OrderItemModifier[] })[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item.orderId) ?? [];
    list.push({ ...item, modifiers: modifiersByItem.get(item.id) ?? [] });
    itemsByOrder.set(item.orderId, list);
  }

  const tickets = orderIds
    .map(orderId => {
      const order = ordersById.get(orderId);
      if (!order) return null;
      const table = order.tableId ? tableById.get(order.tableId) : null;
      const tableDisplayLabel = table ? computeDisplayLabel(settings.tableNamingMode, table.tableNumber, table.tableName) : null;
      return buildTicket(
        order,
        itemsByOrder.get(orderId) ?? [],
        nameById.get(order.openedByUserId) ?? '',
        tableDisplayLabel,
        settings.displayWarnAfterMinutes,
        now,
      );
    })
    .filter((t): t is DisplayTicketDTO => !!t)
    .sort((a, b) => (a.first_sent_at ?? '').localeCompare(b.first_sent_at ?? ''));

  return tickets;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface GetDisplayParams {
  courseNumber?: number;
  includeReady?: boolean;
}

export async function getDisplay(
  venueId: string,
  destination: Extract<Destination, 'kitchen' | 'bar'>,
  params: GetDisplayParams,
): Promise<DisplayResult<{ tickets: DisplayTicketDTO[]; meta: DisplayMetaDTO }>> {
  const settings = await getSettings(venueId);
  const enabled = destination === 'kitchen' ? settings.kitchenDisplayEnabled : settings.barDisplayEnabled;
  if (!enabled) return { ok: false, error: err(403, 'DISPLAY_DISABLED', `The ${destination} display is not enabled for this venue`) };

  const statuses: OrderItemStatus[] = params.includeReady ? ['sent', 'preparing', 'ready'] : ['sent', 'preparing'];
  const where: Prisma.OrderItemWhereInput = { destinationSnapshot: destination, status: { in: statuses } };
  if (params.courseNumber != null) where.courseNumberSnapshot = params.courseNumber;

  const now = new Date();
  const tickets = await buildTickets(venueId, where, now);
  return { ok: true, value: { tickets, meta: buildMeta(settings.displayAutoRefreshSeconds, tickets, now) } };
}

export async function getRecallDisplay(venueId: string): Promise<{ tickets: DisplayTicketDTO[]; meta: DisplayMetaDTO }> {
  const settings = await getSettings(venueId);
  const now = new Date();
  const windowStart = new Date(now.getTime() - RECALL_WINDOW_MINUTES * 60 * 1000);
  const where: Prisma.OrderItemWhereInput = { status: 'ready', readyAt: { gte: windowStart } };

  const tickets = await buildTickets(venueId, where, now);
  return { tickets, meta: buildMeta(settings.displayAutoRefreshSeconds, tickets, now) };
}

// ── Single-item status change ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, ('preparing' | 'ready')[]> = {
  sent: ['preparing', 'ready'],
  preparing: ['ready'],
};

export async function updateItemStatus(
  venueId: string,
  actorUserId: string,
  itemId: string,
  targetStatus: string,
): Promise<DisplayResult<null>> {
  if (targetStatus !== 'preparing' && targetStatus !== 'ready') {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', "status must be 'preparing' or 'ready'") };
  }

  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };

  const allowed = VALID_TRANSITIONS[item.status] ?? [];
  if (!allowed.includes(targetStatus)) {
    return { ok: false, error: err(409, 'INVALID_STATUS_TRANSITION', `Cannot move an item from '${item.status}' to '${targetStatus}'`) };
  }

  await scopedPrisma.$transaction(async tx => {
    const now = new Date();
    const data: Prisma.OrderItemUncheckedUpdateInput = { status: targetStatus };
    if (targetStatus === 'preparing') data.preparingAt = now;
    if (targetStatus === 'ready') data.readyAt = now;

    await tx.orderItem.update({ where: { id: itemId }, data });
    await tx.orderEvent.create({
      data: { venueId, orderId: item.orderId, orderItemId: itemId, eventType: 'item.status_changed', actorUserId, payload: { from: item.status, to: targetStatus } },
    });
    await recomputeOrder(tx, venueId, item.orderId);
  });

  return { ok: true, value: null };
}

// ── Bulk bump ────────────────────────────────────────────────────────────────

export interface BumpInput {
  orderItemIds?: string[];
  orderId?: string;
  status?: string;
}

export async function bumpItems(venueId: string, actorUserId: string, input: BumpInput): Promise<DisplayResult<{ bumped: number }>> {
  const targetStatus = input.status ?? 'ready';
  if (targetStatus !== 'ready') return { ok: false, error: err(422, 'VALIDATION_ERROR', "status must be 'ready'") };

  let itemIds: string[];
  if (input.orderItemIds && input.orderItemIds.length > 0) {
    // Explicit item list: strict, all-or-nothing — every id must currently
    // be eligible or the whole batch fails (per spec: "partial failure
    // fails the whole batch").
    const found = await scopedPrisma.orderItem.findMany({ where: { id: { in: input.orderItemIds }, venueId } });
    if (found.length !== input.orderItemIds.length) return { ok: false, error: err(404, 'NOT_FOUND', 'One or more order items not found') };
    const invalid = found.find(i => i.status !== 'sent' && i.status !== 'preparing');
    if (invalid) {
      return {
        ok: false,
        error: err(409, 'INVALID_STATUS_TRANSITION', `Item ${invalid.id} has status '${invalid.status}' and cannot be bumped to 'ready'`),
      };
    }
    itemIds = input.orderItemIds;
  } else if (input.orderId) {
    // Whole-ticket bump: auto-resolve to whatever's currently eligible —
    // items already ready/served/pending/cancelled just aren't targeted.
    const eligible = await scopedPrisma.orderItem.findMany({ where: { orderId: input.orderId, venueId, status: { in: ['sent', 'preparing'] } } });
    if (eligible.length === 0) return { ok: false, error: err(422, 'NO_ITEMS_TO_BUMP', 'There are no sent/preparing items to bump') };
    itemIds = eligible.map(i => i.id);
  } else {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'order_item_ids or order_id is required') };
  }

  const items = await scopedPrisma.orderItem.findMany({ where: { id: { in: itemIds }, venueId } });
  const orderIds = [...new Set(items.map(i => i.orderId))];

  await scopedPrisma.$transaction(async tx => {
    const now = new Date();
    for (const item of items) {
      await tx.orderItem.update({ where: { id: item.id }, data: { status: 'ready', readyAt: now } });
      await tx.orderEvent.create({
        data: { venueId, orderId: item.orderId, orderItemId: item.id, eventType: 'item.status_changed', actorUserId, payload: { from: item.status, to: 'ready' } },
      });
    }
    for (const orderId of orderIds) {
      await recomputeOrder(tx, venueId, orderId);
    }
  });

  return { ok: true, value: { bumped: itemIds.length } };
}

// ── Recall (single item) ────────────────────────────────────────────────────

export async function recallItem(venueId: string, actorUserId: string, itemId: string): Promise<DisplayResult<null>> {
  const item = await scopedPrisma.orderItem.findFirst({ where: { id: itemId, venueId } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Order item not found') };
  if (item.status !== 'ready') {
    return { ok: false, error: err(409, 'INVALID_STATUS_TRANSITION', `Cannot recall an item with status '${item.status}'`) };
  }

  await scopedPrisma.$transaction(async tx => {
    await tx.orderItem.update({ where: { id: itemId }, data: { status: 'preparing', readyAt: null } });
    await tx.orderEvent.create({
      data: { venueId, orderId: item.orderId, orderItemId: itemId, eventType: 'item.status_changed', actorUserId, payload: { from: 'ready', to: 'preparing' } },
    });
    await recomputeOrder(tx, venueId, item.orderId);
  });

  return { ok: true, value: null };
}
