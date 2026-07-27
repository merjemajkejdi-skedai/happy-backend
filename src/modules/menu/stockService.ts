import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { err, type MenuDomainError } from './validation';
import { Prisma, type MenuItemStock, type RestaurantSettings } from '../../generated/prisma/client';

export type StockResult<T> = { ok: true; value: T } | { ok: false; error: MenuDomainError };

type Tx = Parameters<Parameters<typeof scopedPrisma.$transaction>[0]>[0];

// ── is_orderable / stock_remaining — the one shared computation (section 1) ─
// No client ever recomputes this; every menu response that includes an item
// runs it through here.

export interface StockSnapshot {
  mode: MenuItemStock['mode'];
  currentQuantity: number | null;
  is86ed: boolean;
}

export function computeIsOrderable(
  item: { isActive: boolean; isAvailable: boolean },
  stock: StockSnapshot | null,
  allowNegativeStock: boolean,
): boolean {
  if (!item.isActive || !item.isAvailable) return false;
  if (!stock) return true; // never stock-tracked — Phase 1 switches are the only gate
  if (stock.is86ed) return false;
  if (stock.mode === 'none') return true;
  return (stock.currentQuantity ?? 0) > 0 || allowNegativeStock;
}

export function computeStockRemaining(stock: StockSnapshot | null): number | null {
  if (!stock || stock.mode === 'none') return null;
  return stock.currentQuantity;
}

// Deliberately NOT reusing orders/ticketNumbering's computeBusinessDate,
// which is specifically about the ticket_number_reset setting (unrelated)
// and has a non-daily fallback that doesn't make sense for stock — stock
// always resets by calendar day in the venue's own timezone.
export function businessDateFor(timezone: string, at: Date = new Date()): Date {
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(`${isoDate}T00:00:00.000Z`);
}

// Bulk lookup for treeService/itemsRoutes — one query for however many items
// are being rendered, not one per item.
export async function getTodayStockByItem(venueId: string, timezone: string, menuItemIds: string[]): Promise<Map<string, MenuItemStock>> {
  if (menuItemIds.length === 0) return new Map();
  const businessDate = businessDateFor(timezone);
  const rows = await scopedPrisma.menuItemStock.findMany({ where: { venueId, menuItemId: { in: menuItemIds }, businessDate } });
  return new Map(rows.map(r => [r.menuItemId, r]));
}

// ── Order-time decrement — the highest-risk part of this session ───────────
//
// Called from inside orderItemsService.addItem's own transaction. The row is
// read ONCE first to learn whether this item is tracked today at all — safe,
// because `mode`/`id` aren't subject to the concurrency race, only
// current_quantity is. The actual check-and-decrement is one atomic
// UPDATE ... WHERE current_quantity >= $qty ... RETURNING, never a
// read-current-quantity-then-write (that's exactly the race that oversells
// during a rush).

export interface StockDecrementOutcome {
  tracked: boolean;
  remaining?: number;
}

export async function decrementStockForOrder(
  tx: Tx,
  venueId: string,
  menuItemId: string,
  quantity: number,
  orderItemId: string,
  actorUserId: string,
  businessDate: Date,
  settings: Pick<RestaurantSettings, 'allowNegativeStock' | 'stockAuto86AtZero'>,
): Promise<StockResult<StockDecrementOutcome>> {
  const row = await tx.menuItemStock.findUnique({ where: { menuItemId_businessDate: { menuItemId, businessDate } } });
  if (!row || row.mode === 'none') return { ok: true, value: { tracked: false } };

  const updated = await tx.$queryRaw<{ current_quantity: number | null }[]>`
    UPDATE menu_item_stock
       SET current_quantity = current_quantity - ${quantity}, updated_at = now()
     WHERE id = ${row.id}::uuid
       AND (current_quantity >= ${quantity} OR ${settings.allowNegativeStock})
     RETURNING current_quantity
  `;

  if (updated.length === 0) {
    const current = await tx.menuItemStock.findUnique({ where: { id: row.id } });
    return { ok: false, error: err(409, 'INSUFFICIENT_STOCK', `Only ${current?.currentQuantity ?? 0} of this item remain`) };
  }

  const newQuantity = updated[0].current_quantity ?? 0;
  await tx.stockMovement.create({
    data: { venueId, menuItemId, businessDate, delta: -quantity, reason: 'order', orderItemId, actorUserId, balanceAfter: newQuantity },
  });

  if (newQuantity <= 0 && settings.stockAuto86AtZero && !row.is86ed) {
    await tx.menuItemStock.update({ where: { id: row.id }, data: { is86ed: true, eightysixedAt: new Date() } });
  }

  return { ok: true, value: { tracked: true, remaining: newQuantity } };
}

// ── Restoration — wired into the void approval path, not the request path ──
//
// Finds the exact original decrement via stock_movements (reason='order',
// keyed by order_item_id — a plain reference, not a FK, precisely so this
// lookup survives regardless of how much later the void happens) and
// reverses that exact delta against the same business_date's row, rather
// than assuming "today" — correct even for a void on a later business day
// than the original order, not just the common same-day case.
export async function restoreStockForVoid(tx: Tx, venueId: string, orderItemId: string, actorUserId: string): Promise<void> {
  const orderMovement = await tx.stockMovement.findFirst({
    where: { venueId, orderItemId, reason: 'order' },
    orderBy: { createdAt: 'desc' },
  });
  if (!orderMovement) return; // never stock-decremented — nothing to restore

  const row = await tx.menuItemStock.findFirst({
    where: { venueId, menuItemId: orderMovement.menuItemId, businessDate: orderMovement.businessDate },
  });
  if (!row) return; // defensive — the row that was decremented should still exist

  const restoreQty = -orderMovement.delta;
  const updated = await tx.menuItemStock.update({
    where: { id: row.id },
    data: { currentQuantity: { increment: restoreQty }, restoredAt: new Date() },
  });

  await tx.stockMovement.create({
    data: {
      venueId,
      menuItemId: orderMovement.menuItemId,
      businessDate: orderMovement.businessDate,
      delta: restoreQty,
      reason: 'void',
      orderItemId,
      actorUserId,
      balanceAfter: updated.currentQuantity ?? 0,
    },
  });
}

// ── 86 / restore (dated, service-level — distinct from menu_items.is_available) ─

export async function eightysixItem(
  venueId: string,
  timezone: string,
  itemId: string,
  actorUserId: string,
  reason: string | null,
): Promise<StockResult<MenuItemStock>> {
  const item = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  const businessDate = businessDateFor(timezone);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId } });
  const existing = await scopedPrisma.menuItemStock.findFirst({ where: { venueId, menuItemId: itemId, businessDate } });

  const row = existing
    ? await scopedPrisma.menuItemStock.update({
        where: { id: existing.id },
        data: { is86ed: true, eightysixedAt: new Date(), eightysixedByUserId: actorUserId, eightysixReason: reason },
      })
    : await scopedPrisma.menuItemStock.create({
        data: {
          venueId,
          menuItemId: itemId,
          businessDate,
          mode: settings.stockTrackingMode,
          is86ed: true,
          eightysixedAt: new Date(),
          eightysixedByUserId: actorUserId,
          eightysixReason: reason,
        },
      });

  return { ok: true, value: row };
}

// Idempotent — restoring an item that isn't currently 86'd is a no-op
// success, same convention as this session's other ack/re-fire idempotency
// choices, rather than an error over nothing being wrong.
export async function restoreItem(venueId: string, timezone: string, itemId: string): Promise<StockResult<MenuItemStock | null>> {
  const item = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  const businessDate = businessDateFor(timezone);
  const existing = await scopedPrisma.menuItemStock.findFirst({ where: { venueId, menuItemId: itemId, businessDate } });
  if (!existing || !existing.is86ed) return { ok: true, value: existing };

  const row = await scopedPrisma.menuItemStock.update({ where: { id: existing.id }, data: { is86ed: false, restoredAt: new Date() } });
  return { ok: true, value: row };
}

// ── Manual quantity adjustment ──────────────────────────────────────────────

export interface PatchStockInput {
  startingQuantity?: number;
  delta?: number;
}

export async function patchItemStock(
  venueId: string,
  timezone: string,
  itemId: string,
  actorUserId: string,
  input: PatchStockInput,
): Promise<StockResult<MenuItemStock>> {
  if (input.startingQuantity === undefined && input.delta === undefined) {
    return { ok: false, error: err(422, 'VALIDATION_ERROR', 'starting_quantity or delta is required') };
  }
  const item = await scopedPrisma.menuItem.findFirst({ where: { id: itemId, venueId, deletedAt: null } });
  if (!item) return { ok: false, error: err(404, 'NOT_FOUND', 'Item not found') };

  const businessDate = businessDateFor(timezone);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId } });
  const existing = await scopedPrisma.menuItemStock.findFirst({ where: { venueId, menuItemId: itemId, businessDate } });

  if (input.startingQuantity !== undefined) {
    if (!Number.isInteger(input.startingQuantity) || input.startingQuantity < 0) {
      return { ok: false, error: err(422, 'VALIDATION_ERROR', 'starting_quantity must be a non-negative integer') };
    }
    const startingQuantity = input.startingQuantity;
    const row = await scopedPrisma.$transaction(async tx => {
      const saved = existing
        ? await tx.menuItemStock.update({
            where: { id: existing.id },
            data: { mode: settings.stockTrackingMode, startingQuantity, currentQuantity: startingQuantity },
          })
        : await tx.menuItemStock.create({
            data: { venueId, menuItemId: itemId, businessDate, mode: settings.stockTrackingMode, startingQuantity, currentQuantity: startingQuantity },
          });
      await tx.stockMovement.create({
        data: {
          venueId,
          menuItemId: itemId,
          businessDate,
          delta: startingQuantity - (existing?.currentQuantity ?? 0),
          reason: 'manual_adjust',
          actorUserId,
          balanceAfter: saved.currentQuantity ?? 0,
        },
      });
      return saved;
    });
    return { ok: true, value: row };
  }

  // delta form — an item must already be tracked (have a row) to adjust by
  // delta; there's no baseline to adjust otherwise.
  if (!existing) {
    return { ok: false, error: err(422, 'ITEM_NOT_STOCK_TRACKED', 'This item has no stock row yet — set starting_quantity first') };
  }
  const delta = input.delta!;
  if (!Number.isInteger(delta)) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'delta must be an integer') };

  const row = await scopedPrisma.$transaction(async tx => {
    const saved = await tx.menuItemStock.update({ where: { id: existing.id }, data: { currentQuantity: { increment: delta } } });
    await tx.stockMovement.create({
      data: {
        venueId,
        menuItemId: itemId,
        businessDate,
        delta,
        reason: delta > 0 ? 'restock' : 'manual_adjust',
        actorUserId,
        balanceAfter: saved.currentQuantity ?? 0,
      },
    });
    return saved;
  });
  return { ok: true, value: row };
}

// ── Bulk set (best-effort payload — see docs/phase2/SESSION-2e.md) ─────────

export interface BulkSetStockItem {
  menuItemId: string;
  startingQuantity: number;
}

export async function bulkSetStock(
  venueId: string,
  timezone: string,
  actorUserId: string,
  items: BulkSetStockItem[],
): Promise<StockResult<MenuItemStock[]>> {
  if (items.length === 0) return { ok: false, error: err(422, 'VALIDATION_ERROR', 'items must be a non-empty array') };
  for (const i of items) {
    if (!Number.isInteger(i.startingQuantity) || i.startingQuantity < 0) {
      return { ok: false, error: err(422, 'VALIDATION_ERROR', 'starting_quantity must be a non-negative integer') };
    }
  }

  const businessDate = businessDateFor(timezone);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId } });

  const menuItemIds = items.map(i => i.menuItemId);
  const validItems = await scopedPrisma.menuItem.findMany({ where: { id: { in: menuItemIds }, venueId, deletedAt: null } });
  if (validItems.length !== new Set(menuItemIds).size) {
    return { ok: false, error: err(404, 'NOT_FOUND', 'One or more menu items not found') };
  }

  const existingRows = await scopedPrisma.menuItemStock.findMany({ where: { venueId, menuItemId: { in: menuItemIds }, businessDate } });
  const existingByItem = new Map(existingRows.map(r => [r.menuItemId, r]));

  const saved = await scopedPrisma.$transaction(async tx => {
    const results: MenuItemStock[] = [];
    for (const { menuItemId, startingQuantity } of items) {
      const existing = existingByItem.get(menuItemId);
      const row = existing
        ? await tx.menuItemStock.update({
            where: { id: existing.id },
            data: { mode: settings.stockTrackingMode, startingQuantity, currentQuantity: startingQuantity },
          })
        : await tx.menuItemStock.create({
            data: { venueId, menuItemId, businessDate, mode: settings.stockTrackingMode, startingQuantity, currentQuantity: startingQuantity },
          });
      await tx.stockMovement.create({
        data: {
          venueId,
          menuItemId,
          businessDate,
          delta: startingQuantity - (existing?.currentQuantity ?? 0),
          reason: 'restock',
          actorUserId,
          balanceAfter: row.currentQuantity ?? 0,
        },
      });
      results.push(row);
    }
    return results;
  });

  return { ok: true, value: saved };
}

// ── Day open (idempotent per business_date) ─────────────────────────────────
//
// Only carries forward items that have EVER had a stock row before — never
// invents a starting quantity for an item that's never been explicitly
// stocked (see docs/phase2/SESSION-2e.md for why). "Fresh row" means a new
// row for the new business_date, seeded from that item's most recent prior
// row's starting_quantity; today's is_86ed resets to false unless
// eightysix_resets_daily is off, in which case it carries forward.
export async function dayOpen(
  venueId: string,
  timezone: string,
  actorUserId: string,
  businessDateInput?: string,
): Promise<StockResult<MenuItemStock[]>> {
  const businessDate = businessDateInput ? new Date(`${businessDateInput}T00:00:00.000Z`) : businessDateFor(timezone);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId } });

  const existingToday = await scopedPrisma.menuItemStock.findMany({ where: { venueId, businessDate } });
  const alreadyOpenedItemIds = new Set(existingToday.map(r => r.menuItemId));

  const priorRows = await scopedPrisma.menuItemStock.findMany({
    where: { venueId, businessDate: { lt: businessDate } },
    orderBy: { businessDate: 'desc' },
  });
  const mostRecentByItem = new Map<string, MenuItemStock>();
  for (const row of priorRows) {
    if (!mostRecentByItem.has(row.menuItemId)) mostRecentByItem.set(row.menuItemId, row);
  }
  const toCreate = [...mostRecentByItem.values()].filter(r => !alreadyOpenedItemIds.has(r.menuItemId));

  const created = await scopedPrisma.$transaction(async tx => {
    const rows: MenuItemStock[] = [];
    for (const prior of toCreate) {
      const row = await tx.menuItemStock.create({
        data: {
          venueId,
          menuItemId: prior.menuItemId,
          businessDate,
          mode: settings.stockTrackingMode,
          startingQuantity: prior.startingQuantity,
          currentQuantity: prior.startingQuantity,
          is86ed: settings.eightysixResetsDaily ? false : prior.is86ed,
        },
      });
      await tx.stockMovement.create({
        data: { venueId, menuItemId: prior.menuItemId, businessDate, delta: prior.startingQuantity ?? 0, reason: 'day_open', actorUserId, balanceAfter: row.currentQuantity ?? 0 },
      });
      rows.push(row);
    }
    return rows;
  });

  return { ok: true, value: [...existingToday, ...created] };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listStock(venueId: string, timezone: string, businessDateInput?: string): Promise<MenuItemStock[]> {
  const businessDate = businessDateInput ? new Date(`${businessDateInput}T00:00:00.000Z`) : businessDateFor(timezone);
  return scopedPrisma.menuItemStock.findMany({ where: { venueId, businessDate } });
}

export interface ListMovementsParams {
  menuItemId?: string;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

export async function listMovements(venueId: string, params: ListMovementsParams) {
  const where: Prisma.StockMovementWhereInput = { venueId };
  if (params.menuItemId) where.menuItemId = params.menuItemId;
  if (params.from || params.to) {
    where.businessDate = {};
    if (params.from) where.businessDate.gte = new Date(`${params.from}T00:00:00.000Z`);
    if (params.to) where.businessDate.lte = new Date(`${params.to}T00:00:00.000Z`);
  }

  const [movements, total] = await Promise.all([
    scopedPrisma.stockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.perPage, take: params.perPage }),
    scopedPrisma.stockMovement.count({ where }),
  ]);
  return { movements, page: params.page, perPage: params.perPage, total };
}

export async function listLowStock(venueId: string, timezone: string): Promise<MenuItemStock[]> {
  const businessDate = businessDateFor(timezone);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { venueId } });
  return scopedPrisma.menuItemStock.findMany({
    where: { venueId, businessDate, mode: { not: 'none' }, currentQuantity: { lte: settings.stockWarnThreshold } },
    orderBy: { currentQuantity: 'asc' },
  });
}
