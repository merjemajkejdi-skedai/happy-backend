import { scopedPrisma } from '../../middleware/venueScope';
import { prisma } from '../../db/prisma';
import { Prisma, type RestaurantTable, type TableStatus, type TableNaming, type OrderStatus } from '../../generated/prisma/client';
import { err, type DomainError } from '../../lib/domainError';

// Matches the partial unique index on orders(table_id) — see docs/SCHEMA.md.
// Exported for reuse by the orders module (same statuses guard table
// occupancy there).
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['draft', 'open', 'sent', 'partially_served', 'served'];
const MAX_BULK_RANGE = 500; // defensive cap — not spec'd, just guards against an absurd request

export type TableDomainError = DomainError;

export type TableResult<T> = { ok: true; value: T } | { ok: false; error: TableDomainError };

function isConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export function computeDisplayLabel(mode: TableNaming, tableNumber: number | null, tableName: string | null): string {
  if (mode === 'number') return tableNumber != null ? String(tableNumber) : '';
  if (mode === 'name') return tableName ?? '';
  // 'both' — a table might only have one of the two set, per the naming rule below.
  if (tableNumber != null && tableName) return `${tableNumber} — ${tableName}`;
  return tableName ?? (tableNumber != null ? String(tableNumber) : '');
}

function validateNaming(mode: TableNaming, tableNumber: number | null, tableName: string | null): TableDomainError | null {
  const hasNumber = tableNumber != null;
  const hasName = !!tableName;
  if (mode === 'number') {
    if (!hasNumber) return err(422, 'TABLE_NUMBER_REQUIRED', "table_number is required for this venue's naming mode");
    if (hasName) return err(422, 'TABLE_NAME_NOT_ALLOWED', "table_name must be null for this venue's naming mode");
  } else if (mode === 'name') {
    if (!hasName) return err(422, 'TABLE_NAME_REQUIRED', "table_name is required for this venue's naming mode");
    if (hasNumber) return err(422, 'TABLE_NUMBER_NOT_ALLOWED', "table_number must be null for this venue's naming mode");
  } else if (!hasNumber && !hasName) {
    return err(422, 'TABLE_IDENTIFIER_REQUIRED', 'at least one of table_number or table_name is required');
  }
  return null;
}

async function getNamingMode(venueId: string): Promise<TableNaming> {
  const settings = await prisma.restaurantSettings.findUnique({ where: { venueId } });
  if (!settings) throw new Error(`restaurant_settings missing for venue ${venueId}`);
  return settings.tableNamingMode;
}

// ── List (with active-order summary + display_label) ────────────────────────

export interface ActiveOrderSummary {
  orderId: string;
  orderNumber: number;
  status: string;
  itemCount: number;
  grandTotal: number;
  openedAt: Date;
}

export interface TableWithSummary extends RestaurantTable {
  displayLabel: string;
  activeOrder: ActiveOrderSummary | null;
}

export interface ListTablesParams {
  areaId?: string;
  status?: TableStatus;
  page?: number;
  perPage?: number;
}

// Two flat queries + an in-memory join, rather than a nested `include` —
// keeps this independent of how well Prisma's client-extension typing
// preserves relation shapes through $allOperations (it doesn't, reliably).
async function getActiveOrderSummaries(venueId: string, tableIds: string[]): Promise<Map<string, ActiveOrderSummary>> {
  const map = new Map<string, ActiveOrderSummary>();
  if (tableIds.length === 0) return map;

  // At most one active order per table (enforced by orders_active_table_key).
  const orders = await scopedPrisma.order.findMany({
    where: { venueId, tableId: { in: tableIds }, status: { in: ACTIVE_ORDER_STATUSES } },
  });
  if (orders.length === 0) return map;

  const items = await scopedPrisma.orderItem.findMany({
    where: { venueId, orderId: { in: orders.map(o => o.id) }, status: { not: 'cancelled' } },
  });
  const itemCountByOrder = new Map<string, number>();
  for (const item of items) itemCountByOrder.set(item.orderId, (itemCountByOrder.get(item.orderId) ?? 0) + 1);

  for (const o of orders) {
    if (!o.tableId) continue;
    map.set(o.tableId, {
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      itemCount: itemCountByOrder.get(o.id) ?? 0,
      grandTotal: Number(o.grandTotal),
      openedAt: o.openedAt,
    });
  }
  return map;
}

export async function listTables(venueId: string, params: ListTablesParams) {
  const where: Prisma.RestaurantTableWhereInput = { venueId, deletedAt: null };
  if (params.areaId) where.areaId = params.areaId;
  if (params.status) where.status = params.status;

  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 50));

  const [tables, total, namingMode] = await Promise.all([
    scopedPrisma.restaurantTable.findMany({ where, orderBy: { sortOrder: 'asc' }, skip: (page - 1) * perPage, take: perPage }),
    scopedPrisma.restaurantTable.count({ where }),
    getNamingMode(venueId),
  ]);
  if (tables.length === 0) return { tables: [] as TableWithSummary[], page, perPage, total };

  const summaries = await getActiveOrderSummaries(venueId, tables.map(t => t.id));

  const withSummary = tables.map(t => ({
    ...t,
    displayLabel: computeDisplayLabel(namingMode, t.tableNumber, t.tableName),
    activeOrder: summaries.get(t.id) ?? null,
  }));
  return { tables: withSummary, page, perPage, total };
}

export async function getTable(venueId: string, tableId: string): Promise<TableWithSummary | null> {
  const [table, namingMode] = await Promise.all([
    scopedPrisma.restaurantTable.findFirst({ where: { id: tableId, venueId, deletedAt: null } }),
    getNamingMode(venueId),
  ]);
  if (!table) return null;

  const summaries = await getActiveOrderSummaries(venueId, [tableId]);

  return {
    ...table,
    displayLabel: computeDisplayLabel(namingMode, table.tableNumber, table.tableName),
    activeOrder: summaries.get(tableId) ?? null,
  };
}

// ── Create / update / delete ─────────────────────────────────────────────────

export interface TableInput {
  areaId?: string | null;
  tableNumber?: number | null;
  tableName?: string | null;
  seats?: number;
  sortOrder?: number;
}

export async function createTable(venueId: string, input: TableInput): Promise<TableResult<RestaurantTable>> {
  const mode = await getNamingMode(venueId);
  const namingError = validateNaming(mode, input.tableNumber ?? null, input.tableName ?? null);
  if (namingError) return { ok: false, error: namingError };

  if (input.areaId) {
    const area = await scopedPrisma.area.findFirst({ where: { id: input.areaId, venueId, deletedAt: null } });
    if (!area) return { ok: false, error: err(404, 'NOT_FOUND', 'Area not found') };
  }

  const conflict = await checkIdentifierConflict(venueId, input.tableNumber ?? null, input.tableName ?? null);
  if (conflict) return { ok: false, error: conflict };

  try {
    const table = await scopedPrisma.restaurantTable.create({
      data: {
        venueId,
        areaId: input.areaId ?? null,
        tableNumber: input.tableNumber ?? null,
        tableName: input.tableName ?? null,
        seats: input.seats ?? 2,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    return { ok: true, value: table };
  } catch (e) {
    if (isConflict(e)) return { ok: false, error: err(409, 'TABLE_IDENTIFIER_ALREADY_IN_USE', 'That table number or name is already in use') };
    throw e;
  }
}

async function checkIdentifierConflict(venueId: string, tableNumber: number | null, tableName: string | null, excludeId?: string) {
  if (tableNumber != null) {
    const existing = await scopedPrisma.restaurantTable.findFirst({
      where: { venueId, tableNumber, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) return err(409, 'TABLE_NUMBER_ALREADY_IN_USE', 'That table number is already in use');
  }
  if (tableName) {
    const existing = await scopedPrisma.restaurantTable.findFirst({
      where: { venueId, tableName, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) return err(409, 'TABLE_NAME_ALREADY_IN_USE', 'That table name is already in use');
  }
  return null;
}

export async function updateTable(venueId: string, tableId: string, input: Partial<TableInput>): Promise<TableResult<RestaurantTable>> {
  const existing = await scopedPrisma.restaurantTable.findFirst({ where: { id: tableId, venueId, deletedAt: null } });
  if (!existing) return { ok: false, error: err(404, 'NOT_FOUND', 'Table not found') };

  const mergedNumber = input.tableNumber !== undefined ? input.tableNumber : existing.tableNumber;
  const mergedName = input.tableName !== undefined ? input.tableName : existing.tableName;
  const mode = await getNamingMode(venueId);
  const namingError = validateNaming(mode, mergedNumber, mergedName);
  if (namingError) return { ok: false, error: namingError };

  if (input.areaId) {
    const area = await scopedPrisma.area.findFirst({ where: { id: input.areaId, venueId, deletedAt: null } });
    if (!area) return { ok: false, error: err(404, 'NOT_FOUND', 'Area not found') };
  }

  const conflict = await checkIdentifierConflict(venueId, mergedNumber, mergedName, tableId);
  if (conflict) return { ok: false, error: conflict };

  const data: Prisma.RestaurantTableUpdateInput = {};
  if (input.areaId !== undefined) data.area = input.areaId ? { connect: { id: input.areaId } } : { disconnect: true };
  if (input.tableNumber !== undefined) data.tableNumber = input.tableNumber;
  if (input.tableName !== undefined) data.tableName = input.tableName;
  if (input.seats !== undefined) data.seats = input.seats;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  try {
    const table = await scopedPrisma.restaurantTable.update({ where: { id: tableId }, data });
    return { ok: true, value: table };
  } catch (e) {
    if (isConflict(e)) return { ok: false, error: err(409, 'TABLE_IDENTIFIER_ALREADY_IN_USE', 'That table number or name is already in use') };
    throw e;
  }
}

export async function deleteTable(venueId: string, tableId: string): Promise<TableResult<null>> {
  const table = await scopedPrisma.restaurantTable.findFirst({ where: { id: tableId, venueId, deletedAt: null } });
  if (!table) return { ok: false, error: err(404, 'NOT_FOUND', 'Table not found') };

  const activeOrder = await scopedPrisma.order.findFirst({ where: { venueId, tableId, status: { in: ACTIVE_ORDER_STATUSES } } });
  if (activeOrder) return { ok: false, error: err(409, 'TABLE_HAS_ACTIVE_ORDER', 'This table has an active order') };

  await scopedPrisma.restaurantTable.update({ where: { id: tableId }, data: { deletedAt: new Date(), isActive: false } });
  return { ok: true, value: null };
}

export async function setTableStatus(venueId: string, tableId: string, status: TableStatus): Promise<TableResult<RestaurantTable>> {
  const table = await scopedPrisma.restaurantTable.findFirst({ where: { id: tableId, venueId, deletedAt: null } });
  if (!table) return { ok: false, error: err(404, 'NOT_FOUND', 'Table not found') };

  const updated = await scopedPrisma.restaurantTable.update({ where: { id: tableId }, data: { status } });
  return { ok: true, value: updated };
}

// ── Bulk create ──────────────────────────────────────────────────────────────

export interface BulkTableInput {
  areaId: string;
  from: number;
  to: number;
  seats?: number;
  prefix?: string;
}

export async function bulkCreateTables(venueId: string, input: BulkTableInput): Promise<TableResult<RestaurantTable[]>> {
  if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.from > input.to) {
    return { ok: false, error: err(422, 'INVALID_RANGE', 'from must be an integer less than or equal to to') };
  }
  if (input.to - input.from + 1 > MAX_BULK_RANGE) {
    return { ok: false, error: err(422, 'RANGE_TOO_LARGE', `bulk range cannot exceed ${MAX_BULK_RANGE} tables`) };
  }

  const area = await scopedPrisma.area.findFirst({ where: { id: input.areaId, venueId, deletedAt: null } });
  if (!area) return { ok: false, error: err(404, 'NOT_FOUND', 'Area not found') };

  const mode = await getNamingMode(venueId);
  const rows: { tableNumber: number; tableName: string | null }[] = [];
  for (let n = input.from; n <= input.to; n++) {
    const tableName = input.prefix ? `${input.prefix}${n}` : null;
    const namingError = validateNaming(mode, n, tableName);
    if (namingError) return { ok: false, error: namingError };
    rows.push({ tableNumber: n, tableName });
  }

  try {
    const created = await scopedPrisma.$transaction(
      rows.map((r, i) =>
        scopedPrisma.restaurantTable.create({
          data: { venueId, areaId: input.areaId, tableNumber: r.tableNumber, tableName: r.tableName, seats: input.seats ?? 2, sortOrder: i },
        }),
      ),
    );
    return { ok: true, value: created };
  } catch (e) {
    if (isConflict(e)) {
      return { ok: false, error: err(409, 'TABLE_IDENTIFIER_ALREADY_IN_USE', 'One or more table numbers/names in this range already exist') };
    }
    throw e;
  }
}
