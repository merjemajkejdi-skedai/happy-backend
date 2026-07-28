import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { runIdempotent } from '../../lib/idempotency';
import * as orderItemsService from './orderItemsService';
import * as lifecycleService from './lifecycleService';
import * as voidService from './voidService';
import { serializeOrderItem } from './serializers';

// mergeParams: true — this router is mounted at /orders/:id/items, and needs
// req.params.id (the order id) from the parent router.
export const orderItemsRouter = Router({ mergeParams: true });

orderItemsRouter.post('/', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { menu_item_id, quantity, modifier_option_ids, notes, course_number } = req.body ?? {};
  if (!menu_item_id) return sendError(res, 'VALIDATION_ERROR', 'menu_item_id is required');

  await runIdempotent(req, res, 'POST /orders/:id/items', async () => {
    const result = await orderItemsService.addItem(req.auth!.venueId, req.auth!.userId, req.params.id, {
      menuItemId: menu_item_id,
      quantity,
      modifierOptionIds: modifier_option_ids,
      notes: notes ?? null,
      courseNumber: course_number,
    });
    if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
    return { status: 200, body: { data: serializeOrderItem(result.value), meta: {} } };
  });
});

orderItemsRouter.patch('/:itemId', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { quantity, notes, modifier_option_ids } = req.body ?? {};
  const result = await orderItemsService.updateItem(req.auth!.venueId, req.auth!.userId, req.params.id, req.params.itemId, {
    quantity,
    notes,
    modifierOptionIds: modifier_option_ids,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrderItem(result.value));
});

orderItemsRouter.patch('/:itemId/modifiers', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { modifier_option_ids } = req.body ?? {};
  if (!Array.isArray(modifier_option_ids)) return sendError(res, 'VALIDATION_ERROR', 'modifier_option_ids must be an array');

  const result = await orderItemsService.setItemModifiers(req.auth!.venueId, req.auth!.userId, req.params.id, req.params.itemId, modifier_option_ids);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrderItem(result.value));
});

// Void (Phase 2, session 2d-i). Both this legacy route and the canonical
// POST .../void below go through the same requestVoid flow — see
// voidService.ts. `reason` (Phase 1's only field) maps to `reason_text`.
// Response is 202 with the void id while a request is queued for approval,
// 200 {deleted:true} once the item is actually cancelled (immediately, or
// later via POST /voids/:id/approve).
orderItemsRouter.delete('/:itemId', requirePermission('order.void'), async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  const result = await voidService.requestVoid(req.auth!.venueId, req.auth!.userId, req.auth!.role, req.params.id, req.params.itemId, {
    reasonText: reason,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  if (result.value.pending) {
    return res.status(202).json({ data: { deleted: false, pending: true, void_id: result.value.voidLog.id }, meta: {} });
  }
  sendData(res, { deleted: true, void_id: result.value.voidLog.id });
});

orderItemsRouter.post('/:itemId/void', requirePermission('order.void'), async (req: Request, res: Response) => {
  const { reason_code, reason_text } = req.body ?? {};
  await runIdempotent(req, res, 'POST /orders/:id/items/:itemId/void', async () => {
    const result = await voidService.requestVoid(req.auth!.venueId, req.auth!.userId, req.auth!.role, req.params.id, req.params.itemId, {
      reasonCode: reason_code,
      reasonText: reason_text,
    });
    if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
    if (result.value.pending) {
      return { status: 202, body: { data: { pending: true, void: result.value.voidLog }, meta: {} } };
    }
    return { status: 200, body: { data: { pending: false, void: result.value.voidLog }, meta: {} } };
  });
});

orderItemsRouter.patch('/:itemId/serve', requirePermission('order.serve'), async (req: Request, res: Response) => {
  const result = await lifecycleService.serveItem(req.auth!.venueId, req.auth!.userId, req.params.id, req.params.itemId);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { served: true });
});
