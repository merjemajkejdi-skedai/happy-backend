import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as displaysService from './service';

export const displaysRouter = Router();
displaysRouter.use(authenticate, venueScope);

function parseDisplayQuery(req: Request) {
  const { course_number, include_ready } = req.query as Record<string, string>;
  return {
    courseNumber: course_number !== undefined ? Number(course_number) : undefined,
    includeReady: include_ready === 'true',
  };
}

displaysRouter.get('/kitchen', requirePermission('display.view'), async (req: Request, res: Response) => {
  const result = await displaysService.getDisplay(req.auth!.venueId, 'kitchen', parseDisplayQuery(req));
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { tickets: result.value.tickets }, result.value.meta as unknown as Record<string, unknown>);
});

displaysRouter.get('/bar', requirePermission('display.view'), async (req: Request, res: Response) => {
  const result = await displaysService.getDisplay(req.auth!.venueId, 'bar', parseDisplayQuery(req));
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { tickets: result.value.tickets }, result.value.meta as unknown as Record<string, unknown>);
});

displaysRouter.get('/recall', requirePermission('display.bump'), async (req: Request, res: Response) => {
  const result = await displaysService.getRecallDisplay(req.auth!.venueId);
  sendData(res, { tickets: result.tickets }, result.meta as unknown as Record<string, unknown>);
});

displaysRouter.patch('/items/:itemId/status', requirePermission('display.bump'), async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!status) return sendError(res, 'VALIDATION_ERROR', 'status is required');
  const result = await displaysService.updateItemStatus(req.auth!.venueId, req.auth!.userId, req.params.itemId, status);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { updated: true });
});

displaysRouter.post('/bump', requirePermission('display.bump'), async (req: Request, res: Response) => {
  const { order_item_ids, order_id, status } = req.body ?? {};
  const result = await displaysService.bumpItems(req.auth!.venueId, req.auth!.userId, {
    orderItemIds: order_item_ids,
    orderId: order_id,
    status,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

displaysRouter.post('/items/:itemId/recall', requirePermission('display.bump'), async (req: Request, res: Response) => {
  const result = await displaysService.recallItem(req.auth!.venueId, req.auth!.userId, req.params.itemId);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, { recalled: true });
});
