import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { roleGuard } from '../middleware/roleGuard';
import type { MenuCategory, MenuItem } from '../types';

export const menuRouter = Router();
menuRouter.use(requireAuth);

const ok  = <T>(res: Response, data: T) => res.json({ success: true, data });
const err = (res: Response, message: string, status = 400) => res.status(status).json({ success: false, error: message });

const DESTINATIONS = ['kitchen', 'bar', 'printer'];

// ── Categories ───────────────────────────────────────────────────────────────

menuRouter.get('/categories', async (req: Request, res: Response) => {
  try {
    const rows = await query<MenuCategory>(
      'SELECT * FROM menu_categories WHERE venue_id = $1 AND is_active = TRUE ORDER BY sort_order ASC, name ASC',
      [req.user!.venueId],
    );
    ok(res, rows);
  } catch (e) { err(res, (e as Error).message, 500); }
});

menuRouter.post('/categories', roleGuard('admin'), async (req: Request, res: Response) => {
  const { name, description, destination = 'kitchen', sort_order = 0 } = req.body ?? {};
  if (!name?.trim()) return err(res, 'name is required');
  if (!DESTINATIONS.includes(destination)) return err(res, `destination must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const id = randomUUID();
    await query(
      `INSERT INTO menu_categories (id, venue_id, name, description, destination, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user!.venueId, name.trim(), description ?? null, destination, Number(sort_order)],
    );
    const row = await queryOne<MenuCategory>('SELECT * FROM menu_categories WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
});

menuRouter.put('/categories/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, destination, sort_order } = req.body ?? {};
  if (destination && !DESTINATIONS.includes(destination)) return err(res, `destination must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const existing = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return err(res, 'Category not found', 404);
    await query(
      `UPDATE menu_categories SET
        name = COALESCE($1, name), description = COALESCE($2, description),
        destination = COALESCE($3, destination), sort_order = COALESCE($4, sort_order), updated_at = NOW()
       WHERE id = $5`,
      [name?.trim() ?? null, description ?? null, destination ?? null, sort_order != null ? Number(sort_order) : null, id],
    );
    const row = await queryOne<MenuCategory>('SELECT * FROM menu_categories WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
});

menuRouter.delete('/categories/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return err(res, 'Category not found', 404);
    await query('UPDATE menu_categories SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    ok(res, { deleted: true });
  } catch (e) { err(res, (e as Error).message, 500); }
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
    ok(res, rows);
  } catch (e) { err(res, (e as Error).message, 500); }
});

menuRouter.post('/items', roleGuard('admin'), async (req: Request, res: Response) => {
  const { category_id, name, description, price, destination_override, course, sort_order = 0 } = req.body ?? {};
  if (!category_id) return err(res, 'category_id is required');
  if (!name?.trim()) return err(res, 'name is required');
  if (price == null || Number.isNaN(Number(price)) || Number(price) < 0) return err(res, 'price must be a non-negative number');
  if (destination_override && !DESTINATIONS.includes(destination_override)) return err(res, `destination_override must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const category = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [category_id, req.user!.venueId]);
    if (!category) return err(res, 'Category not found', 404);
    const id = randomUUID();
    await query(
      `INSERT INTO menu_items (id, venue_id, category_id, name, description, price, destination_override, course, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, req.user!.venueId, category_id, name.trim(), description ?? null, Number(price),
       destination_override ?? null, course ?? null, Number(sort_order)],
    );
    const row = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
});

menuRouter.put('/items/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { category_id, name, description, price, destination_override, course, sort_order } = req.body ?? {};
  if (destination_override && !DESTINATIONS.includes(destination_override)) return err(res, `destination_override must be one of: ${DESTINATIONS.join(', ')}`);
  try {
    const existing = await queryOne('SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return err(res, 'Item not found', 404);
    if (category_id) {
      const category = await queryOne('SELECT id FROM menu_categories WHERE id = $1 AND venue_id = $2', [category_id, req.user!.venueId]);
      if (!category) return err(res, 'Category not found', 404);
    }
    await query(
      `UPDATE menu_items SET
        category_id = COALESCE($1, category_id), name = COALESCE($2, name), description = COALESCE($3, description),
        price = COALESCE($4, price), destination_override = $5, course = $6, sort_order = COALESCE($7, sort_order),
        updated_at = NOW()
       WHERE id = $8`,
      [category_id ?? null, name?.trim() ?? null, description ?? null, price != null ? Number(price) : null,
       destination_override !== undefined ? destination_override : (existing as any).destination_override,
       course !== undefined ? course : (existing as any).course,
       sort_order != null ? Number(sort_order) : null, id],
    );
    const row = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
});

// Toggle availability mid-service ("86" an item) — manager + admin.
menuRouter.put('/items/:id/availability', roleGuard('manager', 'admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { is_available } = req.body ?? {};
  if (typeof is_available !== 'boolean') return err(res, 'is_available (boolean) is required');
  try {
    const existing = await queryOne('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return err(res, 'Item not found', 404);
    await query('UPDATE menu_items SET is_available = $1, updated_at = NOW() WHERE id = $2', [is_available, id]);
    const row = await queryOne<MenuItem>('SELECT * FROM menu_items WHERE id = $1', [id]);
    ok(res, row);
  } catch (e) { err(res, (e as Error).message, 500); }
});

menuRouter.delete('/items/:id', roleGuard('admin'), async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT id FROM menu_items WHERE id = $1 AND venue_id = $2', [id, req.user!.venueId]);
    if (!existing) return err(res, 'Item not found', 404);
    await query('UPDATE menu_items SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    ok(res, { deleted: true });
  } catch (e) { err(res, (e as Error).message, 500); }
});
