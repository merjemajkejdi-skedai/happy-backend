import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import * as modifiersService from './modifiersService';
import { serializeModifierOption } from './serializers';

export const modifiersRouter = Router();

modifiersRouter.get('/modifier-groups', requirePermission('menu.view'), async (req: Request, res: Response) => {
  const { page, perPage } = parsePagination(req.query);
  const includeInactive = req.query.include_inactive === 'true';
  const result = await modifiersService.listModifierGroups(req.auth!.venueId, { page, perPage, includeInactive });
  sendData(
    res,
    result.groups.map(g => ({ ...g, options: g.options.map(serializeModifierOption) })),
    buildPaginationMeta(result.page, result.perPage, result.total),
  );
});

modifiersRouter.post('/modifier-groups', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const {
    name, type, is_required, min_select, max_select, sort_order,
    pricing_mode, applies_to_destination, display_style, is_active,
  } = req.body ?? {};
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');
  if (!['single', 'multiple'].includes(type)) return sendError(res, 'VALIDATION_ERROR', "type must be 'single' or 'multiple'");

  const result = await modifiersService.createModifierGroup(req.auth!.venueId, {
    name: String(name).trim(),
    type,
    isRequired: is_required,
    minSelect: min_select,
    maxSelect: max_select,
    sortOrder: sort_order,
    pricingMode: pricing_mode,
    appliesToDestination: applies_to_destination,
    displayStyle: display_style,
    isActive: is_active,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

modifiersRouter.patch('/modifier-groups/:id/reorder', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const { group_ids } = req.body ?? {};
  if (!Array.isArray(group_ids)) return sendError(res, 'VALIDATION_ERROR', 'group_ids must be an array');

  const result = await modifiersService.reorderModifierGroups(req.auth!.venueId, group_ids);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

modifiersRouter.post('/modifier-groups/:id/duplicate', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const result = await modifiersService.duplicateModifierGroup(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { ...result.value, options: result.value.options.map(serializeModifierOption) });
});

modifiersRouter.patch('/modifier-groups/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const {
    name, type, is_required, min_select, max_select, sort_order,
    pricing_mode, applies_to_destination, display_style, is_active,
  } = req.body ?? {};
  const result = await modifiersService.updateModifierGroup(req.auth!.venueId, req.params.id, {
    name: name !== undefined ? String(name).trim() : undefined,
    type,
    isRequired: is_required,
    minSelect: min_select,
    maxSelect: max_select,
    sortOrder: sort_order,
    pricingMode: pricing_mode,
    appliesToDestination: applies_to_destination,
    displayStyle: display_style,
    isActive: is_active,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

modifiersRouter.delete('/modifier-groups/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const result = await modifiersService.deleteModifierGroup(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { deleted: true });
});

modifiersRouter.post('/modifier-groups/:id/options', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const { name, price_delta, sort_order, is_default, stock_tracked, tier_prices } = req.body ?? {};
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');

  const result = await modifiersService.createModifierOption(req.auth!.venueId, req.params.id, {
    name: String(name).trim(),
    priceDelta: price_delta,
    sortOrder: sort_order,
    isDefault: is_default,
    stockTracked: stock_tracked,
    tierPrices: tier_prices,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeModifierOption(result.value));
});

modifiersRouter.patch('/modifier-options/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const { name, price_delta, sort_order, is_default, stock_tracked, tier_prices } = req.body ?? {};
  const result = await modifiersService.updateModifierOption(req.auth!.venueId, req.params.id, {
    name: name !== undefined ? String(name).trim() : undefined,
    priceDelta: price_delta,
    sortOrder: sort_order,
    isDefault: is_default,
    stockTracked: stock_tracked,
    tierPrices: tier_prices,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeModifierOption(result.value));
});

modifiersRouter.delete('/modifier-options/:id', requirePermission('menu.write'), async (req: Request, res: Response) => {
  const result = await modifiersService.deleteModifierOption(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { deleted: true });
});
