import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { roleGuard } from '../middleware/roleGuard';
import { sendData, sendError } from '../lib/response';
import type { RestaurantTable } from '../types';

export const tablesRouter = Router();
tablesRouter.use(requireAuth);

const STATUSES = ['available', 'occupied', 'bill_requested', 'reserved', 'closed'];

tablesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await query<RestaurantTable>(
      'SELECT * FROM tables WHERE venue_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, number ASC',
      [req.user!.venueId],
    );
    sendData(res, rows, { count: rows.length });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

tablesRouter.post('/', roleGuard('manager', 'admin'), async (req: Request, res: Response) => {
  const { number, name, section, capacity = 4, sort_order = 0 } = req.body ?? {};
  if (number == null && !name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'number or name is required');
  try {
    const id = randomUUID();
    await query(
      `INSERT INTO tables (id, venue_id, number, name, section, capacity, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.user!.venueId, number ?? null, name?.trim() || null, section?.trim() || null, Number(capacity), Number(sort_order)],
    );
    const row = await queryOne<RestaurantTable>('SELECT * FROM tables WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

tablesRouter.put('/:id', roleGuard('manager', 'admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { number, name, section, capacity, sort_order } = req.body ?? {};
  try {
    const existing = await queryOne('SELECT id FROM tables WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Table not found');
    await query(
      `UPDATE tables SET
        number = COALESCE($1, number), name = COALESCE($2, name), section = COALESCE($3, section),
        capacity = COALESCE($4, capacity), sort_order = COALESCE($5, sort_order), updated_at = NOW()
       WHERE id = $6`,
      [number ?? null, name?.trim() ?? null, section?.trim() ?? null,
       capacity != null ? Number(capacity) : null, sort_order != null ? Number(sort_order) : null, id],
    );
    const row = await queryOne<RestaurantTable>('SELECT * FROM tables WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

tablesRouter.put('/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!STATUSES.includes(status)) return sendError(res, 'VALIDATION_ERROR', `status must be one of: ${STATUSES.join(', ')}`);
  try {
    const existing = await queryOne('SELECT id FROM tables WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Table not found');
    await query('UPDATE tables SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    const row = await queryOne<RestaurantTable>('SELECT * FROM tables WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

tablesRouter.delete('/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT id FROM tables WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Table not found');
    await query('UPDATE tables SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    sendData(res, { deleted: true });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});
