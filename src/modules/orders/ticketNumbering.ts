import { computeBusinessDate, type Tx } from './validation';

export interface AllocatedNumbers {
  orderNumber: number;
  ticketCounterValue: number | null;
}

// order_number must never repeat for a venue — it's the internal order
// identifier and is backed by the global unique index
// orders_venue_id_order_number_key on (venue_id, order_number), with no
// business_date component. It is allocated from the perpetual row (the same
// 1970-01-01 sentinel date computeBusinessDate() uses for
// ticket_number_reset='never') regardless of the venue's own
// ticket_number_reset setting — order_number itself is never subject to that
// setting, only ticket_number is.
//
// ticket_number is the guest-facing counter (e.g. "B12") and is allowed to
// repeat across business days by design — it's allocated from the row keyed
// by the venue's actual business date, which may reset daily.
//
// Each allocation is its own atomic INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING — race-free on its own, no separate existence check, no
// COUNT(*)/MAX() scan. Both run inside the same transaction as the order
// insert, so the pair is still atomic with respect to rollback even though
// they're two round trips instead of one.
const PERPETUAL_DATE = '1970-01-01';

export async function allocateNumbers(
  tx: Tx,
  venueId: string,
  timezone: string,
  ticketNumberReset: string,
  needsTicket: boolean,
): Promise<AllocatedNumbers> {
  const orderRows = await tx.$queryRaw<{ last_order_number: number }[]>`
    INSERT INTO ticket_counters (venue_id, business_date, last_order_number, last_ticket_number)
    VALUES (${venueId}::uuid, ${PERPETUAL_DATE}::date, 1, 0)
    ON CONFLICT (venue_id, business_date)
    DO UPDATE SET last_order_number = ticket_counters.last_order_number + 1
    RETURNING last_order_number
  `;
  const orderNumber = orderRows[0].last_order_number;

  if (!needsTicket) {
    return { orderNumber, ticketCounterValue: null };
  }

  const businessDate = computeBusinessDate(timezone, ticketNumberReset);
  const ticketRows = await tx.$queryRaw<{ last_ticket_number: number }[]>`
    INSERT INTO ticket_counters (venue_id, business_date, last_order_number, last_ticket_number)
    VALUES (${venueId}::uuid, ${businessDate}::date, 0, 1)
    ON CONFLICT (venue_id, business_date)
    DO UPDATE SET last_ticket_number = ticket_counters.last_ticket_number + 1
    RETURNING last_ticket_number
  `;
  return { orderNumber, ticketCounterValue: ticketRows[0].last_ticket_number };
}

// ticket_number = ticket_number_prefix + zero-padded counter. Width isn't
// spec'd — 4 digits is a plain, generous default for a single-venue daily
// counter that comfortably avoids ambiguity.
const TICKET_NUMBER_WIDTH = 4;

export function formatTicketNumber(prefix: string, counterValue: number): string {
  return `${prefix}${String(counterValue).padStart(TICKET_NUMBER_WIDTH, '0')}`;
}
