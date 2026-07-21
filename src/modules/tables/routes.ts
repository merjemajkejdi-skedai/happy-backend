import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import * as tablesService from './service';
import type { TableResult, TableDomainError } from './service';
import type { TableStatus } from '../../generated/prisma/client';

export const tablesRouter = Router();
tablesRouter.use(authenticate, venueScope);

const TABLE_STATUSES: TableStatus[] = ['free', 'occupied', 'reserved', 'dirty'];

function sendTableError(res: Response, error: TableDomainError) {
  sendDomainError(res, error.status, error.code, error.message);
}

function respond<T>(res: Response, result: TableResult<T>) {
  if (!result.ok) return sendTableError(res, result.error);
  sendData(res, result.value);
}

tablesRouter.get('/', async (req: Request, res: Response) => {
  const { area_id, status } = req.query as Record<string, string>;
  if (status && !TABLE_STATUSES.includes(status as TableStatus)) {
    return sendError(res, 'VALIDATION_ERROR', `status must be one of: ${TABLE_STATUSES.join(', ')}`);
  }
  const { page, perPage } = parsePagination(req.query);
  const result = await tablesService.listTables(req.auth!.venueId, { areaId: area_id, status: status as TableStatus | undefined, page, perPage });
  sendData(res, result.tables, buildPaginationMeta(result.page, result.perPage, result.total));
});

tablesRouter.post('/', requirePermission('table.write'), async (req: Request, res: Response) => {
  const { area_id, table_number, table_name, seats, sort_order } = req.body ?? {};
  const result = await tablesService.createTable(req.auth!.venueId, {
    areaId: area_id ?? null,
    tableNumber: table_number ?? null,
    tableName: table_name ?? null,
    seats,
    sortOrder: sort_order,
  });
  respond(res, result);
});

// Bulk must be registered before /:id so 'bulk' isn't parsed as an id.
tablesRouter.post('/bulk', requirePermission('table.write'), async (req: Request, res: Response) => {
  const { area_id, from, to, seats, prefix } = req.body ?? {};
  if (!area_id || from == null || to == null) {
    return sendError(res, 'VALIDATION_ERROR', 'area_id, from and to are required');
  }
  const result = await tablesService.bulkCreateTables(req.auth!.venueId, {
    areaId: area_id,
    from: Number(from),
    to: Number(to),
    seats,
    prefix,
  });
  respond(res, result);
});

tablesRouter.get('/:id', async (req: Request, res: Response) => {
  const table = await tablesService.getTable(req.auth!.venueId, req.params.id);
  if (!table) return sendError(res, 'NOT_FOUND', 'Table not found');
  sendData(res, table);
});

tablesRouter.patch('/:id', requirePermission('table.write'), async (req: Request, res: Response) => {
  const { area_id, table_number, table_name, seats, sort_order } = req.body ?? {};
  const result = await tablesService.updateTable(req.auth!.venueId, req.params.id, {
    areaId: area_id,
    tableNumber: table_number,
    tableName: table_name,
    seats,
    sortOrder: sort_order,
  });
  respond(res, result);
});

tablesRouter.delete('/:id', requirePermission('table.write'), async (req: Request, res: Response) => {
  const result = await tablesService.deleteTable(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendTableError(res, result.error);
  sendData(res, { deleted: true });
});

tablesRouter.patch('/:id/status', requirePermission('table.status'), async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!TABLE_STATUSES.includes(status)) return sendError(res, 'VALIDATION_ERROR', `status must be one of: ${TABLE_STATUSES.join(', ')}`);
  const result = await tablesService.setTableStatus(req.auth!.venueId, req.params.id, status);
  respond(res, result);
});
