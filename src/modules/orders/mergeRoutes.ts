import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { getSettingsRow } from '../settings/service';
import { serializeOrder } from './serializers';
import * as mergeService from './mergeService';

// mergeParams: true — mounted at /orders/:id, same as lifecycleRouter/coursesRouter/splitRouter.
export const mergeRouter = Router({ mergeParams: true });

// Direction: :id (the route param) is always the TARGET (survivor);
// source_order_id is the order being absorbed and left behind as 'merged'.
// Stated here and in docs/API.md because a reversed direction is the
// likeliest integration bug per 2f-iii.md's own warning.

mergeRouter.get('/merge-preview', requirePermission('order.merge'), async (req: Request, res: Response) => {
  const sourceOrderId = req.query.source_order_id as string | undefined;
  if (!sourceOrderId) return sendError(res, 'VALIDATION_ERROR', 'source_order_id query parameter is required');

  const targetTableId = (req.query.target_table_id as string | undefined) ?? null;
  const result = await mergeService.previewMerge(req.auth!.venueId, req.auth!.userId, req.auth!.role, req.params.id, sourceOrderId, targetTableId);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

mergeRouter.post('/merge', requirePermission('order.merge'), async (req: Request, res: Response) => {
  const { source_order_id, target_table_id } = req.body ?? {};
  if (typeof source_order_id !== 'string' || !source_order_id) {
    return sendError(res, 'VALIDATION_ERROR', 'source_order_id is required');
  }

  const [result, settings] = await Promise.all([
    mergeService.mergeOrders(req.auth!.venueId, req.auth!.userId, req.auth!.role, req.params.id, source_order_id, target_table_id ?? null),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, {
    target: serializeOrder(result.value.target, settings?.pmsEnabled),
    source: serializeOrder(result.value.source, settings?.pmsEnabled),
  });
});
