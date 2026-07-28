import { Router, Request, Response } from 'express';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import { runIdempotent } from '../../lib/idempotency';
import * as paymentsService from './paymentsService';
import type { PaymentMethod } from '../../generated/prisma/client';

const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'voucher', 'room_charge', 'other'];

// mergeParams: true — mounted at /orders/:id, same as lifecycleRouter/coursesRouter/splitRouter/mergeRouter.
export const paymentsRouter = Router({ mergeParams: true });

paymentsRouter.post('/payments', requirePermission('order.payment'), async (req: Request, res: Response) => {
  const { method, amount, tip_amount, reference, received_amount } = req.body ?? {};
  if (!PAYMENT_METHODS.includes(method)) {
    return sendError(res, 'VALIDATION_ERROR', `method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  if (typeof amount !== 'number' && typeof amount !== 'string') {
    return sendError(res, 'VALIDATION_ERROR', 'amount is required');
  }

  await runIdempotent(req, res, 'POST /orders/:id/payments', async () => {
    const result = await paymentsService.createPayment(req.auth!.venueId, req.auth!.userId, req.params.id, {
      method,
      amount,
      tipAmount: tip_amount ?? null,
      reference: reference ?? null,
      receivedAmount: received_amount ?? null,
    });
    if (!result.ok) return { status: result.error.status, body: { error: { code: result.error.code, message: result.error.message } } };
    return { status: 200, body: { data: result.value, meta: {} } };
  });
});

paymentsRouter.get('/payments', requirePermission('order.view_own'), async (req: Request, res: Response) => {
  const result = await paymentsService.listPayments(req.auth!.venueId, req.params.id);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});

paymentsRouter.delete('/payments/:pid', requirePermission('order.payment_void'), async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  if (!reason || typeof reason !== 'string') {
    return sendError(res, 'VALIDATION_ERROR', 'reason is required to void a payment');
  }

  const result = await paymentsService.voidPayment(req.auth!.venueId, req.auth!.userId, req.params.id, req.params.pid, reason);
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, result.value);
});
