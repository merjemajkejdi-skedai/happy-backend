import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { computeDisplayLabel } from '../tables/service';
import { err, type OrderDomainError } from '../orders/validation';
import { recomputeOrder } from '../orders/ordersService';
import { checkCoursesAvailable } from '../orders/coursesService';
import { buildTicket, buildMeta, buildFireAlert, buildVoidAlert, type DisplayTicketDTO, type DisplayMetaDTO, type FireAlertDTO, type VoidAlertDTO } from './serializers';
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
): Promise<DisplayResult<{ tickets: DisplayTicketDTO[]; meta: DisplayMetaDTO; fireAlerts: FireAlertDTO[]; voidAlerts: VoidAlertDTO[] }>> {
  const settings = await getSettings(venueId);
  const enabled = destination === 'kitchen' ? settings.kitchenDisplayEnabled : settings.barDisplayEnabled;
  if (!enabled) return { ok: false, error: err(403, 'DISPLAY_DISABLED', `The ${destination} display is not enabled for this venue`) };

  const statuses: OrderItemStatus[] = params.includeReady ? ['sent', 'preparing', 'ready'] : ['sent', 'preparing'];
  const where: Prisma.OrderItemWhereInput = { destinationSnapshot: destination, status: { in: statuses } };
  if (params.courseNumber != null) where.courseNumberSnapshot = params.courseNumber;

  const now = new Date();
  const [tickets, fireAlerts, voidAlerts] = await Promise.all([
    buildTickets(venueId, where, now),
    getEmbeddedFireAlerts(venueId),
    getEmbeddedVoidAlerts(venueId, destination),
  ]);
  return { ok: true, value: { tickets, meta: buildMeta(settings.displayAutoRefreshSeconds, tickets, now), fireAlerts, voidAlerts } };
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

// ── Fire alerts (Phase 2, session 2c) ───────────────────────────────────────

async function buildFireAlerts(venueId: string): Promise<FireAlertDTO[]> {
  const settings = await getSettings(venueId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - settings.showFireAlertSeconds * 1000);

  const courses = await scopedPrisma.orderCourse.findMany({
    where: { venueId, firedAt: { not: null, gte: cutoff }, fireAlertAckedAt: null },
    orderBy: { firedAt: 'desc' },
  });
  if (courses.length === 0) return [];

  const orderIds = [...new Set(courses.map(c => c.orderId))];
  const orders = await scopedPrisma.order.findMany({ where: { id: { in: orderIds }, venueId } });
  const ordersById = new Map(orders.map(o => [o.id, o]));

  const tableIds = [...new Set(orders.map(o => o.tableId).filter((x): x is string => !!x))];
  const tables = tableIds.length ? await scopedPrisma.restaurantTable.findMany({ where: { id: { in: tableIds }, venueId } }) : [];
  const tableById = new Map(tables.map(t => [t.id, t]));

  return courses
    .map(course => {
      const order = ordersById.get(course.orderId);
      if (!order) return null;
      const table = order.tableId ? (tableById.get(order.tableId) ?? null) : null;
      return buildFireAlert(course, order, table, settings.tableNamingMode, settings.showFireAlertSeconds);
    })
    .filter((a): a is FireAlertDTO => !!a);
}

// Unconditional — embedded into the existing (ungated) kitchen/bar ticket
// responses. Naturally empty for a venue that can never fire a course
// (happy_bar), so no availability gate is needed here; the standalone route
// below does gate, since it's one of the routes the 2c availability rule
// names explicitly.
export async function getEmbeddedFireAlerts(venueId: string): Promise<FireAlertDTO[]> {
  return buildFireAlerts(venueId);
}

export async function getFireAlerts(venueId: string): Promise<DisplayResult<FireAlertDTO[]>> {
  const gate = await checkCoursesAvailable(venueId);
  if (!gate.ok) return gate;
  return { ok: true, value: await buildFireAlerts(venueId) };
}

export async function ackFireAlert(venueId: string, courseId: string): Promise<DisplayResult<null>> {
  const course = await scopedPrisma.orderCourse.findFirst({ where: { id: courseId, venueId } });
  if (!course) return { ok: false, error: err(404, 'NOT_FOUND', 'Fire alert not found') };
  await scopedPrisma.orderCourse.update({ where: { id: courseId }, data: { fireAlertAckedAt: new Date() } });
  return { ok: true, value: null };
}

// ── Void alerts (Phase 2, session 2d-ii) ────────────────────────────────────
//
// Emitted only for stage='after_send' voids that reached approved/
// auto_approved — a pending request emits nothing, so the kitchen never
// stops cooking something that may end up not being voided. Gated by the
// single settings.void_alerts_kitchen flag for both kitchen- and bar-
// destination alerts (there's no separate *_bar flag in the schema).
async function buildVoidAlerts(venueId: string, destination?: Extract<Destination, 'kitchen' | 'bar'>): Promise<VoidAlertDTO[]> {
  const settings = await getSettings(venueId);
  if (!settings.voidAlertsKitchen) return [];

  const where: Prisma.RestaurantVoidLogWhereInput = {
    venueId,
    stage: 'after_send',
    status: { in: ['approved', 'auto_approved'] },
    voidAlertAckedAt: null,
  };
  if (destination) where.destinationSnapshot = destination;

  const logs = await scopedPrisma.restaurantVoidLog.findMany({ where, orderBy: { resolvedAt: 'desc' } });
  if (logs.length === 0) return [];

  // "Set kitchen_notified_at when first surfaced" — set once, never
  // overwritten, so only rows that don't have it yet are touched here.
  const toNotify = logs.filter(l => !l.kitchenNotifiedAt).map(l => l.id);
  if (toNotify.length > 0) {
    await scopedPrisma.restaurantVoidLog.updateMany({ where: { id: { in: toNotify }, venueId }, data: { kitchenNotifiedAt: new Date() } });
  }

  const orderIds = [...new Set(logs.map(l => l.orderId))];
  const orders = await scopedPrisma.order.findMany({ where: { id: { in: orderIds }, venueId } });
  const ordersById = new Map(orders.map(o => [o.id, o]));

  return logs.map(log => buildVoidAlert(log, ordersById.get(log.orderId) ?? null));
}

// Unconditional (like getEmbeddedFireAlerts) — embedded in the per-
// destination kitchen/bar ticket responses, so only that destination's
// voided items are ever surfaced there (2d-ii section 4: "a voided bar item
// never appears on the kitchen display").
export async function getEmbeddedVoidAlerts(venueId: string, destination: Extract<Destination, 'kitchen' | 'bar'>): Promise<VoidAlertDTO[]> {
  return buildVoidAlerts(venueId, destination);
}

// Standalone GET /displays/void-alerts — no destination segment in its path
// (unlike GET /displays/kitchen/fire-alerts), so this returns both
// kitchen- and bar-destination alerts together as a consolidated feed.
export async function getVoidAlerts(venueId: string): Promise<VoidAlertDTO[]> {
  return buildVoidAlerts(venueId);
}

export async function ackVoidAlert(venueId: string, voidLogId: string): Promise<DisplayResult<null>> {
  const log = await scopedPrisma.restaurantVoidLog.findFirst({ where: { id: voidLogId, venueId } });
  if (!log) return { ok: false, error: err(404, 'NOT_FOUND', 'Void alert not found') };
  await scopedPrisma.restaurantVoidLog.update({ where: { id: voidLogId }, data: { voidAlertAckedAt: new Date() } });
  return { ok: true, value: null };
}
