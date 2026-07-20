import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { roleGuard } from '../middleware/roleGuard';
import type { KitchenEvent, OrderItemStatus } from '../types';

export const kitchenRouter = Router();
kitchenRouter.use(requireAuth);

const ok  = <T>(res: Response, data: T) => res.json({ success: true, data });
const err = (res: Response, message: string, status = 400) => res.status(status).json({ success: false, error: message });

const ITEM_STATUSES: OrderItemStatus[] = ['in_progress', 'ready', 'delivered'];

async function listEvents(venueId: string, destination: 'kitchen' | 'bar') {
  return query<KitchenEvent>(
    'SELECT * FROM kitchen_events WHERE venue_id = $1 AND destination = $2 AND is_acknowledged = FALSE ORDER BY created_at ASC',
    [venueId, destination],
  );
}

kitchenRouter.get('/kitchen/events', roleGuard('kitchen', 'manager', 'admin'), async (req: Request, res: Response) => {
  try { ok(res, await listEvents(req.user!.venueId, 'kitchen')); }
  catch (e) { err(res, (e as Error).message, 500); }
});

kitchenRouter.get('/bar/events', roleGuard('bar', 'manager', 'admin'), async (req: Request, res: Response) => {
  try { ok(res, await listEvents(req.user!.venueId, 'bar')); }
  catch (e) { err(res, (e as Error).message, 500); }
});

async function acknowledge(req: Request, res: Response, destination: 'kitchen' | 'bar') {
  const user = req.user!;
  const { id } = req.params;
  try {
    const existing = await queryOne(
      'SELECT id FROM kitchen_events WHERE id = $1 AND venue_id = $2 AND destination = $3',
      [id, user.venueId, destination],
    );
    if (!existing) return err(res, 'Event not found', 404);
    await query(
      'UPDATE kitchen_events SET is_acknowledged = TRUE, acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2',
      [user.staffId, id],
    );
    const row = await queryOne<KitchenEvent>('SELECT * FROM kitchen_events WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
}

kitchenRouter.put('/kitchen/events/:id/acknowledge', roleGuard('kitchen', 'manager', 'admin'), (req, res) => acknowledge(req, res, 'kitchen'));
kitchenRouter.put('/bar/events/:id/acknowledge', roleGuard('bar', 'manager', 'admin'), (req, res) => acknowledge(req, res, 'bar'));

// Kitchen/bar staff mark an individual item's prep status.
kitchenRouter.put('/order-items/:id/status', roleGuard('kitchen', 'bar', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!ITEM_STATUSES.includes(status)) return err(res, `status must be one of: ${ITEM_STATUSES.join(', ')}`);
  try {
    const existing = await queryOne('SELECT id FROM order_items WHERE id = $1 AND venue_id = $2', [id, user.venueId]);
    if (!existing) return err(res, 'Order item not found', 404);
    await query('UPDATE order_items SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    const row = await queryOne('SELECT id, order_id, name, quantity, status, destination FROM order_items WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
});
