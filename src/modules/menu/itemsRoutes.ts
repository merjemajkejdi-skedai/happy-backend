import { Router, Request, Response } from 'express';
import { requirePermission, requireResolvedPermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import * as itemsService from './itemsService';
import * as modifiersService from './modifiersService';
import * as stockService from './stockService';
import { getVenueContext } from './validation';
import { serializeMenuItem, serializeModifierOption } from './serializers';
import type { MenuItem } from '../../generated/prisma/client';

export const itemsRouter = Router();

// Single-item routes each need one extra stock lookup — cheap, and correct
// beats reusing a bare serializeMenuItem call with no stock context (session
// 2e: is_orderable/stock_remaining are supposed to be on every item
// response, not just the list view).
async function serializeWithStock(venueId: string, item: MenuItem) {
  const context = await getVenueContext(venueId);
  const stockByItem = await stockService.getTodayStockByItem(venueId, context.timezone, [item.id]);
  return serializeMenuItem(item, stockByItem.get(item.id) ?? null, context.allowNegativeStock);
}

itemsRouter.get('/', requirePermission('menu.view'), async (req: Request, res: Response) => {
  const { category_id, is_available, search } = req.query as Record<string, string>;
  const { page, perPage } = parsePagination(req.query);
  const result = await itemsService.listItems(req.auth!.venueId, {
    categoryId: category_id,
    isAvailable: is_available === undefined ? undefined : is_available === 'true',
    search,
    page,
    perPage,
  });
  const context = await getVenueContext(req.auth!.venueId);
  const stockByItem = await stockService.getTodayStockByItem(req.auth!.venueId, context.timezone, result.items.map(i => i.id));
  sendData(
    res,
    result.items.map(item => serializeMenuItem(item, stockByItem.get(item.id) ?? null, context.allowNegativeStock)),
    buildPaginationMeta(result.page, result.perPage, result.total),
  );
});

itemsRouter.post('/', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const {
    category_id, name, description, price, destination, course_number,
    sku, is_available, sort_order, image_url, prep_minutes, tax_rate_percent,
  } = req.body ?? {};
  if (!category_id) return sendError(res, 'VALIDATION_ERROR', 'category_id is required');
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');
  if (price == null || Number.isNaN(Number(price)) || Number(price) < 0) {
    return sendError(res, 'VALIDATION_ERROR', 'price must be a non-negative number');
  }

  const result = await itemsService.createItem(req.auth!.venueId, {
    categoryId: category_id,
    name: String(name).trim(),
    description: description ?? null,
    price: Number(price),
    destination,
    courseNumber: course_number,
    sku: sku ?? null,
    isAvailable: is_available,
    sortOrder: sort_order,
    imageUrl: image_url ?? null,
    prepMinutes: prep_minutes,
    taxRatePercent: tax_rate_percent,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, await serializeWithStock(req.auth!.venueId, result.value));
});

itemsRouter.get('/:id', requirePermission('menu.view'), async (req: Request, res: Response) => {
  const item = await itemsService.getItem(req.auth!.venueId, req.params.id);
  if (!item) return sendError(res, 'NOT_FOUND', 'Item not found');
  sendData(res, await serializeWithStock(req.auth!.venueId, item));
});

itemsRouter.patch('/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const {
    category_id, name, description, price, destination, course_number,
    sku, is_available, sort_order, image_url, prep_minutes, tax_rate_percent,
  } = req.body ?? {};

  const result = await itemsService.updateItem(req.auth!.venueId, req.params.id, {
    categoryId: category_id,
    name: name !== undefined ? String(name).trim() : undefined,
    description,
    price: price !== undefined ? Number(price) : undefined,
    destination,
    courseNumber: course_number,
    sku,
    isAvailable: is_available,
    sortOrder: sort_order,
    imageUrl: image_url,
    prepMinutes: prep_minutes,
    taxRatePercent: tax_rate_percent,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, await serializeWithStock(req.auth!.venueId, result.value));
});

itemsRouter.delete('/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const result = await itemsService.deleteItem(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { deleted: true });
});

itemsRouter.patch('/:id/availability', requireResolvedPermission('menu.eightysix'), async (req: Request, res: Response) => {
  const { is_available } = req.body ?? {};
  if (typeof is_available !== 'boolean') return sendError(res, 'VALIDATION_ERROR', 'is_available (boolean) is required');
  const result = await itemsService.setItemAvailability(req.auth!.venueId, req.params.id, is_available);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, await serializeWithStock(req.auth!.venueId, result.value));
});

// ── Stock & 86 (Phase 2, session 2e) — dated, service-level, distinct from
// the Phase 1 is_available toggle above. ─────────────────────────────────────

itemsRouter.post('/:id/86', requireResolvedPermission('menu.eightysix'), async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  const context = await getVenueContext(req.auth!.venueId);
  const result = await stockService.eightysixItem(req.auth!.venueId, context.timezone, req.params.id, req.auth!.userId, reason ?? null);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

itemsRouter.post('/:id/restore', requireResolvedPermission('menu.eightysix'), async (req: Request, res: Response) => {
  const context = await getVenueContext(req.auth!.venueId);
  const result = await stockService.restoreItem(req.auth!.venueId, context.timezone, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

itemsRouter.patch('/:id/stock', requirePermission('menu.stock'), async (req: Request, res: Response) => {
  const { starting_quantity, delta } = req.body ?? {};
  const context = await getVenueContext(req.auth!.venueId);
  const result = await stockService.patchItemStock(req.auth!.venueId, context.timezone, req.params.id, req.auth!.userId, {
    startingQuantity: starting_quantity,
    delta,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

itemsRouter.get('/:id/modifier-groups', requirePermission('menu.view'), async (req: Request, res: Response) => {
  const result = await modifiersService.getItemModifierGroups(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value.map(g => ({ ...g, options: g.options.map(serializeModifierOption) })));
});

// Replaces the full set of modifier groups attached to this item.
itemsRouter.post('/:id/modifier-groups', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const { group_ids } = req.body ?? {};
  if (!Array.isArray(group_ids)) return sendError(res, 'VALIDATION_ERROR', 'group_ids must be an array');

  const result = await modifiersService.setItemModifierGroups(req.auth!.venueId, req.params.id, group_ids);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});
