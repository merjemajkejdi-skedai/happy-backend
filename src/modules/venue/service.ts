import { prisma } from '../../db/prisma';
import type { Venue, Prisma } from '../../generated/prisma/client';

export interface VenuePatchInput {
  name?: string;
  timezone?: string;
  currency?: string;
  locale?: string;
  address?: string | null;
  phone?: string | null;
  isActive?: boolean;
}

export async function getVenue(venueId: string): Promise<Venue | null> {
  return prisma.venue.findUnique({ where: { id: venueId } });
}

// venue_type is deliberately excluded — not editable after creation. Every
// other field on VenuePatchInput is explicitly whitelisted here rather than
// spreading the request body, so an extra/unexpected key never reaches Prisma.
export async function updateVenue(venueId: string, input: VenuePatchInput): Promise<Venue> {
  const data: Prisma.VenueUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.timezone !== undefined) data.timezone = input.timezone;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.locale !== undefined) data.locale = input.locale;
  if (input.address !== undefined) data.address = input.address;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  return prisma.venue.update({ where: { id: venueId }, data });
}
