import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import * as voidService from '../orders/voidService';

export const voidsRouter = Router();
voidsRouter.use(authenticate, venueScope);

// GET /voids — before GET /voids/:id, and GET /voids/pending — before the
// same, so the literal path isn't swallowed by the :id param route.
voidsRouter.get('/pending', requirePermission('void.approve'), async (req: Request, res: Response) => {
  const { page, perPage } = parsePagination(req.query);
  const result = await voidService.listPendingVoids(req.auth!.venueId, page, perPage);
  sendData(res, result.logs, buildPaginationMeta(result.page, result.perPage, result.total));
});

voidsRouter.get('/', requirePermission('reports.view'), async (req: Request, res: Response) => {
  const { from, to, status, user_id } = req.query as Record<string, string>;
  const { page, perPage } = parsePagination(req.query);
  const result = await voidService.listVoids(req.auth!.venueId, { from, to, status, userId: user_id, page, perPage });
  sendData(res, result.logs, buildPaginationMeta(result.page, result.perPage, result.total));
});

voidsRouter.get('/:id', requirePermission('reports.view'), async (req: Request, res: Response) => {
  const voidLog = await voidService.getVoid(req.auth!.venueId, req.params.id);
  if (!voidLog) return sendError(res, 'NOT_FOUND', 'Void request not found');
  sendData(res, voidLog);
});

voidsRouter.post('/:id/approve', requirePermission('void.approve'), async (req: Request, res: Response) => {
  const result = await voidService.approveVoid(req.auth!.venueId, req.auth!.userId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

voidsRouter.post('/:id/reject', requirePermission('void.approve'), async (req: Request, res: Response) => {
  const { rejection_reason } = req.body ?? {};
  const result = await voidService.rejectVoid(req.auth!.venueId, req.auth!.userId, req.params.id, rejection_reason);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});
