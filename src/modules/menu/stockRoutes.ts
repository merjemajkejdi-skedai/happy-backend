import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import * as stockService from './stockService';
import { getVenueContext } from './validation';

export const stockRouter = Router();

// No permission is named for this one in docs/phase2/2e.md's route list —
// treated as a read of menu-adjacent data, same gate as GET /menu/items.
stockRouter.get('/stock', requirePermission('menu.view'), async (req: Request, res: Response) => {
  const { business_date } = req.query as Record<string, string>;
  const context = await getVenueContext(req.auth!.venueId);
  const rows = await stockService.listStock(req.auth!.venueId, context.timezone, business_date);
  sendData(res, rows);
});

// Registered before any parameterized stock sub-path could exist — none do
// today, but this keeps the literal-before-param discipline used elsewhere
// in this codebase (e.g. GET /users/roles before GET /users/:id).
stockRouter.get('/stock/movements', requirePermission('reports.view'), async (req: Request, res: Response) => {
  const { menu_item_id, from, to } = req.query as Record<string, string>;
  const { page, perPage } = parsePagination(req.query);
  const result = await stockService.listMovements(req.auth!.venueId, { menuItemId: menu_item_id, from, to, page, perPage });
  sendData(res, result.movements, buildPaginationMeta(result.page, result.perPage, result.total));
});

stockRouter.get('/stock/low', requirePermission('menu.view'), async (req: Request, res: Response) => {
  const context = await getVenueContext(req.auth!.venueId);
  const rows = await stockService.listLowStock(req.auth!.venueId, context.timezone);
  sendData(res, rows);
});

stockRouter.post('/stock/bulk-set', requirePermission('menu.stock'), async (req: Request, res: Response) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) return sendError(res, 'VALIDATION_ERROR', 'items must be a non-empty array');
  const context = await getVenueContext(req.auth!.venueId);
  const result = await stockService.bulkSetStock(
    req.auth!.venueId,
    context.timezone,
    req.auth!.userId,
    items.map((i: { menu_item_id: string; starting_quantity: number }) => ({ menuItemId: i.menu_item_id, startingQuantity: i.starting_quantity })),
  );
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

stockRouter.post('/stock/day-open', requirePermission('menu.stock'), async (req: Request, res: Response) => {
  const { business_date } = req.body ?? {};
  const context = await getVenueContext(req.auth!.venueId);
  const result = await stockService.dayOpen(req.auth!.venueId, context.timezone, req.auth!.userId, business_date);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});
