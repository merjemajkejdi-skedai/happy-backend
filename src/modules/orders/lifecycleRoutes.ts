import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import { runIdempotent } from '../../lib/idempotency';
import { getSettingsRow } from '../settings/service';
import * as lifecycleService from './lifecycleService';
import * as ordersService from './ordersService';
import { serializeOrder } from './serializers';

export const lifecycleRouter = Router({ mergeParams: true });

lifecycleRouter.post('/send', requirePermission('order.send'), async (req: Request, res: Response) => {
  const { course_number, item_ids } = req.body ?? {};

  await runIdempotent(req, res, 'POST /orders/:id/send', async () => {
    const result = await lifecycleService.sendItems(req.auth!.venueId, req.auth!.userId, req.params.id, {
      courseNumber: course_number,
      itemIds: item_ids,
    });
    if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
    return { status: 200, body: { data: result.value, meta: {} } };
  });
});

lifecycleRouter.post('/transfer', requirePermission('order.transfer'), async (req: Request, res: Response) => {
  const { table_id } = req.body ?? {};
  if (!table_id) return sendError(res, 'VALIDATION_ERROR', 'table_id is required');
  const [result, settings] = await Promise.all([
    lifecycleService.transferOrder(req.auth!.venueId, req.auth!.userId, req.params.id, table_id),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value, settings?.pmsEnabled));
});

lifecycleRouter.post('/serve', requirePermission('order.serve'), async (req: Request, res: Response) => {
  const { item_ids } = req.body ?? {};
  const result = await lifecycleService.serveItems(req.auth!.venueId, req.auth!.userId, req.params.id, item_ids);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

lifecycleRouter.post('/close', requirePermission('order.close'), async (req: Request, res: Response) => {
  const [result, settings] = await Promise.all([
    lifecycleService.closeOrder(req.auth!.venueId, req.auth!.userId, req.params.id),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value, settings?.pmsEnabled));
});

// Base gate is order.create (matches the void-item precedent) — "any
// waiter" can cancel an unsent order; cancelling after anything was sent is
// checked inline against order.cancel_sent.
lifecycleRouter.post('/cancel', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  const [result, settings] = await Promise.all([
    lifecycleService.cancelOrder(req.auth!.venueId, req.auth!.userId, req.auth!.role, req.params.id, reason),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value, settings?.pmsEnabled));
});

lifecycleRouter.get('/events', requirePermission('order.events.read'), async (req: Request, res: Response) => {
  const { page, perPage } = parsePagination(req.query);
  const result = await ordersService.listOrderEvents(req.auth!.venueId, req.params.id, { page, perPage });
  if (!result) return sendError(res, 'NOT_FOUND', 'Order not found');
  sendData(res, result.events, buildPaginationMeta(result.page, result.perPage, result.total));
});
