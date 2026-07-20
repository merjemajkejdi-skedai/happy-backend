import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { pool, query, queryOne } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { roleGuard } from '../middleware/roleGuard';
import { sendData, sendError } from '../lib/response';
import { recordOrderEvent } from '../lib/orderEvents';
import type { Order, OrderItem, RestaurantTable, MenuItem, MenuCategory, RestaurantSettings } from '../types';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

async function getSettings(venueId: string): Promise<RestaurantSettings> {
  const settings = await queryOne<RestaurantSettings>('SELECT * FROM restaurant_settings WHERE venue_id = $1', [venueId]);
  if (!settings) throw new Error(`restaurant_settings missing for venue ${venueId}`);
  return settings;
}

async function nextOrderNumber(venueId: string, date: string): Promise<number> {
  await query(
    `INSERT INTO order_sequences (venue_id, date, last_order_number, last_ticket_number)
     VALUES ($1, $2, 1, 0)
     ON CONFLICT (venue_id, date) DO UPDATE SET last_order_number = order_sequences.last_order_number + 1`,
    [venueId, date],
  );
  const row = await queryOne<{ last_order_number: number }>(
    'SELECT last_order_number FROM order_sequences WHERE venue_id = $1 AND date = $2', [venueId, date],
  );
  return Number(row!.last_order_number);
}

async function nextTicketNumber(venueId: string, date: string): Promise<number> {
  await query(
    `INSERT INTO order_sequences (venue_id, date, last_order_number, last_ticket_number)
     VALUES ($1, $2, 0, 1)
     ON CONFLICT (venue_id, date) DO UPDATE SET last_ticket_number = order_sequences.last_ticket_number + 1`,
    [venueId, date],
  );
  const row = await queryOne<{ last_ticket_number: number }>(
    'SELECT last_ticket_number FROM order_sequences WHERE venue_id = $1 AND date = $2', [venueId, date],
  );
  return Number(row!.last_ticket_number);
}

async function recalcTotals(orderId: string) {
  const items = await query<{ total_price: number }>(
    `SELECT total_price FROM order_items WHERE order_id = $1 AND status != 'voided'`, [orderId],
  );
  const subtotal = items.reduce((sum, it) => sum + Number(it.total_price), 0);
  const order = await queryOne<{ discount: number }>('SELECT discount FROM orders WHERE id = $1', [orderId]);
  const total = Math.max(0, subtotal - Number(order?.discount ?? 0));
  await query('UPDATE orders SET subtotal = $1, total = $2, updated_at = NOW() WHERE id = $3', [subtotal, total, orderId]);
}

// waiters only see/touch their own orders; manager/admin see everything venue-wide
function ownWaiterScope(role: string, staffId: string): string | null {
  return role === 'waiter' ? staffId : null;
}

ordersRouter.get('/', roleGuard('waiter', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { status, table_id, date, waiter_id } = req.query as Record<string, string>;
  try {
    const clauses: string[] = ['venue_id = $1'];
    const params: unknown[] = [user.venueId];

    const own = ownWaiterScope(user.role, user.staffId);
    if (own) { params.push(own); clauses.push(`waiter_id = $${params.length}`); }
    else if (waiter_id) { params.push(waiter_id); clauses.push(`waiter_id = $${params.length}`); }

    if (status)   { params.push(status);   clauses.push(`status = $${params.length}`); }
    if (table_id) { params.push(table_id); clauses.push(`table_id = $${params.length}`); }
    if (date)     { params.push(date);     clauses.push(`opened_at::date = $${params.length}`); }

    const rows = await query<Order>(
      `SELECT * FROM orders WHERE ${clauses.join(' AND ')} ORDER BY opened_at DESC`, params,
    );
    sendData(res, rows, { count: rows.length });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

ordersRouter.post('/', roleGuard('waiter', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { table_id = null, notes = null } = req.body ?? {};
  try {
    const settings = await getSettings(user.venueId);
    let table: RestaurantTable | undefined;
    if (table_id) {
      table = await queryOne<RestaurantTable>(
        'SELECT * FROM tables WHERE id = $1 AND venue_id = $2 AND is_active = TRUE', [table_id, user.venueId],
      );
      if (!table) return sendError(res, 'NOT_FOUND', 'Table not found');
    } else if (!settings.counter_service_enabled) {
      return sendError(res, 'VALIDATION_ERROR', 'Counter service is not enabled for this venue — table_id is required');
    }

    const date = new Date().toISOString().slice(0, 10);
    const orderNumber = await nextOrderNumber(user.venueId, date);
    const ticketNumber = table_id ? null : await nextTicketNumber(user.venueId, date);

    const id = randomUUID();
    await query(
      `INSERT INTO orders (id, venue_id, table_id, waiter_id, order_number, ticket_number, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, user.venueId, table_id, user.staffId, orderNumber, ticketNumber, notes],
    );
    if (table) {
      await query(`UPDATE tables SET status = 'occupied', current_order_id = $1, updated_at = NOW() WHERE id = $2`, [id, table.id]);
    }
    await recordOrderEvent(id, user.venueId, 'order_created', { table_id, order_number: orderNumber, ticket_number: ticketNumber }, user.staffId);

    const row = await queryOne<Order>('SELECT * FROM orders WHERE id = $1', [id]);
    sendData(res, row);
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

ordersRouter.get('/:id', roleGuard('waiter', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  try {
    const order = await queryOne<Order>('SELECT * FROM orders WHERE id = $1 AND venue_id = $2', [id, user.venueId]);
    if (!order) return sendError(res, 'NOT_FOUND', 'Order not found');
    if (ownWaiterScope(user.role, user.staffId) && order.waiter_id !== user.staffId) return sendError(res, 'NOT_FOUND', 'Order not found');
    const items = await query<OrderItem>(
      `SELECT * FROM order_items WHERE order_id = $1 AND status != 'voided' ORDER BY created_at ASC`, [id],
    );
    sendData(res, { ...order, items });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

// body: { items: [{ id?, menu_item_id?, quantity, notes? }] }
// - entries with an existing id: quantity<=0 removes it (only if still 'pending'), else updates quantity/notes
// - entries without an id: inserted as new 'pending' items, price + destination
//   resolved and snapshotted right now (later menu price changes never touch this order)
ordersRouter.put('/:id/items', roleGuard('waiter', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) return sendError(res, 'VALIDATION_ERROR', 'items array is required');

  try {
    const order = await queryOne<Order>('SELECT * FROM orders WHERE id = $1 AND venue_id = $2', [id, user.venueId]);
    if (!order) return sendError(res, 'NOT_FOUND', 'Order not found');
    if (ownWaiterScope(user.role, user.staffId) && order.waiter_id !== user.staffId) return sendError(res, 'NOT_FOUND', 'Order not found');
    if (order.status !== 'open') return sendError(res, 'VALIDATION_ERROR', 'Order is not open — cannot modify items');

    const settings = await getSettings(user.venueId);
    const changes: Array<Record<string, unknown>> = [];

    for (const entry of items) {
      if (entry.id) {
        const existing = await queryOne<OrderItem>('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [entry.id, id]);
        if (!existing) return sendError(res, 'NOT_FOUND', `Order item ${entry.id} not found`);
        if (existing.status !== 'pending') return sendError(res, 'VALIDATION_ERROR', `Order item ${entry.id} has already been sent — cannot edit`);
        const qty = entry.quantity != null ? Number(entry.quantity) : existing.quantity;
        if (qty <= 0) {
          await query('DELETE FROM order_items WHERE id = $1', [entry.id]);
          changes.push({ action: 'removed', order_item_id: entry.id, menu_item_id: existing.menu_item_id });
        } else {
          const totalPrice = Number(existing.unit_price) * qty;
          await query(
            'UPDATE order_items SET quantity = $1, total_price = $2, notes = $3, updated_at = NOW() WHERE id = $4',
            [qty, totalPrice, entry.notes !== undefined ? entry.notes : existing.notes, entry.id],
          );
          changes.push({ action: 'updated', order_item_id: entry.id, quantity: qty });
        }
      } else {
        if (!entry.menu_item_id) return sendError(res, 'VALIDATION_ERROR', 'menu_item_id is required for new items');
        const qty = Number(entry.quantity ?? 1);
        if (qty <= 0) continue;
        const menuItem = await queryOne<MenuItem>(
          'SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2 AND is_active = TRUE', [entry.menu_item_id, user.venueId],
        );
        if (!menuItem) return sendError(res, 'NOT_FOUND', `Menu item ${entry.menu_item_id} not found`);
        if (!menuItem.is_available) return sendError(res, 'VALIDATION_ERROR', `${menuItem.name} is not currently available`);
        const category = await queryOne<MenuCategory>('SELECT destination FROM menu_categories WHERE id = $1', [menuItem.category_id]);
        const destination = menuItem.destination_override || category?.destination || settings.default_item_destination;
        const unitPrice = Number(menuItem.price); // server-resolved snapshot — client-supplied prices are never trusted
        const totalPrice = unitPrice * qty;
        const newItemId = randomUUID();
        await query(
          `INSERT INTO order_items (id, order_id, venue_id, menu_item_id, name, unit_price, total_price, quantity, course, destination, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [newItemId, id, user.venueId, menuItem.id, menuItem.name, unitPrice, totalPrice, qty, menuItem.course, destination, entry.notes ?? null],
        );
        changes.push({ action: 'added', order_item_id: newItemId, menu_item_id: menuItem.id, quantity: qty });
      }
    }

    await recalcTotals(id);
    await recordOrderEvent(id, user.venueId, 'items_updated', { changes }, user.staffId);

    const updatedOrder = await queryOne<Order>('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await query<OrderItem>(
      `SELECT * FROM order_items WHERE order_id = $1 AND status != 'voided' ORDER BY created_at ASC`, [id],
    );
    sendData(res, { ...updatedOrder, items: updatedItems });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});

ordersRouter.post('/:id/send', roleGuard('waiter', 'manager', 'admin'), async (req: Request, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  try {
    const order = await queryOne<Order>('SELECT * FROM orders WHERE id = $1 AND venue_id = $2', [id, user.venueId]);
    if (!order) return sendError(res, 'NOT_FOUND', 'Order not found');
    if (ownWaiterScope(user.role, user.staffId) && order.waiter_id !== user.staffId) return sendError(res, 'NOT_FOUND', 'Order not found');

    const pending = await query<OrderItem>(`SELECT * FROM order_items WHERE order_id = $1 AND status = 'pending'`, [id]);
    if (pending.length === 0) return sendError(res, 'VALIDATION_ERROR', 'No pending items to send');

    let tableDisplay: string;
    if (order.table_id) {
      const table = await queryOne<RestaurantTable>('SELECT number, name FROM tables WHERE id = $1', [order.table_id]);
      tableDisplay = table?.name || (table?.number != null ? `Table ${table.number}` : 'Table');
    } else {
      tableDisplay = `Counter #${order.ticket_number}`;
    }

    const byDestination = new Map<string, OrderItem[]>();
    for (const it of pending) {
      const list = byDestination.get(it.destination) ?? [];
      list.push(it);
      byDestination.set(it.destination, list);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [destination, destItems] of byDestination) {
        if (destination === 'printer') continue; // no printer integration in Phase 1
        const eventItems = destItems.map(it => ({ name: it.name, quantity: it.quantity, notes: it.notes, course: it.course }));
        await client.query(
          `INSERT INTO kitchen_events (id, venue_id, order_id, table_id, table_display, event_type, destination, items)
           VALUES ($1, $2, $3, $4, $5, 'new_items', $6, $7)`,
          [randomUUID(), user.venueId, id, order.table_id, tableDisplay, destination, JSON.stringify(eventItems)],
        );
      }
      const ids = pending.map(it => it.id);
      await client.query(
        `UPDATE order_items SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      await client.query(
        `INSERT INTO order_events (id, order_id, venue_id, event_type, payload, created_by) VALUES ($1, $2, $3, 'items_sent', $4, $5)`,
        [randomUUID(), id, user.venueId, JSON.stringify({ order_item_ids: ids, destinations: [...byDestination.keys()] }), user.staffId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const updatedOrder = await queryOne<Order>('SELECT * FROM orders WHERE id = $1', [id]);
    const updatedItems = await query<OrderItem>(
      `SELECT * FROM order_items WHERE order_id = $1 AND status != 'voided' ORDER BY created_at ASC`, [id],
    );
    sendData(res, { ...updatedOrder, items: updatedItems });
  } catch (e) { sendError(res, 'INTERNAL_ERROR', (e as Error).message); }
});
