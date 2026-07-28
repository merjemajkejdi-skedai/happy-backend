import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { runIdempotent } from '../../lib/idempotency';
import { getSettingsRow } from '../settings/service';
import { serializeOrder } from './serializers';
import * as splitService from './splitService';

// mergeParams: true — mounted at /orders/:id, same as lifecycleRouter/coursesRouter.
export const splitRouter = Router({ mergeParams: true });

function isValidAllocationsShape(allocations: unknown): allocations is { order_item_ids: string[]; label?: string }[] {
  return (
    Array.isArray(allocations) &&
    allocations.every(
      a =>
        a && typeof a === 'object' &&
        Array.isArray((a as { order_item_ids?: unknown }).order_item_ids) &&
        (a as { order_item_ids: unknown[] }).order_item_ids.every(id => typeof id === 'string') &&
        ((a as { label?: unknown }).label === undefined || typeof (a as { label?: unknown }).label === 'string'),
    )
  );
}

splitRouter.post('/split', requirePermission('order.split'), async (req: Request, res: Response) => {
  const { split_type } = req.body ?? {};

  if (split_type === 'equal') {
    const { ways } = req.body ?? {};
    if (!Number.isInteger(ways)) return sendError(res, 'VALIDATION_ERROR', 'ways must be an integer');

    await runIdempotent(req, res, 'POST /orders/:id/split', async () => {
      const [result, settings] = await Promise.all([
        splitService.splitEqual(req.auth!.venueId, req.auth!.userId, req.params.id, ways),
        getSettingsRow(req.auth!.venueId),
      ]);
      if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
      return { status: 200, body: { data: result.value.map(o => serializeOrder(o, settings?.pmsEnabled)), meta: {} } };
    });
    return;
  }

  if (split_type === 'by_item') {
    const { allocations } = req.body ?? {};
    if (!isValidAllocationsShape(allocations)) {
      return sendError(res, 'VALIDATION_ERROR', 'allocations must be an array of { order_item_ids: string[], label? }');
    }
    const mapped = allocations.map(a => ({ orderItemIds: a.order_item_ids, label: a.label ?? null }));

    await runIdempotent(req, res, 'POST /orders/:id/split', async () => {
      const [result, settings] = await Promise.all([
        splitService.splitByItem(req.auth!.venueId, req.auth!.userId, req.params.id, mapped),
        getSettingsRow(req.auth!.venueId),
      ]);
      if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
      return { status: 200, body: { data: result.value.map(o => serializeOrder(o, settings?.pmsEnabled)), meta: {} } };
    });
    return;
  }

  if (split_type === 'by_seat') {
    await runIdempotent(req, res, 'POST /orders/:id/split', async () => {
      const [result, settings] = await Promise.all([
        splitService.splitBySeat(req.auth!.venueId, req.auth!.userId, req.params.id),
        getSettingsRow(req.auth!.venueId),
      ]);
      if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
      return { status: 200, body: { data: result.value.map(o => serializeOrder(o, settings?.pmsEnabled)), meta: {} } };
    });
    return;
  }

  return sendError(res, 'VALIDATION_ERROR', "split_type must be 'equal', 'by_item', or 'by_seat'");
});

splitRouter.get('/splits', requirePermission('order.view_own'), async (req: Request, res: Response) => {
  const [result, settings] = await Promise.all([
    splitService.listSplits(req.auth!.venueId, req.params.id),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value.map(o => serializeOrder(o, settings?.pmsEnabled)));
});

splitRouter.post('/splits/:childId/merge-back', requirePermission('order.split'), async (req: Request, res: Response) => {
  const result = await splitService.mergeBackSplit(req.auth!.venueId, req.auth!.userId, req.params.id, req.params.childId);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { merged: true });
});
