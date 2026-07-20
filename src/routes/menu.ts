import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { roleGuard } from '../middleware/roleGuard';
import { sendData, sendError } from '../lib/response';
import type { MenuCategory, MenuItem } from '../types';

export const menuRouter = Router();
menuRouter.use(requireAuth);

const DESTINATIONS = ['kitchen', 'bar', 'printer'];

// ── Categories ───────────────────────────────────────────────────────────────

menuRouter.get('/categories', async (req: Request, res: Response) => {
  try {
    const rows = await query<MenuCategory>(
      'SELECT * FROM menu_categories WHERE venue_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, name ASC',
      [req.user!.venueId],
    );
    sendData(res, rows, { count: rows.length });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

menuRouter.post('/categories', roleGuard('admin'), async (req: Request, res: Response) => {
  const { name, description, destination = 'kitchen', sort_order = 0 } = req.body ?? {};
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');
  if (!DESTINATIONS.includes(destination)) return sendError(res, 'VALIDATION_ERROR', `destination must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const id = randomUUID();
    await query(
      `INSERT INTO menu_categories (id, venue_id, name, description, destination, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user!.venueId, name.trim(), description ?? null, destination, Number(sort_order)],
    );
    const row = await queryOne<MenuCategory>('SELECT * FROM menu_categories WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

menuRouter.put('/categories/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, destination, sort_order } = req.body ?? {};
  if (destination && !DESTINATIONS.includes(destination)) return sendError(res, 'VALIDATION_ERROR', `destination must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const existing = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Category not found');
    await query(
      `UPDATE menu_categories SET
        name = COALESCE($1, name), description = COALESCE($2, description),
        destination = COALESCE($3, destination), sort_order = COALESCE($4, sort_order), updated_at = NOW()
       WHERE id = $5`,
      [name?.trim() ?? null, description ?? null, destination ?? null, sort_order != null ? Number(sort_order) : null, id],
    );
    const row = await queryOne<MenuCategory>('SELECT * FROM menu_categories WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

menuRouter.delete('/categories/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Category not found');
    await query('UPDATE menu_categories SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    sendData(res, { deleted: true });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

// ── Items ────────────────────────────────────────────────────────────────────

menuRouter.get('/items', async (req: Request, res: Response) => {
  const { category_id } = req.query as Record<string, string>;
  try {
    const rows = category_id
      ? await query<MenuItem>(
          'SELECT * FROM menu_items WHERE venue_id = $1 AND category_id = $2 AND is_active = TRUE ORDER BY sort_order ASC, name ASC',
          [req.user!.venueId, category_id],
        )
      : await query<MenuItem>(
          'SELECT * FROM menu_items WHERE venue_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, name ASC',
          [req.user!.venueId],
        );
    sendData(res, rows, { count: rows.length });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

menuRouter.post('/items', roleGuard('admin'), async (req: Request, res: Response) => {
  const { category_id, name, description, price, destination_override, course, sort_order = 0 } = req.body ?? {};
  if (!category_id) return sendError(res, 'VALIDATION_ERROR', 'category_id is required');
  if (!name?.trim()) return sendError(res, 'VALIDATION_ERROR', 'name is required');
  if (price == null || Number.isNaN(Number(price)) || Number(price) < 0) return sendError(res, 'VALIDATION_ERROR', 'price must be a non-negative number');
  if (destination_override && !DESTINATIONS.includes(destination_override)) return sendError(res, 'VALIDATION_ERROR', `destination_override must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const category = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [category_id, req.user!.venueId]);
    if (!category) return sendError(res, 'NOT_FOUND', 'Category not found');
    const id = randomUUID();
    await query(
      `INSERT INTO menu_items (id, venue_id, category_id, name, description, price, destination_override, course, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, req.user!.venueId, category_id, name.trim(), description ?? null, Number(price),
       destination_override ?? null, course ?? null, Number(sort_order)],
    );
    const row = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

menuRouter.put('/items/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { category_id, name, description, price, destination_override, course, sort_order } = req.body ?? {};
  if (destination_override && !DESTINATIONS.includes(destination_override)) return sendError(res, 'VALIDATION_ERROR', `destination_override must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const existing = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Item not found');
    if (category_id) {
      const category = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [category_id, req.user!.venueId]);
      if (!category) return sendError(res, 'NOT_FOUND', 'Category not found');
    }
    await query(
      `UPDATE menu_items SET
        category_id = COALESCE($1, category_id), name = COALESCE($2, name), description = COALESCE($3, description),
        price = COALESCE($4, price), destination_override = $5, course = $6, sort_order = COALESCE($7, sort_order),
        updated_at = NOW()
       WHERE id = $8`,
      [category_id ?? null, name?.trim() ?? null, description ?? null, price != null ? Number(price) : null,
       destination_override !== undefined ? destination_override : existing.destination_override,
       course !== undefined ? course : existing.course,
       sort_order != null ? Number(sort_order) : null, id],
    );
    const row = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

// Toggle availability mid-service ("86" an item) — manager + admin.
menuRouter.put('/items/:id/availability', roleGuard('manager', 'admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { is_available } = req.body ?? {};
  if (typeof is_available !== 'boolean') return sendError(res, 'VALIDATION_ERROR', 'is_available (boolean) is required');
  try {
    const existing = await queryOne('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Item not found');
    await query('UPDATE menu_items SET is_available = $1, updated_at = NOW() WHERE id = $2', [is_available, id]);
    const row = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

menuRouter.delete('/items/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return sendError(res, 'NOT_FOUND', 'Item not found');
    await query('UPDATE menu_items SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    sendData(res, { deleted: true });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});
