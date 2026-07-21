import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as lifecycleService from './lifecycleService';
import * as ordersService from './ordersService';
import { serializeOrder } from './serializers';

export const lifecycleRouter = Router({ mergeParams: true });

lifecycleRouter.post('/send', requirePermission('order.send'), async (req: Request, res: Response) => {
  const { course_number, item_ids } = req.body ?? {};
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const result = await lifecycleService.sendItems(
    req.auth!.venueId,
    req.auth!.userId,
    req.params.id,
    { courseNumber: course_number, itemIds: item_ids },
    idempotencyKey,
  );
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

lifecycleRouter.post('/transfer', requirePermission('order.transfer'), async (req: Request, res: Response) => {
  const { table_id } = req.body ?? {};
  if (!table_id) return sendError(res, 'VALIDATION_ERROR', 'table_id is required');
  const result = await lifecycleService.transferOrder(req.auth!.venueId, req.auth!.userId, req.params.id, table_id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value));
});

lifecycleRouter.post('/serve', requirePermission('order.serve'), async (req: Request, res: Response) => {
  const { item_ids } = req.body ?? {};
  const result = await lifecycleService.serveItems(req.auth!.venueId, req.auth!.userId, req.params.id, item_ids);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

lifecycleRouter.post('/close', requirePermission('order.close'), async (req: Request, res: Response) => {
  const result = await lifecycleService.closeOrder(req.auth!.venueId, req.auth!.userId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value));
});

// Base gate is order.create (matches the void-item precedent) — "any
// waiter" can cancel an unsent order; cancelling after anything was sent is
// checked inline against order.cancel_sent.
lifecycleRouter.post('/cancel', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  const result = await lifecycleService.cancelOrder(req.auth!.venueId, req.auth!.userId, req.auth!.role, req.params.id, reason);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value));
});

lifecycleRouter.get('/events', requirePermission('order.events.read'), async (req: Request, res: Response) => {
  const { page, limit } = req.query as Record<string, string>;
  const result = await ordersService.listOrderEvents(req.auth!.venueId, req.params.id, {
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
  });
  if (!result) return sendError(res, 'NOT_FOUND', 'Order not found');
  sendData(res, result.events, { page: result.page, limit: result.limit, total: result.total });
});
