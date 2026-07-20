import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { roleGuard } from '../middleware/roleGuard';
import { sendData, sendError } from '../lib/response';
import { recordOrderEvent } from '../lib/orderEvents';
import type { KitchenEvent, OrderItemStatus } from '../types';

export const kitchenRouter = Router();
kitchenRouter.use(requireAuth);

const ITEM_STATUSES: OrderItemStatus[] = ['in_progress', 'ready', 'delivered'];

async function listEvents(venueId: string, destination: 'kitchen' | 'bar') {
  return query<KitchenEvent>(
    'SELECT * FROM kitchen_events WHERE venue_id = $1 AND destination = $2 AND is_acknowledged = FALSE ORDER BY created_at ASC',
    [venueId, destination],
  );
}

kitchenRouter.get('/kitchen/events', roleGuard('kitchen', 'manager', 'admin'), async (req: Request, res: Response) => {
  try {
    const rows = await listEvents(req.user!.venueId, 'kitchen');
    sendData(res, rows, { count: rows.length });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

kitchenRouter.get('/bar/events', roleGuard('bar', 'manager', 'admin'), async (req: Request, res: Response) => {
  try {
    const rows = await listEvents(req.user!.venueId, 'bar');
    sendData(res, rows, { count: rows.length });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

async function acknowledge(req: Request, res: Response, destination: 'kitchen' | 'bar') {
  const user = req.user!;
  const { id } = req.params;
  try {
    const existing = await queryOne<KitchenEvent>(
      'SELECT id, order_id FROM kitchen_events WHERE id = $1 AND venue_id = $2 AND destination = $3',
      [id, user.venueId, destination],
    );
    if (!existing) return sendError(res, 'NOT_FOUND', 'Event not found');
    await query(
      'UPDATE kitchen_events SET is_acknowledged = TRUE, acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2',
      [user.staffId, id],
    );
    await recordOrderEvent(existing.order_id, user.venueId, 'kitchen_event_acknowledged', { kitchen_event_id: id, destination }, user.staffId);
    const row = await queryOne<KitchenEvent>('SELECT * FROM kitchen_events WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
}

kitchenRouter.put('/kitchen/events/:id/acknowledge', roleGuard('kitchen', 'manager', 'admin'), (req, res) => acknowledge(req, res, 'kitchen'));
kitchenRouter.put('/bar/events/:id/acknowledge', roleGuard('bar', 'manager', 'admin'), (req, res) => acknowledge(req, res, 'bar'));

// Kitchen/bar staff mark an individual item's prep status.
kitchenRouter.put('/order-items/:id/status', roleGuard('kitchen', 'bar', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!ITEM_STATUSES.includes(status)) return sendError(res, 'VALIDATION_ERROR', `status must be one of: ${ITEM_STATUSES.join(', ')}`);
  try {
    const existing = await queryOne<{ id: string; order_id: string }>(
      'SELECT id, order_id FROM order_items WHERE id = $1 AND venue_id = $2', [id, user.venueId],
    );
    if (!existing) return sendError(res, 'NOT_FOUND', 'Order item not found');
    await query('UPDATE order_items SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    await recordOrderEvent(existing.order_id, user.venueId, 'order_item_status_changed', { order_item_id: id, status }, user.staffId);
    const row = await queryOne('SELECT id, order_id, name, quantity, status, destination FROM order_items WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});
