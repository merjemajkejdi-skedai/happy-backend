import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as orderItemsService from './orderItemsService';
import { serializeOrderItem } from './serializers';

// mergeParams: true — this router is mounted at /orders/:id/items, and needs
// req.params.id (the order id) from the parent router.
export const orderItemsRouter = Router({ mergeParams: true });

orderItemsRouter.post('/', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { menu_item_id, quantity, modifier_option_ids, notes, course_number } = req.body ?? {};
  if (!menu_item_id) return sendError(res, 'VALIDATION_ERROR', 'menu_item_id is required');

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const result = await orderItemsService.addItem(
    req.auth!.venueId,
    req.auth!.userId,
    req.params.id,
    {
      menuItemId: menu_item_id,
      quantity,
      modifierOptionIds: modifier_option_ids,
      notes: notes ?? null,
      courseNumber: course_number,
    },
    idempotencyKey,
  );
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrderItem(result.value));
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

// Void. Permission split lives in the service (voidItem): status 'pending'
// only needs order.create (this route's own gate); anything past 'pending'
// additionally needs order.void_after_send, checked against the flag.
orderItemsRouter.delete('/:itemId', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  const result = await orderItemsService.voidItem(
    req.auth!.venueId,
    req.auth!.userId,
    req.auth!.role,
    req.params.id,
    req.params.itemId,
    { reason },
  );
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { deleted: true });
});
