import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { venueScope } from '../../middleware/venueScope';
import { requirePermission } from '../../middleware/rbac';
import { sendData, sendDomainError, sendError } from '../../lib/response';
import * as ordersService from './ordersService';
import { serializeOrder } from './serializers';
import { orderItemsRouter } from './orderItemsRoutes';
import { lifecycleRouter } from './lifecycleRoutes';
import type { OrderStatus, ServiceMode } from '../../generated/prisma/client';

export const ordersRouter = Router();
ordersRouter.use(authenticate, venueScope);

const ORDER_STATUSES: OrderStatus[] = ['draft', 'open', 'sent', 'partially_served', 'served', 'closed', 'cancelled'];
const SERVICE_MODES: ServiceMode[] = ['table', 'counter'];

ordersRouter.get('/', async (req: Request, res: Response) => {
  const { status, table_id, service_mode, mine, date, page, limit } = req.query as Record<string, string>;
  if (status && !ORDER_STATUSES.includes(status as OrderStatus)) {
    return sendError(res, 'VALIDATION_ERROR', `status must be one of: ${ORDER_STATUSES.join(', ')}`);
  }
  if (service_mode && !SERVICE_MODES.includes(service_mode as ServiceMode)) {
    return sendError(res, 'VALIDATION_ERROR', `service_mode must be one of: ${SERVICE_MODES.join(', ')}`);
  }

  const result = await ordersService.listOrders(req.auth!.venueId, req.auth!.userId, {
    status: status as OrderStatus | undefined,
    tableId: table_id,
    serviceMode: service_mode as ServiceMode | undefined,
    mine: mine === 'true',
    date,
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
  });
  sendData(res, result.orders.map(serializeOrder), { page: result.page, limit: result.limit, total: result.total });
});

ordersRouter.post('/', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { service_mode, table_id, guest_count, customer_name, notes } = req.body ?? {};
  if (!service_mode) return sendError(res, 'VALIDATION_ERROR', 'service_mode is required');

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const result = await ordersService.createOrder(
    req.auth!.venueId,
    req.auth!.userId,
    {
      serviceMode: service_mode,
      tableId: table_id ?? null,
      guestCount: guest_count ?? null,
      customerName: customer_name ?? null,
      notes: notes ?? null,
    },
    idempotencyKey,
  );
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value));
});

ordersRouter.get('/:id', async (req: Request, res: Response) => {
  const order = await ordersService.getOrder(req.auth!.venueId, req.params.id);
  if (!order) return sendError(res, 'NOT_FOUND', 'Order not found');
  sendData(res, serializeOrder(order));
});

ordersRouter.patch('/:id', requirePermission('order.create'), async (req: Request, res: Response) => {
  const { guest_count, customer_name, notes } = req.body ?? {};
  const result = await ordersService.updateOrder(req.auth!.venueId, req.auth!.userId, req.params.id, {
    guestCount: guest_count,
    customerName: customer_name,
    notes,
  });
  if (!result.ok) return sendDomainError(res, result.error.status, result.error.code, result.error.message);
  sendData(res, serializeOrder(result.value));
});

ordersRouter.use('/:id/items', orderItemsRouter);
ordersRouter.use('/:id', lifecycleRouter);
