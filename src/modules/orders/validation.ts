import { prisma } from '../../db/prisma';
import { scopedPrisma } from '../../middleware/venueScope';
import type { RestaurantSettings, Venue } from '../../generated/prisma/client';

// The interactive-transaction callback parameter type for the venueScope
// *extended* client doesn't structurally match Prisma's own (base, non-
// extended) `Prisma.TransactionClient` — the extension's generic Args
// wrapper breaks assignability in both directions. Deriving it straight from
// scopedPrisma.$transaction's own callback signature sidesteps that fight
// entirely and stays exact if the extension ever changes.
export type Tx = Parameters<Parameters<typeof scopedPrisma.$transaction>[0]>[0];

export interface OrderDomainError {
  status: number;
  code: string;
  message: string;
}

export function err(status: number, code: string, message: string): OrderDomainError {
  return { status, code, message };
}

// Ticket/order numbering resets daily (business_date = the venue's local
// "today") unless ticket_number_reset is 'never', in which case a single
// perpetual row at business_date '1970-01-01' is used for the venue's whole
// lifetime — see ticketNumbering.ts.
export function computeBusinessDate(timezone: string, resetMode: string): Date {
  if (resetMode !== 'daily') return new Date('1970-01-01T00:00:00.000Z');
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export async function getVenueAndSettings(venueId: string): Promise<{ venue: Venue; settings: RestaurantSettings }> {
  const [venue, settings] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId } }),
    prisma.restaurantSettings.findUnique({ where: { venueId } }),
  ]);
  if (!venue || !settings) throw new Error(`venue or settings missing for ${venueId}`);
  return { venue, settings };
}
