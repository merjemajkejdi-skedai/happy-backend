import { randomUUID } from 'crypto';
import { query } from '../db/connection';

// order_events is append-only — this is the only place that inserts into it.
// Never update or delete a row once written.
export async function recordOrderEvent(
  orderId: string,
  venueId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdBy: string | null,
): Promise<void> {
  await query(
    `INSERT INTO order_events (id, order_id, venue_id, event_type, payload, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), orderId, venueId, eventType, JSON.stringify(payload), createdBy],
  );
}
