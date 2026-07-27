import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { getSettingsRow } from '../settings/service';
import { serializeOrder } from './serializers';
import * as splitService from './splitService';

// mergeParams: true — mounted at /orders/:id, same as lifecycleRouter/coursesRouter.
export const splitRouter = Router({ mergeParams: true });

splitRouter.post('/split', requirePermission('order.split'), async (req: Request, res: Response) => {
  const { split_type, ways } = req.body ?? {};
  if (split_type !== 'equal') return sendError(res, 'VALIDATION_ERROR', "split_type must be 'equal'");
  if (!Number.isInteger(ways)) return sendError(res, 'VALIDATION_ERROR', 'ways must be an integer');

  const [result, settings] = await Promise.all([
    splitService.splitEqual(req.auth!.venueId, req.auth!.userId, req.params.id, ways),
    getSettingsRow(req.auth!.venueId),
  ]);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value.map(o => serializeOrder(o, settings?.pmsEnabled)));
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
