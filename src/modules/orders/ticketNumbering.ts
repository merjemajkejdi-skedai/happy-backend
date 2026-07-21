import { computeBusinessDate, type Tx } from './validation';

export interface AllocatedNumbers {
  orderNumber: number;
  ticketCounterValue: number | null;
}

// Atomic, race-free allocation: a single INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING both creates the (venue_id, business_date) row if missing and
// increments it, in one statement — no separate existence check, no
// COUNT(*)/MAX() scan, no gap between "does the row exist" and "increment
// it" for concurrent creates to race in. Must run inside the same
// transaction as the order insert.
//
// order_number always advances (every order needs one); the ticket counter
// only advances when this order actually needs a ticket_number (counter
// service) — the two are independent sequences sharing a row, which is why
// the schema keeps last_order_number and last_ticket_number as separate
// columns instead of one shared counter.
export async function allocateNumbers(
  tx: Tx,
  venueId: string,
  timezone: string,
  ticketNumberReset: string,
  needsTicket: boolean,
): Promise<AllocatedNumbers> {
  const businessDate = computeBusinessDate(timezone, ticketNumberReset);
  const rows = await tx.$queryRaw<{ last_order_number: number; last_ticket_number: number }[]>`
    INSERT INTO ticket_counters (venue_id, business_date, last_order_number, last_ticket_number)
    VALUES (${venueId}::uuid, ${businessDate}::date, 1, CASE WHEN ${needsTicket} THEN 1 ELSE 0 END)
    ON CONFLICT (venue_id, business_date)
    DO UPDATE SET
      last_order_number = ticket_counters.last_order_number + 1,
      last_ticket_number = ticket_counters.last_ticket_number + CASE WHEN ${needsTicket} THEN 1 ELSE 0 END
    RETURNING last_order_number, last_ticket_number
  `;
  const row = rows[0];
  return {
    orderNumber: row.last_order_number,
    ticketCounterValue: needsTicket ? row.last_ticket_number : null,
  };
}

// ticket_number = ticket_number_prefix + zero-padded counter. Width isn't
// spec'd — 4 digits is a plain, generous default for a single-venue daily
// counter that comfortably avoids ambiguity.
const TICKET_NUMBER_WIDTH = 4;

export function formatTicketNumber(prefix: string, counterValue: number): string {
  return `${prefix}${String(counterValue).padStart(TICKET_NUMBER_WIDTH, '0')}`;
}
