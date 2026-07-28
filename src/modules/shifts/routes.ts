import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { parsePagination, buildPaginationMeta } from '../../lib/pagination';
import * as shiftsService from './shiftsService';

export const shiftsRouter = Router();
shiftsRouter.use(authenticate, venueScope);

shiftsRouter.post('/open', requirePermission('shift.manage'), async (req: Request, res: Response) => {
  const { name, opening_float } = req.body ?? {};
  const result = await shiftsService.openShift(req.auth!.venueId, req.auth!.userId, { name: name ?? null, openingFloat: opening_float ?? null });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

shiftsRouter.post('/close', requirePermission('shift.manage'), async (req: Request, res: Response) => {
  const { closing_cash_counted, notes } = req.body ?? {};
  const force = req.query.force === 'true';
  const result = await shiftsService.closeShift(
    req.auth!.venueId,
    req.auth!.userId,
    { closingCashCounted: closing_cash_counted ?? null, notes: notes ?? null },
    force,
  );
  if (!result.ok) {
    const details = result.openOrders ? { open_orders: result.openOrders } : undefined;
    return sendDomainError(res, result.error.status, result.error.code, result.error.message, details);
  }
  sendData(res, result.value);
});

// GET /current — before GET /:id, so the literal path isn't swallowed by
// the :id param route (same reasoning as voidsRouter's /pending).
shiftsRouter.get('/current', requirePermission('reports.view'), async (req: Request, res: Response) => {
  const result = await shiftsService.getCurrentShift(req.auth!.venueId);
  sendData(res, { shift: result.shift, flagged: result.flagged });
});

shiftsRouter.get('/', requirePermission('reports.view'), async (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string>;
  const { page, perPage } = parsePagination(req.query);
  const result = await shiftsService.listShifts(req.auth!.venueId, { from, to, page, perPage });
  sendData(res, result.shifts, buildPaginationMeta(result.page, result.perPage, result.total));
});

shiftsRouter.get('/:id', requirePermission('reports.view'), async (req: Request, res: Response) => {
  const shift = await shiftsService.getShift(req.auth!.venueId, req.params.id);
  if (!shift) return sendError(res, 'NOT_FOUND', 'Shift not found');
  sendData(res, shift);
});
